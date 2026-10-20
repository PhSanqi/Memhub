import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { MemoryDb } from '../vendor/memory-core/src/storage/db.js';
import { Repositories } from '../vendor/memory-core/src/storage/repositories.js';
import { MemoryService } from '../vendor/memory-core/src/service/memory-service.js';
import { legacyMigrationChecksum, migrationChecksum, SCHEMA_VERSION } from '../vendor/memory-core/src/storage/schema.js';

const scratch = '/tmp/p4-mc';
const at = '2026-10-18T00:00:00.000Z';
const freeSpace = () => Number.MAX_SAFE_INTEGER;

function memory(id, body = 'original searchable content') {
  return { id, timeline: at, userId: 'mc', memoryType: 'fact', status: 'activated', visibility: 'private',
    memoryValue: body, memoryLayer: 'L3', tags: ['mc'], info: {}, properties: { internal_info: {} },
    version: 1, createdAt: at, updatedAt: at };
}

async function tempDir() {
  await mkdir(scratch, { recursive: true });
  return mkdtemp(join(scratch, 'case-'));
}

async function createV8Database(dir) {
  const path = join(dir, 'memory.sqlite');
  const db = new MemoryDb({ path });
  db.db.prepare(`INSERT INTO memories (
    id, timeline, user_id, memory_value, tags_json, info_json, properties_json, memory_layer, created_at, updated_at
  ) VALUES (?, ?, ?, ?, '[]', '{}', '{}', 'L3', ?, ?)`).run('legacy-row', '2026-10-18', 'mc', 'legacy content', at, at);
  db.db.exec('DROP TABLE fts_repair_state');
  db.db.prepare(`UPDATE schema_migrations
    SET id = '008_memory_layers_v2', version = 8, checksum = 'legacy-length'
    WHERE version = ?`).run(SCHEMA_VERSION);
  db.close();
  return path;
}

function rawDirty(path) {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare('SELECT dirty FROM fts_repair_state WHERE id = 1').get().dirty;
  } finally {
    db.close();
  }
}

function backups(dir) {
  return readdir(dir).then((names) => names.filter((name) => name.endsWith('.bak')));
}

const memoryDbSourceUrl = new URL('../vendor/memory-core/src/storage/db.js', import.meta.url).href;
const concurrentOpenScript = `
import { MemoryDb } from ${JSON.stringify(memoryDbSourceUrl)};
const db = new MemoryDb({ path: process.env.MEMHUB_TEST_DB });
db.db.prepare('SELECT COUNT(*) AS count FROM memories').get();
db.close();
`;

function openDatabaseConcurrently(path, count) {
  return Promise.all(Array.from({ length: count }, () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', concurrentOpenScript], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, MEMHUB_TEST_DB: path },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => resolve({ code: -1, signal: null, stderr: String(error) }));
    child.once('exit', (code, signal) => resolve({ code, signal, stderr }));
  })));
}

