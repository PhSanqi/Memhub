import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveCoreState } from "../dist/state-root.mjs";

// Keep this in sync with core-migration.mjs's database precedence. The
// Memhub control-plane state root is not the Memory Core database root.
export function detectCoreDatabase(home = homedir()) {
  const core = resolveCoreState({ homeDir: home });
  const candidates = [
    join(core.coreDir, "memory.sqlite"),
    core.memmyDbPath,
    core.legacyCoreDbPath
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}
