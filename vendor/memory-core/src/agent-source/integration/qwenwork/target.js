import { resolveQwenworkHomeDirectory } from "../../agent-paths.js";
import { createSkillOnlyTarget } from "../skill-only-target.js";
export function createQwenworkSkillTarget(deps = {}) {
    return createSkillOnlyTarget({
        targetId: "qwenwork",
        displayName: "QwenWork",
        rootDirectory: deps.rootDirectory ?? resolveQwenworkHomeDirectory()
    });
}
