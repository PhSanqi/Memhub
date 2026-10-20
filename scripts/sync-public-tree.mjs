#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { lstat, readFile, mkdir, writeFile, chmod, unlink } from 'node:fs/promises';
import { dirname, resolve, matchesGlob } from 'node:path';
import { fileURLToPath } from 'node:url';

// Private runtime material must never enter the public repository; CLI excludes extend this list.
export const PRIVATE_EXCLUSIONS = Object.freeze([
  'docs/reviews/**', 'docs/internal/**', 'docs/research/**', 'distribution/agensi/**',
  'AGENTS.md', 'CLAUDE.md', '.claude/**', 'tests/agensi-skill-package-e2e.mjs',
]);
export const PUBLISH_ONLY_KEEP = Object.freeze(['tests/public-repository-privacy-e2e.mjs']);
// Public copies carry deliberate sanitization (hosted domains replaced by placeholders/GitHub Pages).
// They are never overwritten or deleted; changed runtime versions are listed for a reviewed manual merge.
export const PUBLISH_OWNED = Object.freeze([
  'README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'docs/README.md', 'docs/operations/README.md',
  'docs/operations/cloudflare-tunnel.md',
]);
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (root, args) => execFileSync('git', ['-C', root, ...args], { maxBuffer: 256 * 1024 * 1024 });
const paths = (buffer) => buffer.toString('utf8').split('\0').filter(Boolean);
const matches = (path, globs) => globs.some((glob) => matchesGlob(path, glob));
async function stat(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function syncPublicTree({ ref, target, dryRun = false, exclude = [], keep = [], sourceRoot = runtimeRoot }) {
  if (!ref || !target) throw new Error('Usage: node scripts/sync-public-tree.mjs --ref <commit-ish> --target <publish dir> [--dry-run] [--json] [--exclude <glob>] [--keep <glob>]');
  sourceRoot = resolve(sourceRoot);
  target = resolve(target);
  if (sourceRoot === target) throw new Error('Source and target must be different repositories');
  const exclusions = [...PRIVATE_EXCLUSIONS, ...exclude];
  const tracked = new Set(paths(git(target, ['ls-files', '-z'])));
  const privatePaths = [...tracked].filter((path) => matches(path, exclusions));
  if (privatePaths.length) throw new Error('Private paths tracked in target:\n' + privatePaths.join('\n'));
  const source = new Map();
  const skipped = new Set();
  const warnings = [];
  const owned = [];
  for (const entry of paths(git(sourceRoot, ['ls-tree', '-rz', '--full-tree', ref]))) {
    const tab = entry.indexOf('\t');
    const [mode, type, sha] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    if (matches(path, exclusions)) continue;
    if (matches(path, PUBLISH_OWNED)) { owned.push(path); continue; }
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) {
      skipped.add(path);
      warnings.push('Skipped symlink/submodule: ' + path);
      continue;
    }
    if (path.split('/').some((part) => part === '..' || part.toLowerCase() === '.git')) throw new Error('Unsafe source path: ' + path);
    source.set(path, { mode, sha });
  }
  const result = { ref, target, dryRun, counts: {}, added: [], updated: [], deleted: [], unchanged: [], publishOwned: owned, warnings };
  const content = new Map();
  for (const [path, {mode, sha}] of source) {
    let parent = dirname(resolve(target, path));
    while (parent !== target) {
      const info = await stat(parent);
      if (info && !info.isDirectory()) throw new Error('Unsafe target parent: ' + parent);
      parent = dirname(parent);
    }
    const destination = resolve(target, path);
    const info = await stat(destination);
    if (info && !tracked.has(path)) throw new Error('Refusing to overwrite untracked/ignored target: ' + path);
    if (info && !info.isFile()) throw new Error('Refusing non-regular target: ' + path);
    const bytes = git(sourceRoot, ['cat-file', 'blob', sha]);
    content.set(path, bytes);
    const sameMode = process.platform === 'win32' || Boolean(info?.mode & 0o111) === (mode === '100755');
    const same = info && sameMode && bytes.equals(await readFile(destination));
    result[same ? 'unchanged' : tracked.has(path) ? 'updated' : 'added'].push(path);
  }
  result.deleted = [...tracked].filter((path) => !source.has(path) && !skipped.has(path) && !matches(path, [...PUBLISH_ONLY_KEEP, ...PUBLISH_OWNED, ...keep]));
  const affected = new Set([...result.added, ...result.updated, ...result.deleted]);
  const dirty = new Set();
  const status = paths(git(target, ['status', '--porcelain=v1', '-z', '--untracked-files=no']));
  for (let i = 0; i < status.length; i++) {
    const entry = status[i];
    dirty.add(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) dirty.add(status[++i]);
  }
  const conflicts = [...dirty].filter((path) => affected.has(path));
  if (conflicts.length && !dryRun) throw new Error('Uncommitted target changes would be overwritten/deleted:\n' + conflicts.join('\n'));
  if (conflicts.length) warnings.push('Dirty target paths (dry-run only): ' + conflicts.join(', '));
  for (const path of result.deleted) {
    let parent = dirname(resolve(target, path));
    while (parent !== target) {
      const info = await stat(parent);
      if (info && !info.isDirectory()) throw new Error('Unsafe target parent: ' + parent);
      parent = dirname(parent);
    }
    const info = await stat(resolve(target, path));
    if (info?.isDirectory()) throw new Error('Refusing to delete target directory: ' + path);
  }
  for (const kind of ['added', 'updated', 'deleted', 'unchanged']) result.counts[kind] = result[kind].length;
  if (!dryRun) {
    for (const path of result.deleted) if (await stat(resolve(target, path))) await unlink(resolve(target, path));
    for (const path of [...result.added, ...result.updated]) {
      const destination = resolve(target, path);
      await mkdir(dirname(destination), {recursive: true});
      await writeFile(destination, content.get(path));
      await chmod(destination, source.get(path).mode === '100755' ? 0o755 : 0o644);
    }
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = { exclude: [], keep: [] };
  try {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      const flag = args[i];
      if (flag === '--dry-run') options.dryRun = true;
      else if (flag === '--json') options.json = true;
      else if (['--ref', '--target', '--exclude', '--keep'].includes(flag)) {
        const value = args[++i];
        if (!value || value.startsWith('--')) throw new Error('Missing value for ' + flag);
        const key = flag.slice(2);
        if (key === 'exclude' || key === 'keep') options[key].push(value);
        else options[key] = value;
      } else throw new Error('Unknown argument: ' + flag);
    }
    const result = await syncPublicTree(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(JSON.stringify(result.counts));
      for (const kind of ['added', 'updated', 'deleted', 'unchanged']) for (const path of result[kind]) console.log(kind + ': ' + path);
    }
    for (const warning of result.warnings) console.error('Warning: ' + warning);
  } catch (error) {
    console.error(options.json ? JSON.stringify({error: error.message}) : error.message);
    process.exitCode = 1;
  }
}
