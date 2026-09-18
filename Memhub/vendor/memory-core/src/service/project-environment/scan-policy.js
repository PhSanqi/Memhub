import { canonicalJson, sha256Hex } from "../../contracts/index.js";
export const PROJECT_ENVIRONMENT_SCAN_POLICY = {
    maxDepth: 20,
    maxEntries: 20_000,
    maxRelativePathUtf8Bytes: 4096,
    maxTextBytes: 1024 * 1024
};
export const PROJECT_SOURCE_EXTENSIONS = [
    ".c", ".cc", ".cpp", ".cs", ".go", ".h", ".hpp", ".java", ".js", ".jsx",
    ".kt", ".kts", ".mjs", ".cjs", ".php", ".py", ".rb", ".rs", ".scala",
    ".swift", ".ts", ".tsx"
];
export function isDeterministicCandidate(relativePath) {
    if (validateWorkspaceRelativePath(relativePath) || isSensitivePath(relativePath))
        return false;
    const segments = relativePath.split("/");
    const basename = segments.at(-1);
    const lower = basename.toLowerCase();
    const depth = segments.length - 1;
    if (segments.length === 3 && segments[0] === ".github" && segments[1] === "workflows" && /\.(ya?ml)$/i.test(basename))
        return true;
    if (depth <= 2 && /\.(sln|csproj)$/i.test(basename))
        return true;
    if (depth !== 0)
        return false;
    if (/^(package\.json|pyproject\.toml|cargo\.toml|go\.mod|pom\.xml|makefile)$/i.test(basename))
        return true;
    if (/^(package-lock\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lock)$/i.test(basename))
        return true;
    if (/^(tsconfig|jsconfig).*\.json$/i.test(basename))
        return true;
    if (/^(eslint\.config\.(js|cjs|mjs|ts)|\.eslintrc(\.(json|ya?ml|js|cjs))?)$/i.test(basename))
        return true;
    if (/^(jest\.config\.(js|cjs|mjs|ts|json)|vitest\.config\.(js|mjs|ts))$/i.test(basename))
        return true;
    if (/^(poetry\.lock|uv\.lock|requirements.*\.txt|\.python-version|tox\.ini|pytest\.ini|setup\.cfg)$/i.test(basename))
        return true;
    if (/^(cargo\.lock|rust-toolchain(\.toml)?|go\.sum|go\.work(\.sum)?)$/i.test(basename))
        return true;
    if (/^(build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties)$/i.test(basename))
        return true;
    if (/^(dockerfile(\..*)?|compose\.ya?ml|docker-compose\.ya?ml)$/i.test(basename))
        return true;
    if (/^(\.gitlab-ci\.yml|azure-pipelines\.yml|jenkinsfile)$/i.test(basename))
        return true;
    return /^(\.nvmrc|\.node-version|\.tool-versions|\.java-version|\.ruby-version)$/i.test(basename);
}
export function isSensitivePath(relativePath) {
    const lower = relativePath.toLowerCase();
    const basename = lower.split("/").at(-1) ?? lower;
    return basename.startsWith(".env") || basename.includes("credentials") || basename.includes("secret") ||
        /\.(pem|key|p12|pfx|crt|cer)$/i.test(basename) || basename === ".npmrc" ||
        basename === ".pypirc" || basename === "settings.xml" || lower.startsWith(".ssh/");
}
export function validateWorkspaceRelativePath(value) {
    if (new TextEncoder().encode(value).byteLength > PROJECT_ENVIRONMENT_SCAN_POLICY.maxRelativePathUtf8Bytes) {
        return "relative path exceeds 4096 UTF-8 bytes";
    }
    if (value.includes("\0"))
        return "relative path must not contain NUL";
    if (value.includes("\\"))
        return "relative path must use forward slashes";
    if (value.startsWith("/") || value.startsWith("//"))
        return "relative path must not be absolute";
    if (/^[A-Za-z]:/.test(value))
        return "relative path must not include a Windows drive prefix";
    const segments = value.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
        return "relative path contains an empty, dot, or parent segment";
    }
    return null;
}
export function buildCompactFileTree(entries) {
    const paths = entries.map((entry) => ({ path: entry.relativePath, directory: entry.type === "directory" }));
    const children = new Map();
    for (const item of paths) {
        const segments = item.path.split("/");
        for (let index = 0; index < segments.length; index += 1) {
            const parent = segments.slice(0, index).join("/");
            const name = segments[index];
            const isDirectory = index < segments.length - 1 || item.directory;
            const siblings = children.get(parent) ?? new Map();
            siblings.set(name, (siblings.get(name) ?? false) || isDirectory);
            children.set(parent, siblings);
        }
    }
    const lines = [];
    const visit = (parent, depth) => {
        const siblings = children.get(parent);
        if (!siblings)
            return;
        for (const [name, isDirectory] of [...siblings.entries()].sort(([left], [right]) => compareCodePoints(left, right))) {
            lines.push(`${"  ".repeat(depth)}${name}${isDirectory ? "/" : ""}`);
            if (isDirectory)
                visit(parent ? `${parent}/${name}` : name, depth + 1);
        }
    };
    visit("", 0);
    return lines.join("\n");
}
export function projectFingerprint(input) {
    const sortedTypeAndPath = input.entries
        .map((entry) => `${entry.type}:${entry.relativePath}`)
        .sort(compareCodePoints);
    const sortedCandidatePathAndHash = input.entries
        .filter((entry) => entry.type === "file" && typeof entry.sha256 === "string" && isDeterministicCandidate(entry.relativePath))
        .map((entry) => `${entry.relativePath}:${entry.sha256}`)
        .sort(compareCodePoints);
    return sha256Hex(canonicalJson({
        kind: input.kind,
        sortedTypeAndPath,
        sortedCandidatePathAndHash,
        omittedCount: input.omittedCount,
        deterministicFacts: JSON.parse(JSON.stringify(input.deterministicFacts))
    }));
}
export function requiredRuntimeProbes(entries) {
    const paths = new Set(entries.map((entry) => entry.relativePath.toLowerCase()));
    const extensions = new Set(entries.map((entry) => extensionOf(entry.relativePath.toLowerCase())));
    const probes = [];
    if (paths.has("package.json") || extensions.has(".js") || extensions.has(".ts") || extensions.has(".tsx"))
        probes.push("node_version");
    if (paths.has("pyproject.toml") || extensions.has(".py"))
        probes.push("python_version");
    if (paths.has("go.mod") || extensions.has(".go"))
        probes.push("go_version");
    if (paths.has("cargo.toml") || extensions.has(".rs"))
        probes.push("rust_version");
    if (paths.has("pom.xml") || paths.has("build.gradle") || extensions.has(".java") || extensions.has(".kt"))
        probes.push("java_version");
    return probes;
}
export function deterministicReadCandidates(entries) {
    const maxBytes = PROJECT_ENVIRONMENT_SCAN_POLICY.maxTextBytes;
    return entries
        .filter((entry) => entry.type === "file" && typeof entry.sha256 === "string" && isDeterministicCandidate(entry.relativePath))
        .sort((left, right) => compareCodePoints(left.relativePath, right.relativePath))
        .map((entry) => ({ relativePath: entry.relativePath, sha256: entry.sha256, maxBytes }));
}
export function extensionOf(relativePath) {
    const basename = relativePath.split("/").at(-1) ?? relativePath;
    const index = basename.lastIndexOf(".");
    return index <= 0 ? "" : basename.slice(index).toLowerCase();
}
function compareCodePoints(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
