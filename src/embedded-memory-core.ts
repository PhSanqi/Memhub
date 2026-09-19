import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface EmbeddedMemoryCoreOptions {
  stateRoot?: string;
  host?: string;
  port?: number;
  configPath?: string;
  dbPath?: string;
  entrypoint?: string;
}

export class EmbeddedMemoryCore {
  readonly endpoint: string;
  readonly configPath: string;
  readonly dbPath: string;
  readonly entrypoint: string;
  private child?: ChildProcess;

  constructor(options: EmbeddedMemoryCoreOptions = {}) {
    const stateRoot = resolve(options.stateRoot ?? process.env.MEMHUB_STATE_ROOT ?? join(homedir(), ".memhub"));
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? 18960;
    this.endpoint = `http://${host}:${port}`;
    // Compatibility-first migration: an existing Memmy config/database can be
    // adopted in place, while clean installs use ~/.memhub/core.
    this.configPath = resolve(options.configPath ?? process.env.MEMHUB_CORE_CONFIG ?? legacyOr(
      join(homedir(), ".memmy", "config.yaml"),
      join(stateRoot, "core", "config.yaml")
    ));
    this.dbPath = resolve(options.dbPath ?? process.env.MEMHUB_CORE_DB ?? legacyOr(
      join(homedir(), ".memmy", "memory-service", "memory.sqlite"),
      join(stateRoot, "core", "memory.sqlite")
    ));
    this.entrypoint = resolve(options.entrypoint ?? process.env.MEMHUB_MEMORY_CORE_ENTRY ?? defaultEntrypoint());
  }

  async start(): Promise<string> {
    if (await healthy(this.endpoint)) return this.endpoint;
    if (!existsSync(this.entrypoint)) throw new Error(`embedded Memory Core is missing: ${this.entrypoint}`);
    this.child = spawn(process.execPath, [
      this.entrypoint,
      "--config", this.configPath,
      "--host", "127.0.0.1",
      "--port", new URL(this.endpoint).port,
      "--db", this.dbPath
    ], { stdio: "inherit", env: { ...process.env, MEMHUB_EMBEDDED_MEMORY_CORE: "1" } });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await healthy(this.endpoint)) return this.endpoint;
      if (this.child.exitCode !== null) throw new Error(`embedded Memory Core exited with code ${this.child.exitCode}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    throw new Error("embedded Memory Core did not become healthy");
  }

  async stop(): Promise<void> {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.kill("SIGTERM");
  }
}

function defaultEntrypoint(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "vendor", "memory-core", "src", "server", "index.js");
}

function legacyOr(legacy: string, clean: string): string {
  return existsSync(legacy) ? legacy : clean;
}

async function healthy(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(500) });
    return response.ok;
  } catch {
    return false;
  }
}
