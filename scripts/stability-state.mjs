import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Keep this in sync with core-migration.mjs's database precedence. The
// Memhub control-plane state root is not the Memory Core database root.
export function detectCoreDatabase(home = homedir()) {
  const candidates = [
    join(home, ".memmy", "memory-service", "memory.sqlite"),
    join(home, ".memhub", "core", "memory.sqlite")
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}
