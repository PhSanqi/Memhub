import type { StoredCaptureEvent } from "./capture.js";
import { scheduleCaptureProjectBackfill, withReadonlyCaptureIndex } from "./capture.js";
import { captureAssignmentSnapshot, type CaptureAssignmentSnapshot } from "./capture-project-assignments.js";
import type Database from "better-sqlite3";

export interface CaptureProjectResolution {
  projectId: string | null;
  source: "project_hint" | "assignment" | "continuity" | "keep_global" | "workspace_path" | "none";
  candidate: string | null;
}

/**
 * Only infer from a named workspace container boundary. Arbitrary folders,
 * repository basenames outside that boundary, and free-form text are not
 * strong enough evidence to assign an immutable ingested capture to a project.
 * Supported container names are `workspace`, `workspaces`, or names ending in
 * `-workspace` / `_workspace`; this preserves existing deployments without
 * hard-coding one host-specific directory name.
 */
export function canonicalWorkspaceProjectCandidate(workspacePath: string | undefined): string | undefined {
  const normalized = workspacePath?.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (!normalized) return undefined;
  const parts = normalized.split("/").filter(Boolean);
  const rootIndex = parts.findIndex((part) => /(^|[-_])workspaces?$/.test(part.toLowerCase()));
  if (rootIndex < 0 || rootIndex + 1 >= parts.length) return undefined;
  const candidate = parts[rootIndex + 1]?.trim();
  return candidate || undefined;
}

type ProjectEvent = Pick<StoredCaptureEvent, "project_hint" | "workspace_path"> & Partial<StoredCaptureEvent>;

export function resolveCaptureProjectSnapshot(
  event: ProjectEvent, resolveProject: (ref: string) => string | null, snapshot?: CaptureAssignmentSnapshot
): CaptureProjectResolution {
  const explicit = event.project_hint?.trim();
  const hinted = explicit ? resolveProject(explicit) : null;
  if (hinted) return { projectId: hinted, source: "project_hint", candidate: explicit! };
  const assignment = snapshot?.assignment;
  if (assignment && !snapshot.hints.some(hint => {
    const project = resolveProject(hint);
    return project && project !== assignment.project_id;
  })) return {
    projectId: assignment.project_id === null ? null : resolveProject(assignment.project_id),
    source: assignment.project_id === null ? "keep_global" : assignment.scope === "continuity" ? "continuity" : "assignment",
    candidate: explicit ?? assignment.project_id
  };
  const workspace = canonicalWorkspaceProjectCandidate(event.workspace_path);
  const projectId = workspace ? resolveProject(workspace) : null;
  return { projectId, source: projectId ? "workspace_path" : "none", candidate: explicit ?? (projectId ? workspace! : null) };
}

export async function resolveCaptureProject(
  event: ProjectEvent, resolveProject: (projectHint: string) => Promise<string | null>,
  stateRoot?: string, db?: Database.Database, snapshot?: CaptureAssignmentSnapshot | null
): Promise<CaptureProjectResolution> {
  if (stateRoot && event.account_id && !db && snapshot === undefined) scheduleCaptureProjectBackfill(stateRoot, event.account_id);
  const explicit = event.project_hint?.trim();
  if (explicit) {
    const projectId = await resolveProject(explicit);
    if (projectId) return { projectId, source: "project_hint", candidate: explicit };
  }
  if (stateRoot && event.account_id && snapshot === undefined) {
    if (event.event_id && event.timestamp) snapshot = (db
      ? captureAssignmentSnapshot(db, event as StoredCaptureEvent)
      : await withReadonlyCaptureIndex(stateRoot, event.account_id, reader => captureAssignmentSnapshot(reader, event as StoredCaptureEvent))) ?? null;
  }
  const refs = [canonicalWorkspaceProjectCandidate(event.workspace_path),
    snapshot?.assignment.project_id, ...(snapshot?.hints ?? [])];
  const resolved = new Map<string, string | null>();
  for (const ref of new Set(refs)) if (ref) resolved.set(ref, await resolveProject(ref));
  return resolveCaptureProjectSnapshot(event, ref => resolved.get(ref) ?? null, snapshot ?? undefined);
}
