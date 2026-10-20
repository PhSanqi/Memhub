import { MemoryDb } from '../vendor/memory-core/src/storage/db.js';
import { Repositories } from '../vendor/memory-core/src/storage/repositories.js';

const at = '2026-10-18T00:00:00.000Z';
const path = process.argv[2];
const db = new MemoryDb({ path });
const repos = new Repositories(db.db);
db.db.exec('DROP TABLE memories_fts');
repos.memories.insert({
  id: 'crash-row', timeline: at, userId: 'mc', memoryType: 'fact', status: 'activated',
  visibility: 'private', memoryValue: 'crash hardened content', memoryLayer: 'L3',
  tags: ['mc'], info: {}, properties: { internal_info: {} }, version: 1,
  createdAt: at, updatedAt: at
});
// Simulate a crash immediately after the dirty flag committed and before any rebuild.
process.kill(process.pid, 'SIGKILL');
