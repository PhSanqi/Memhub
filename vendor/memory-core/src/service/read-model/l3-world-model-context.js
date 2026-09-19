import { renderL3WorldModelFields } from "../../contracts/index.js";
import { nowIso } from "../../utils/time.js";
export class L3WorldModelContextReadModel {
    repos;
    constructor(repos) {
        this.repos = repos;
    }
    load(session) {
        const projectId = session.projectId ?? null;
        const memory = this.repos.l3WorldModels.getMemory(session.userId, projectId);
        if (!memory || memory.status !== "activated" || memory.deletedAt) {
            return emptyResponse(projectId);
        }
        const fields = this.repos.l3WorldModels.fields(session.userId, projectId);
        if (projectId && fields.projectEnvironmentProfile !== null && !this.environmentProfileIsApplied(session.userId, projectId, memory.info.project_environment_applied_scan_id)) {
            fields.projectEnvironmentProfile = null;
        }
        const sourceMemoryIds = sourceMemoryIdsFromL3(memory.properties.internal_info.source_memory_ids);
        return {
            schemaVersion: 2,
            projectId,
            memoryId: memory.id,
            memoryVersion: memory.version,
            renderedContext: renderL3WorldModelFields(fields),
            sourceMemoryIds,
            generalRulesAndSafetyConstraints: fields.generalRulesAndSafetyConstraints,
            projectEnvironmentProfile: fields.projectEnvironmentProfile,
            projectContract: fields.projectContract,
            domainKnowledge: fields.domainKnowledge,
            serverTime: nowIso()
        };
    }
    environmentProfileIsApplied(userId, projectId, memoryScanId) {
        if (typeof memoryScanId !== "string" || !memoryScanId)
            return false;
        const row = this.repos.db.prepare(`SELECT applied_scan_id
       FROM l3_world_model_project_environment_state
       WHERE user_id = ? AND project_id = ?`).get(userId, projectId);
        return row?.applied_scan_id === memoryScanId;
    }
}
function emptyResponse(projectId) {
    return {
        schemaVersion: 2,
        projectId,
        memoryId: null,
        memoryVersion: null,
        renderedContext: "",
        sourceMemoryIds: [],
        generalRulesAndSafetyConstraints: null,
        projectEnvironmentProfile: null,
        projectContract: null,
        domainKnowledge: null,
        serverTime: nowIso()
    };
}
function sourceMemoryIdsFromL3(value) {
    return Array.isArray(value)
        ? value.filter((item) => typeof item === "string" && Boolean(item))
        : [];
}
