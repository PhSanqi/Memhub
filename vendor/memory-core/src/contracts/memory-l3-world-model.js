/** Historical L3 World Model field shape retained only to read legacy v1/v2 records. */
import { z } from "zod";
export const L3WorldModelFieldsSchema = z.object({
    generalRulesAndSafetyConstraints: z.string().nullable(),
    projectEnvironmentProfile: z.string().nullable(),
    projectContract: z.string().nullable(),
    domainKnowledge: z.string().nullable()
}).strict();
/** Renders historical owner fields for legacy record display/migration only. */
export function renderL3WorldModelFields(fields) {
    const parsed = L3WorldModelFieldsSchema.parse(fields);
    return [
        renderSection("通用规则与安全约束", parsed.generalRulesAndSafetyConstraints),
        renderSection("项目环境画像", parsed.projectEnvironmentProfile),
        renderSection("项目契约", parsed.projectContract),
        renderSection("领域知识", parsed.domainKnowledge)
    ].filter(Boolean).join("\n\n");
}
function renderSection(title, body) {
    const normalized = body?.trim();
    return normalized ? `## ${title}\n${normalized}` : "";
}