function assertSingleMigrationRow(path) {
  const check = new Database(path, { readonly: true });
  try {
    const rows = check.prepare('SELECT version FROM schema_migrations WHERE version = ?').all(SCHEMA_VERSION);
    assert.equal(rows.length, 1, 'schema_migrations must hold exactly one row at SCHEMA_VERSION');
    assert.equal(check.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, SCHEMA_VERSION);
    assert.equal(check.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    check.close();
  }
}

test('MC-10 legacy length checksum is accepted once and rewritten to sha256', async () => {
  const dir = await tempDir();
  const path = join(dir, 'memory.sqlite');
  new MemoryDb({ path }).close();
  const raw = new Database(path);
  raw.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = ?').run(legacyMigrationChecksum(), SCHEMA_VERSION);
  raw.close();

  const upgraded = new MemoryDb({ path });
  try {
    const row = upgraded.db.prepare('SELECT checksum FROM schema_migrations WHERE version = ?').get(SCHEMA_VERSION);
    assert.equal(row.checksum, migrationChecksum());
    assert.match(row.checksum, /^sha256:[0-9a-f]{64}$/);
  } finally {
    upgraded.close();
  }
});

test('MC-10 tampered same-length checksum fails closed and leaves the database unchanged', async () => {
  const dir = await tempDir();
  const path = join(dir, 'memory.sqlite');
  new MemoryDb({ path }).close();
  const tampered = `sha256:${'0'.repeat(64)}`;
  assert.notEqual(tampered, migrationChecksum());
  assert.equal(tampered.length, migrationChecksum().length);
  const raw = new Database(path);
  raw.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = ?').run(tampered, SCHEMA_VERSION);
  raw.close();

  assert.throws(() => new MemoryDb({ path }), /migration checksum mismatch/);
  const check = new Database(path);
  try {
    assert.equal(check.prepare('SELECT checksum FROM schema_migrations WHERE version = ?').get(SCHEMA_VERSION).checksum, tampered);
    assert.equal(check.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    check.close();
  }
});

test('MC-10 low free space refuses the migration with a clear error and writes no backup', async () => {
  const dir = await tempDir();
  const path = await createV8Database(dir);
  assert.throws(() => new MemoryDb({ path, freeSpaceProbe: () => 0 }), /Insufficient free space for pre-migration backup/);
  const check = new Database(path);
  try {
    assert.equal(check.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 8);
  } finally {
    check.close();
  }
  assert.deepEqual(await backups(dir), []);
});

test('MC-10 backup is verified, atomically published and the schema upgrades', async () => {
  const dir = await tempDir();
  const path = await createV8Database(dir);
  new MemoryDb({ path, freeSpaceProbe: freeSpace }).close();

  const names = (await backups(dir)).filter((name) => name.startsWith('memory.sqlite.pre-v9.'));
  assert.equal(names.length, 1);
  assert.match(names[0], /^memory\.sqlite\.pre-v9\.\d+-[0-9a-f]{8}\.bak$/);
  assert.equal(existsSync(join(dir, names[0])), true);
  assert.equal((await readdir(dir)).some((name) => name.endsWith('.tmp')), false, 'temporary backup must be renamed away');

  const backup = new Database(join(dir, names[0]), { readonly: true, fileMustExist: true });
  try {
    assert.equal(backup.pragma('integrity_check', { simple: true }), 'ok');
    assert.ok(backup.pragma('page_count', { simple: true }) > 0);
    assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM memories').get().count, 1);
  } finally {
    backup.close();
  }

  const upgraded = new MemoryDb({ path, freeSpaceProbe: freeSpace });
  try {
    const row = upgraded.db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(SCHEMA_VERSION);
    assert.equal(row.version, SCHEMA_VERSION);
    assert.equal(rawDirty(path), 1, 'existing rows are marked for the startup rebuild');
  } finally {
    upgraded.close();
  }
});

test('MC-10 an existing same-named backup does not skip the backup, and only three are kept', async () => {
  const dir = await tempDir();
  const path = await createV8Database(dir);
  await writeFile(`${path}.pre-v9.bak`, 'old backup');
  for (let index = 0; index < 4; index += 1) {
    await writeFile(join(dir, `memory.sqlite.pre-v9.${index}-aaaaaaaa.bak`), `old-${index}`);
  }

  new MemoryDb({ path, freeSpaceProbe: freeSpace }).close();

  const names = await backups(dir);
  assert.equal(names.length, 3, `expected three retained backups, got ${names.join(', ')}`);
  const unique = names.filter((name) => !name.startsWith('memory.sqlite.pre-v9.bak') && !/-aaaaaaaa\.bak$/.test(name));
  assert.equal(unique.length, 1, 'a fresh unique backup must be published despite the old same-named file');
});

test('MC-10/durable FTS: a failed write persists dirty, restart rebuilds every layer and clears it', async () => {
  const dir = await tempDir();
  const path = join(dir, 'memory.sqlite');
  const first = new MemoryDb({ path });
  const repos = new Repositories(first.db);
  repos.memories.insert(memory('kept'));
  first.db.exec('DROP TABLE memories_fts');
  repos.memories.insert(memory('needs-repair', 'repair me'));
  assert.equal(repos.memories.ftsRepairOverflow, true);
  assert.equal(rawDirty(path), 1);
  assert.equal(first.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE id = 'needs-repair'").get().count, 1);
  first.close();

  const reopened = new MemoryDb({ path });
  try {
    assert.equal(rawDirty(path), 1, 'dirty survives a restart before repair');
    const repaired = new Repositories(reopened.db);
    assert.equal(rawDirty(path), 0);
    assert.equal(reopened.db.prepare('SELECT COUNT(*) AS count FROM memories_fts').get().count, 2);
    assert.equal(repaired.memories.searchFtsIds('"repair"', {}, 5).length, 1);
    const service = new MemoryService({ db: reopened });
    assert.equal(service.health().storage.ftsRepair.fullReindexRequired, false);
  } finally {
    reopened.close();
  }
});

test('MC-10/durable FTS: an unpersistable dirty flag aborts the row/vector transaction', () => {
  const db = new MemoryDb({ path: ':memory:' });
  const repos = new Repositories(db.db);
  try {
    db.db.exec('DROP TABLE memories_fts');
    db.db.exec('DROP TABLE fts_repair_state');
    assert.throws(() => repos.memories.insert(memory('lost')), /Failed to persist FTS repair state/);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM memories').get().count, 0);
  } finally {
    db.close();
  }
});

test('MC-10/durable FTS: the health flag follows the durable state before repair', async () => {
  const dir = await tempDir();
  const path = join(dir, 'memory.sqlite');
  const db = new MemoryDb({ path });
  const service = new MemoryService({ db });
  service.repos.memories.markFtsDirty('test');
  try {
    assert.equal(service.health().storage.ftsRepair.fullReindexRequired, true);
  } finally {
    db.close();
  }
});

test('MC-10/durable FTS: a crash between dirty and rebuild keeps the flag for the next start', { skip: process.platform === 'win32' }, async () => {
  const dir = await tempDir();
  const path = join(dir, 'memory.sqlite');
  new MemoryDb({ path }).close();

  const child = spawn(process.execPath, ['tests/_p4-mc-fts-crash-child.mjs', path], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'ignore'
  });
  const result = await new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  assert.equal(result.signal, 'SIGKILL');

  assert.equal(rawDirty(path), 1, 'a crash after the dirty commit must not clear the flag');
  const crashed = new Database(path, { readonly: true });
  try {
    assert.equal(crashed.prepare("SELECT COUNT(*) AS count FROM memories WHERE id = 'crash-row'").get().count, 1);
  } finally {
    crashed.close();
  }

  const reopened = new MemoryDb({ path });
  try {
    new Repositories(reopened.db);
    assert.equal(rawDirty(path), 0);
    assert.equal(reopened.db.prepare("SELECT COUNT(*) AS count FROM memories_fts WHERE id = 'crash-row'").get().count, 1);
  } finally {
    reopened.close();
  }
});

test('MC-16 concurrent openers of the same fresh database all succeed and migrate exactly once', async () => {
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const dir = await tempDir();
    const path = join(dir, 'memory.sqlite');
    const results = await openDatabaseConcurrently(path, 4);
    for (const result of results) {
      assert.equal(result.code, 0, `iteration ${iteration} failed: ${result.stderr}`);
    }
    assertSingleMigrationRow(path);
  }
});

test('MC-16 concurrent openers of a pre-v9 database upgrade exactly once', async () => {
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const dir = await tempDir();
    const path = await createV8Database(dir);
    const results = await openDatabaseConcurrently(path, 4);
    for (const result of results) {
      assert.equal(result.code, 0, `iteration ${iteration} failed: ${result.stderr}`);
    }
    assertSingleMigrationRow(path);
  }
});
