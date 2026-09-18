import type { Context } from '@deepseek-ai/cordis';
export interface ToolEnv {
    rootDir: string;
    requireBilingual: boolean;
    /** 由可信宿主绑定的账号身份；存在时所有 Project 都限制在该账号 namespace 内。 */
    accountId?: string;
    /** 当前选中的 Project；未显式传 project/dir 时自动使用。 */
    currentProject?: string;
}
/** JSON Schema 节点（作者态：属性级内联 required: true；编译后对象级为 required: string[]）。 */
export interface SchemaNode {
    type?: string;
    description?: string;
    required?: boolean | string[];
    properties?: Record<string, SchemaNode>;
    items?: SchemaNode;
    additionalProperties?: boolean;
    [key: string]: unknown;
}
/** params() 编译出的对象级 JSON Schema。 */
export type ObjectSchema = SchemaNode & {
    required?: string[];
};
/** 工具行为标记：read=只读；write=写入；destroy=破坏性；idempotent=幂等。 */
export type ToolBehavior = 'read' | 'write' | 'destroy' | 'idempotent';
export interface NormifyTool {
    name: string;
    description: string;
    behavior: ToolBehavior;
    parameters?: ObjectSchema;
    readOnly: boolean;
    idempotent: boolean;
    destructive: boolean;
    execute: (args: Record<string, unknown>) => Promise<unknown>;
    isConcurrencySafe?: () => boolean;
}
export declare function createNormifyTools(env: ToolEnv): NormifyTool[];
export declare function registerTools(ctx: Context, env: ToolEnv): void;
