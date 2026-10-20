// Single source of truth for the Memhub state roots.
//
// Plain ESM on purpose: `src/*.ts` and `scripts/*.mjs` both import this module
// (scripts through the build output, or directly from `src/` when no build is
// available). It must stay dependency-free beyond Node builtins.
//
// There are two distinct roots:
//
// `home` — the install/stack home used by run-stack, installers, core paths
// and uninstall. Precedence:
//   explicit --home > MEMHUB_HOME > existing ~/.memmy/memhub
//   > legacy ~/.memhub with real state > default ~/.memmy/memhub
//
// `controlRoot` — the gateway control directory (accounts, project registry,
// distillation) used by the gateway, CLI admin, stability, hygiene and repair
// code. Precedence:
//   explicit --state-root > MEMHUB_STATE_ROOT
//   > <home>/server when that directory holds accounts.json > <home>
//
// The two names are not aliases: edition installs legitimately use
// MEMHUB_HOME=<home> and MEMHUB_STATE_ROOT=<home>/server at the same time.
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_DIRS = [".memmy", "memhub"];
const LEGACY_DIR = ".memhub";
const LEGACY_MARKERS = ["memhub.env", "accounts.json"];
const warnedLegacyRoots = new Set();

/**
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
function nonEmpty(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * @param {string} platform
 * @returns {typeof posix | typeof win32}
 */
function pathModule(platform) {
  return platform === "win32" ? win32 : posix;
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} platform
 * @returns {string}
 */
function homeDirectory(env, platform) {
  const selected = platform === "win32" ? nonEmpty(env.USERPROFILE) : nonEmpty(env.HOME);
  return selected ?? homedir();
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {string} legacyRoot
 * @param {typeof posix | typeof win32} paths
 * @returns {boolean}
 */
function hasLegacyState(legacyRoot, paths) {
  return LEGACY_MARKERS.some((name) => existsSync(paths.join(legacyRoot, name)));
}

/**
 * @typedef {{
 *   explicit?: string,
 *   home?: string,
 *   stateRoot?: string,
 *   controlRoot?: string,
 *   env?: Record<string, string | undefined>,
 *   platform?: string,
 *   homeDir?: string,
 *   warn?: (message: string) => void
 * }} ResolveOptions
 */

/**
 * Resolve the Memhub install/stack home. `MEMHUB_STATE_ROOT` is deliberately
 * ignored: it names the gateway control root, not the install home.
 *
 * @param {ResolveOptions} [options]
 * @returns {string}
 */
export function resolveHome(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const paths = pathModule(platform);
  const homeDir = paths.resolve(options.homeDir ?? homeDirectory(env, platform));

  const explicit = nonEmpty(options.explicit) ?? nonEmpty(options.home);
  if (explicit) return paths.resolve(explicit);

  const fromHome = nonEmpty(env.MEMHUB_HOME);
  if (fromHome) return paths.resolve(fromHome);

  const preferred = paths.join(homeDir, ...DEFAULT_DIRS);
  const legacy = paths.join(homeDir, LEGACY_DIR);
  // An existing but empty preferred dir must not shadow a legacy root that holds data.
  if (hasLegacyState(preferred, paths)) return preferred;
  if (isDirectory(preferred) && !hasLegacyState(legacy, paths)) return preferred;

  if (hasLegacyState(legacy, paths)) {
    if (!warnedLegacyRoots.has(legacy)) {
      warnedLegacyRoots.add(legacy);
      const warn = options.warn ?? ((message) => console.error(message));
      warn(
        `[memhub] Legacy state root ${legacy} contains Memhub data; using it in place. ` +
        `Memhub will not move or copy it (unified default: ${preferred}).`
      );
    }
    return legacy;
  }
  return preferred;
}

/**
 * Resolve the gateway control root.
 *
 * @param {ResolveOptions} [options]
 * @returns {string}
 */
export function resolveControlRoot(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const paths = pathModule(platform);

  const explicit = nonEmpty(options.explicit) ?? nonEmpty(options.stateRoot) ?? nonEmpty(options.controlRoot);
  if (explicit) return paths.resolve(explicit);

  const fromState = nonEmpty(env.MEMHUB_STATE_ROOT);
  if (fromState) return paths.resolve(fromState);

  const home = resolveHome(options);
  const legacyControl = paths.join(home, "server");
  return existsSync(paths.join(legacyControl, "accounts.json")) ? legacyControl : home;
}

/**
 * Resolve Memory Core config/database defaults for the install home.
 *
 * The canonical location is `<home>/core`. Existing files win over the default
 * so legacy installs are adopted in place; nothing is ever moved or copied.
 *
 * @param {ResolveOptions} [options]
 * @returns {{
 *   stateRoot: string,
 *   coreDir: string,
 *   configPath: string,
 *   dbPath: string,
 *   legacyCoreConfigPath: string,
 *   legacyCoreDbPath: string,
 *   memmyConfigPath: string,
 *   memmyDbPath: string
 * }}
 */
export function resolveCoreState(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const paths = pathModule(platform);
  const homeDir = paths.resolve(options.homeDir ?? homeDirectory(env, platform));
  const stateRoot = resolveHome(options);
  const coreDir = paths.join(stateRoot, "core");
  const legacyCoreDir = paths.join(homeDir, LEGACY_DIR, "core");
  const memmyConfigPath = paths.join(homeDir, ".memmy", "config.yaml");
  const memmyDbPath = paths.join(homeDir, ".memmy", "memory-service", "memory.sqlite");
  const canonicalConfig = paths.join(coreDir, "config.yaml");
  const canonicalDb = paths.join(coreDir, "memory.sqlite");
  const legacyCoreConfigPath = paths.join(legacyCoreDir, "config.yaml");
  const legacyCoreDbPath = paths.join(legacyCoreDir, "memory.sqlite");

  // Existing unified state wins; then the oldest Memmy install (matching
  // core-migration's source preference); then the legacy ~/.memhub/core path.
  const configPath = [canonicalConfig, memmyConfigPath, legacyCoreConfigPath]
    .find((candidate) => existsSync(candidate)) ?? canonicalConfig;
  const dbPath = [canonicalDb, memmyDbPath, legacyCoreDbPath]
    .find((candidate) => existsSync(candidate)) ?? canonicalDb;

  return {
    stateRoot,
    coreDir,
    configPath,
    dbPath,
    legacyCoreConfigPath,
    legacyCoreDbPath,
    memmyConfigPath,
    memmyDbPath
  };
}

// Allow shell installers to resolve the same roots without duplicating the
// rules: `node src/state-root.mjs [--home|--control-root|--core-db|--core-config]`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const flags = new Set(process.argv.slice(2));
    const output = flags.has("--control-root")
      ? resolveControlRoot()
      : flags.has("--core-db")
        ? resolveCoreState().dbPath
        : flags.has("--core-config")
          ? resolveCoreState().configPath
          : resolveHome();
    process.stdout.write(`${output}\n`);
  } catch (error) {
    process.stderr.write(`[memhub] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
