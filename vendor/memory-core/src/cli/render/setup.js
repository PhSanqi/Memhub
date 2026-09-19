import { dirname } from "node:path";
import { createCliStyle } from "./ansi.js";
export function renderSetupResult(value, options = {}) {
    const result = parseSetupResult(value);
    if (!result)
        return undefined;
    const style = createCliStyle({ color: options.color });
    const lines = [renderTitle(result, style)];
    appendLine(lines, style, "Config file", result.configPath);
    appendLine(lines, style, "Database config", result.dbPath);
    appendLine(lines, style, "Endpoint", result.endpoint);
    appendAgentLines(lines, style, result.agents);
    if (result.command === "install") {
        const pathStatus = result.pathReady === true
            ? style.green("ready")
            : result.binPath
                ? style.yellow(`not in PATH; add ${dirname(result.binPath)}`)
                : undefined;
        appendLine(lines, style, "Binary", result.binPath);
        appendLine(lines, style, "Source", result.source);
        appendLine(lines, style, "PATH", pathStatus);
    }
    appendLine(lines, style, "Shell completion", "Skipped (disabled during init)");
    lines.push("");
    lines.push(`${style.bold("Try running:")} ${style.cyan("memmy-memory health")}`);
    return trimTrailingBlankLines(lines).join("\n");
}
function renderTitle(result, style) {
    const icon = result.dryRun ? style.yellow("!") : style.green("✓");
    if (result.dryRun) {
        return `${icon} ${style.bold(`${commandLabel(result.command)} preview generated`)}`;
    }
    return `${icon} ${style.bold(result.command === "install" ? "Installation completed successfully!" : "Configuration saved successfully!")}`;
}
function commandLabel(command) {
    return command === "install" ? "Installation" : "Configuration";
}
function appendAgentLines(lines, style, agents) {
    if (!agents?.length) {
        appendLine(lines, style, "Target agent", "Not specified");
        return;
    }
    appendLine(lines, style, agents.length === 1 ? "Target agent" : "Target agents", agents.map((agent) => agent.agent).join(", "));
    for (const agent of agents) {
        const suffix = agents.length > 1 ? ` (${agent.agent})` : "";
        appendLine(lines, style, `Installed skill${suffix}`, agent.skillPath);
        appendLine(lines, style, `Agent inject${suffix}`, agent.injectPath);
    }
}
function appendLine(lines, style, label, value) {
    if (value === undefined)
        return;
    lines.push(`  ${style.gray(`${label}:`)} ${value}`);
}
function trimTrailingBlankLines(lines) {
    while (lines.at(-1) === "") {
        lines.pop();
    }
    return lines;
}
function parseSetupResult(value) {
    if (!isRecord(value) || value.ok !== true)
        return undefined;
    if (value.command !== "init" && value.command !== "install")
        return undefined;
    return {
        ok: true,
        command: value.command,
        home: stringField(value, "home"),
        configPath: stringField(value, "configPath"),
        dbPath: stringField(value, "dbPath"),
        endpoint: stringField(value, "endpoint"),
        dryRun: booleanField(value, "dryRun"),
        binPath: stringField(value, "binPath"),
        source: stringField(value, "source"),
        pathReady: booleanField(value, "pathReady"),
        agents: agentResults(value.agents)
    };
}
function agentResults(value) {
    if (!Array.isArray(value))
        return undefined;
    return value.filter(isRecord).map((agent) => ({
        agent: stringField(agent, "agent") ?? "unknown",
        root: stringField(agent, "root"),
        injectPath: stringField(agent, "injectPath"),
        skillPath: stringField(agent, "skillPath"),
        dryRun: booleanField(agent, "dryRun")
    }));
}
function stringField(record, key) {
    const value = record[key];
    return typeof value === "string" ? value : undefined;
}
function booleanField(record, key) {
    const value = record[key];
    return typeof value === "boolean" ? value : undefined;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
