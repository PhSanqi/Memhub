import type { NormifyTool, ToolEnv } from './tools.js';
export interface NormifyRuntimeOptions {
    rootDir?: string;
    requireBilingual?: boolean;
    /** Authenticated host identity. When set, Project storage is isolated to this account. */
    accountId?: string;
    /**
     * Mutable Project selection owned by the host. Reusing the same object across
     * runtime instances keeps implicit Project routing stable across MCP sessions.
     */
    projectSelection?: NormifyProjectSelection;
}
export interface NormifyProjectSelection {
    currentProject?: string;
}
export interface NormifyRuntime {
    env: ToolEnv;
    tools: readonly NormifyTool[];
    callTool: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
}
/** Host-independent Normify runtime used by CLI, MCP and future adapters. */
export declare function createNormifyRuntime(options?: NormifyRuntimeOptions): NormifyRuntime;
export { createNormifyTools } from './tools.js';
export type { NormifyTool, ObjectSchema, SchemaNode, ToolBehavior, ToolEnv } from './tools.js';
