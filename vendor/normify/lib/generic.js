import { resolve } from 'node:path';
import { createNormifyTools } from './tools.js';
/** Host-independent Normify runtime used by CLI, MCP and future adapters. */
export function createNormifyRuntime(options = {}) {
    const accountId = options.accountId?.trim();
    if (options.accountId !== undefined && accountId === '')
        throw new TypeError('accountId must be a non-empty string when provided.');
    const env = {
        rootDir: resolve(options.rootDir ?? process.cwd()),
        requireBilingual: options.requireBilingual ?? true,
        ...(accountId === undefined ? {} : { accountId }),
    };
    if (options.projectSelection !== undefined) {
        const selection = options.projectSelection;
        Object.defineProperty(env, 'currentProject', {
            enumerable: true,
            configurable: false,
            get: () => selection.currentProject,
            set: (value) => {
                if (value === undefined)
                    delete selection.currentProject;
                else
                    selection.currentProject = value;
            },
        });
    }
    const tools = createNormifyTools(env);
    const byName = new Map(tools.map(tool => [tool.name, tool]));
    return {
        env,
        tools,
        async callTool(name, args = {}) {
            const tool = byName.get(name);
            if (tool === undefined) {
                return {
                    ok: false,
                    error: {
                        code: 'tool/not-found',
                        message: '未知工具：' + name,
                    },
                };
            }
            return tool.execute(args);
        },
    };
}
export { createNormifyTools } from './tools.js';
//# sourceMappingURL=generic.js.map