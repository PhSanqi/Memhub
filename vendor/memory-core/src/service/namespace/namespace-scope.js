import { DEFAULT_NAMESPACE_SOURCE } from "../../types.js";
import { resolveWorkspaceIdentity } from "./workspace-identity.js";
export function normalizeNamespace(namespace) {
    return {
        source: namespace?.source ?? DEFAULT_NAMESPACE_SOURCE,
        profileId: namespace?.profileId ?? "default",
        profileLabel: namespace?.profileLabel,
        projectId: namespace?.projectId,
        workspaceId: namespace?.workspaceId,
        workspacePath: namespace?.workspacePath,
        sessionKey: namespace?.sessionKey,
        userId: namespace?.userId ?? "local-user",
        tenantId: namespace?.tenantId
    };
}
export function sessionScopeForOpenRequest(request, namespace) {
    return {
        source: request.source ?? request.namespace?.source,
        profileId: request.profileId ?? request.namespace?.profileId,
        projectId: request.projectId ?? request.namespace?.projectId ?? request.namespace?.workspaceId,
        workspaceId: request.workspaceId ?? request.namespace?.workspaceId,
        workspacePath: request.workspacePath ?? request.namespace?.workspacePath ?? namespace.workspacePath
    };
}
export function resolveV2WorkspaceIdentityForOpenRequest(request, namespace) {
    return resolveWorkspaceIdentity(namespace.userId, {
        workspaceUri: request.workspaceUri,
        workspaceHostId: request.workspaceHostId
    });
}
export function namespaceForSession(session) {
    return { source: session.source, profileId: session.profileId, profileLabel: session.profileLabel, projectId: session.projectId, workspaceId: session.workspaceId, workspacePath: session.workspacePath, sessionKey: session.hostSessionKey, userId: session.userId };
}
export function namespaceForMemory(memory) {
    return { source: memory.agentId ?? DEFAULT_NAMESPACE_SOURCE, profileId: profileIdFromMemory(memory) ?? "default", projectId: projectIdFromMemory(memory), workspaceId: memory.appId, userId: memory.userId };
}
export function projectIdFromMemory(memory) {
    const direct = memory.info.project_id;
    if (typeof direct === "string" && direct.trim())
        return direct.trim();
    const camel = memory.info.projectId;
    if (typeof camel === "string" && camel.trim())
        return camel.trim();
    const nested = memory.properties.info?.project_id ?? memory.properties.info?.projectId;
    return typeof nested === "string" && nested.trim() ? nested.trim() : undefined;
}
export function sameProjectScope(left, right) {
    return normalizeOptionalScope(left) === normalizeOptionalScope(right);
}
function normalizeOptionalScope(value) {
    if (typeof value !== "string")
        return null;
    const normalized = value.trim();
    return normalized || null;
}
export function profileIdFromMemory(memory) {
    const direct = memory.info.profile_id;
    if (typeof direct === "string" && direct.trim())
        return direct.trim();
    const nested = memory.properties.info?.profile_id;
    return typeof nested === "string" && nested.trim() ? nested.trim() : undefined;
}
export function namespaceForRawTurn(rawTurn) {
    return { source: DEFAULT_NAMESPACE_SOURCE, profileId: "default", sessionKey: rawTurn.sessionId, userId: rawTurn.userId };
}
