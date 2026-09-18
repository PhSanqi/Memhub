import type { MemoryRow } from "../../types.js";
import { projectIdFromMemory } from "../namespace/namespace-scope.js";

/**
 * Enforce project visibility after candidate retrieval.
 *
 * Global memories (no project owner) are visible both with and without a
 * resolved project. Project-owned memories are visible only when that exact
 * project is resolved. This means an unbound/ambiguous request can never
 * broaden into cross-project recall.
 */
export function memoryMatchesProjectRecallScope(
  memory: MemoryRow,
  resolvedProjectId: string | undefined
): boolean {
  const memoryProjectId = projectIdFromMemory(memory);
  if (memoryProjectId === undefined) return true;
  return resolvedProjectId !== undefined && memoryProjectId === resolvedProjectId;
}

export function filterMemoriesForProjectRecallScope(
  memories: readonly MemoryRow[],
  resolvedProjectId: string | undefined
): MemoryRow[] {
  return memories.filter((memory) => memoryMatchesProjectRecallScope(memory, resolvedProjectId));
}
