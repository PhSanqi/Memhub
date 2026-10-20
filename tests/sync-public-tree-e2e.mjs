import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, lstat, symlink, chmod, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { syncPublicTree, PRIVATE_EXCLUSIONS } from '../scripts/sync-public-tree.mjs';

await mkdir(join(tmpdir(), 'agy-sync'), {recursive: true});
const sandbox = await mkdtemp(join(tmpdir(), 'agy-sync/fixture-'));
const git = (root, ...args) => execFileSync('git', ['-C', root, '-c', 'core.autocrlf=false', '-c', 'core.filemode=true', ...args], {encoding: 'utf8'}).trim();
async function put(root, path, body = 'fixture\n') {
  await mkdir(join(root, path, '..'), {recursive: true});
  await writeFile(join(root, path), body);
}
function commit(root) {
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Sync Test', '-c', 'user.email=sync@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
}
let passed = 0, failed = 0;
async function check(name, run) {
  try {
    const root = join(sandbox, String(passed + failed));
    const sourceRoot = join(root, 'runtime'), target = join(root, 'publish');
    for (const repo of [sourceRoot, target]) {
      await mkdir(repo, {recursive: true});
      git(repo, 'init', '-q');
      await put(repo, 'same.txt');
      commit(repo);
    }
    await run({sourceRoot, target, ref: 'HEAD'});
    passed++; console.log('PASS ' + name);
  } catch (error) {
    failed++; console.log('FAIL ' + name); console.error(error.stack);
  }
}
async function snapshot(root) {
  const files = {};
  async function visit(dir) {
    for (const entry of await readdir(join(root, dir), {withFileTypes: true})) {
      if (entry.name === '.git') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files[path] = {bytes: (await readFile(join(root, path))).toString('base64'), mode: (await lstat(join(root, path))).mode};
    }
  }
  await visit('');
  return files;
}
await check('private exclusions and custom globs', async (o) => {
  for (const path of ['docs/reviews/a.md', 'docs/internal/a.md', 'docs/research/a.md', 'distribution/agensi/a', 'AGENTS.md', 'CLAUDE.md', '.claude/a', 'tests/agensi-skill-package-e2e.mjs', 'secret/a.txt']) await put(o.sourceRoot, path);
  commit(o.sourceRoot);
  const result = await syncPublicTree({...o, exclude: ['secret/**']});
  assert.equal(PRIVATE_EXCLUSIONS.length, 8);
  assert.deepEqual(result.counts, {added: 0, updated: 0, deleted: 0, unchanged: 1});
  assert.deepEqual(Object.keys(await snapshot(o.target)), ['same.txt']);
});
await check('tracked private paths fail even in dry-run', async (o) => {
  await put(o.target, 'docs/internal/secret'); commit(o.target);
  for (const dryRun of [false, true]) await assert.rejects(syncPublicTree({...o, dryRun}), (error) => error.message.includes('Private paths tracked in target:') && error.message.includes('docs/internal/secret'));
  assert.equal(await readFile(join(o.target, 'same.txt'), 'utf8'), 'fixture\n');
});
await check('custom exclude rejects target tracking', async (o) => {
  await assert.rejects(syncPublicTree({...o, exclude: ['same.*']}), /Private paths tracked in target/);
});
await check('keep lists preserve only files without source counterpart', async (o) => {
  await put(o.target, 'tests/public-repository-privacy-e2e.mjs');
  await put(o.target, 'public/keep.txt'); await put(o.target, 'old.txt'); commit(o.target);
  await put(o.sourceRoot, 'same.txt', 'new\n'); commit(o.sourceRoot);
  const result = await syncPublicTree({...o, keep: ['public/**', 'same.txt']});
  assert.deepEqual(result.deleted, ['old.txt']);
  assert.deepEqual(result.updated, ['same.txt']);
  assert.equal(await readFile(join(o.target, 'public/keep.txt'), 'utf8'), 'fixture\n');
  await assert.rejects(readFile(join(o.target, 'old.txt')), {code: 'ENOENT'});
});
await check('binary bytes executable bit and Git ref isolation', async (o) => {
  const bytes = Buffer.from([0, 255, 13, 10, 128]);
  await put(o.sourceRoot, 'binary.dat', bytes); await put(o.sourceRoot, 'run.sh', '#!/bin/sh\n');
  await chmod(join(o.sourceRoot, 'run.sh'), 0o755); commit(o.sourceRoot);
  await put(o.sourceRoot, 'binary.dat', 'uncommitted');
  const result = await syncPublicTree(o);
  assert.equal(result.counts.added, 2);
  assert.deepEqual(await readFile(join(o.target, 'binary.dat')), bytes);
  if (process.platform !== 'win32') assert.ok((await lstat(join(o.target, 'run.sh'))).mode & 0o111);
  commit(o.target);
  assert.equal((await syncPublicTree(o)).counts.unchanged, 3);
});
await check('dirty updates and deletions refuse atomically', async (o) => {
  await put(o.sourceRoot, 'new.txt'); await put(o.sourceRoot, 'same.txt', 'source'); commit(o.sourceRoot);
  await put(o.target, 'old.txt'); commit(o.target);
  await put(o.target, 'same.txt', 'dirty'); await put(o.target, 'old.txt', 'dirty');
  const before = await snapshot(o.target);
  await assert.rejects(syncPublicTree(o), (error) => /Uncommitted/.test(error.message) && error.message.includes('same.txt') && error.message.includes('old.txt'));
  assert.deepEqual(await snapshot(o.target), before);
});
await check('staged changes refuse', async (o) => {
  await put(o.target, 'same.txt', 'staged'); git(o.target, 'add', 'same.txt');
  await assert.rejects(syncPublicTree(o), /Uncommitted.*\nsame.txt/);
});
await check('dry-run leaves dirty tracked untracked and ignored files unchanged', async (o) => {
  await put(o.sourceRoot, 'new.txt'); await put(o.sourceRoot, 'same.txt', 'source'); commit(o.sourceRoot);
  await put(o.target, '.gitignore', 'dist/\nnode_modules/\n'); await put(o.target, 'old.txt'); commit(o.target);
  await put(o.target, 'same.txt', 'dirty'); await put(o.target, 'dist/cache'); await put(o.target, 'node_modules/cache'); await put(o.target, 'untracked.txt');
  const before = await snapshot(o.target), status = git(o.target, 'status', '--porcelain');
  const result = await syncPublicTree({...o, dryRun: true});
  assert.deepEqual(result.counts, {added: 1, updated: 1, deleted: 2, unchanged: 0});
  assert.deepEqual(await snapshot(o.target), before);
  assert.equal(git(o.target, 'status', '--porcelain'), status);
});
await check('apply preserves untracked and ignored files', async (o) => {
  await put(o.target, '.gitignore', 'dist/\nnode_modules/\n'); commit(o.target);
  for (const path of ['dist/cache', 'node_modules/cache', 'untracked.txt']) await put(o.target, path, path);
  await syncPublicTree(o);
  for (const path of ['dist/cache', 'node_modules/cache', 'untracked.txt']) assert.equal(await readFile(join(o.target, path), 'utf8'), path);
});
await check('untracked collision refuses without overwrite', async (o) => {
  await put(o.sourceRoot, 'collision'); commit(o.sourceRoot); await put(o.target, 'collision', 'protected');
  await assert.rejects(syncPublicTree(o), (error) => error.message.includes('untracked/ignored target: collision'));
  assert.equal(await readFile(join(o.target, 'collision'), 'utf8'), 'protected');
});
await check('symlinks and gitlinks skipped with warnings', async (o) => {
  if (process.platform !== 'win32') await symlink('same.txt', join(o.sourceRoot, 'link'));
  const moduleRoot = join(o.sourceRoot, 'module');
  await mkdir(moduleRoot); git(moduleRoot, 'init', '-q');
  await put(moduleRoot, 'nested.txt'); commit(moduleRoot);
  git(o.sourceRoot, 'add', '-A');
  git(o.sourceRoot, '-c', 'user.name=Sync Test', '-c', 'user.email=sync@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'links');
  const result = await syncPublicTree(o);
  assert.equal(result.warnings.length, process.platform === 'win32' ? 1 : 2);
  assert.equal(result.counts.added, 0);
});
await check('CLI JSON and argument errors', async (o) => {
  const script = resolve('scripts/sync-public-tree.mjs');
  await put(o.sourceRoot, 'scripts/sync-public-tree.mjs', await readFile(script)); commit(o.sourceRoot);
  const cli = join(o.sourceRoot, 'scripts/sync-public-tree.mjs');
  const result = spawnSync(process.execPath, [cli, '--ref', 'HEAD', '--target', o.target, '--dry-run', '--json'], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).counts.added, 1);
  assert.notEqual(spawnSync(process.execPath, [cli, '--unknown'], {encoding:'utf8'}).status, 0);
  assert.notEqual(spawnSync(process.execPath, [cli, '--ref'], {encoding:'utf8'}).status, 0);
});
await check('mode-only updates preserve executable bit', async (o) => {
  if (process.platform === 'win32') return;
  await chmod(join(o.sourceRoot, 'same.txt'), 0o755); commit(o.sourceRoot);
  const result = await syncPublicTree(o);
  assert.deepEqual(result.updated, ['same.txt']);
  assert.ok((await lstat(join(o.target, 'same.txt'))).mode & 0o111);
});
await check('unrelated dirty kept files do not block updates', async (o) => {
  await put(o.target, 'public/keep.txt'); commit(o.target);
  await put(o.target, 'public/keep.txt', 'dirty but kept');
  await put(o.sourceRoot, 'same.txt', 'updated'); commit(o.sourceRoot);
  const result = await syncPublicTree({...o, keep: ['public/**']});
  assert.deepEqual(result.updated, ['same.txt']);
  assert.equal(await readFile(join(o.target, 'public/keep.txt'), 'utf8'), 'dirty but kept');
});
await check('target symlink parents refuse before writes', async (o) => {
  if (process.platform === 'win32') return;
  const outside = join(o.target, '..', 'outside'); await mkdir(outside);
  await put(o.sourceRoot, 'escape/file'); commit(o.sourceRoot);
  await symlink(outside, join(o.target, 'escape'));
  await assert.rejects(syncPublicTree(o), /Unsafe target parent/);
  assert.deepEqual(await readdir(outside), []);
});
console.log(JSON.stringify({passed, failed, total: passed + failed}));
process.exitCode = failed ? 1 : 0;
