export const MEMMY_SKILL_DIRECTORY_NAME = "memmy-memory";
export function renderMemmySkillDirectoryFiles(manifest) {
    return [
        {
            relativePath: "SKILL.md",
            content: [
                "---",
                "name: memmy-memory",
                "description: Use shared Memmy memory when prior context may be relevant.",
                "---",
                "",
                manifest.content.trimEnd(),
                ""
            ].join("\n")
        }
    ];
}
export function renderMemmySkillBootstrapManifest(manifest) {
    return {
        ...manifest,
        content: [
            "# Memmy Memory",
            "",
            "The `memmy-memory` skill is installed at `skills/memmy-memory/SKILL.md`.",
            "Use that skill when prior memory may be relevant to the current request."
        ].join("\n")
    };
}
