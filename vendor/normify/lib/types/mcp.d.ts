#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import type { NormifyRuntimeOptions } from './generic.js';
export declare function createNormifyMcpServer(options?: NormifyRuntimeOptions): McpServer;
export declare function main(argv?: string[]): Promise<void>;
