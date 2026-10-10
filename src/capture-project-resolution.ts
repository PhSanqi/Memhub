import type { StoredCaptureEvent } from "./capture.js";

export interface CaptureProjectResolution {
  projectId: string | null;
  source: "project_hint" | "workspace_path" | "none";
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

export async function resolveCaptureProject(
  event: Pick<StoredCaptureEvent, "project_hint" | "workspace_path">,
  resolveProject: (projectHint: string) => Promise<string | null>
): Promise<CaptureProjectResolution> {
  const explicit = event.project_hint?.trim();
  if (explicit) {
    return {
      projectId: await resolveProject(explicit),
      source: "project_hint",
      candidate: explicit
    };
  }

  const workspaceCandidate = canonicalWorkspaceProjectCandidate(event.workspace_path);
  if (!workspaceCandidate) return { projectId: null, source: "none", candidate: null };
  const projectId = await resolveProject(workspaceCandidate);
  return projectId
    ? { projectId, source: "workspace_path", candidate: workspaceCandidate }
    : { projectId: null, source: "none", candidate: null };
}
