import { resolvePiAgentDirectory } from "../../agent-paths.js";
import { createSkillOnlyTarget } from "../skill-only-target.js";
export function createPiSkillTarget(deps = {}) {
    return createSkillOnlyTarget({
        targetId: "pi",
        displayName: "Pi",
        rootDirectory: deps.rootDirectory ?? resolvePiAgentDirectory()
    });
}
