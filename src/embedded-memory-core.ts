import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ManagedProcessStack } from "./process-stack.js";
import { probeService } from "./service-readiness.js";

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
  private stack?: ManagedProcessStack;
  private starting?: Promise<string>;

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
    if (this.starting) return this.starting;
    this.starting = this.startOwnedOrExternal().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  async stop(): Promise<void> {
    // Stop first to abort an in-flight health wait instead of waiting for the
    // entire startup deadline before shutting down.
    if (this.stack) await this.stack.stop();
    if (this.starting) await this.starting.catch(() => undefined);
    this.stack = undefined;
  }

  private async startOwnedOrExternal(): Promise<string> {
    if (this.stack?.status.ready) return this.endpoint;
    // Preserve existing embedded-mode compatibility: reuse a healthy external
    // Memory Core, but never register it as owned or send it termination signals.
    if (!this.stack && (await probeService(`${this.endpoint}/health`, "core")).ok) return this.endpoint;
    if (!existsSync(this.entrypoint)) throw new Error(`embedded Memory Core is missing: ${this.entrypoint}`);
    this.stack ??= new ManagedProcessStack({
      services: [{
        name: "memory-core",
        kind: "core",
        entrypoint: this.entrypoint,
        cwd: dirname(this.entrypoint),
        args: ["--config", this.configPath, "--host", "127.0.0.1", "--port", new URL(this.endpoint).port, "--db", this.dbPath],
        healthUrl: `${this.endpoint}/health`,
        env: { MEMHUB_EMBEDDED_MEMORY_CORE: "1" }
      }],
      readinessTimeoutMs: 10_000
    });
    try {
      await this.stack.start();
    } catch (error) {
      await this.stack.stop();
      this.stack = undefined;
      throw error;
    }
    return this.endpoint;
  }
}

function defaultEntrypoint(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "vendor", "memory-core", "src", "server", "index.js");
}

function legacyOr(legacy: string, clean: string): string {
  return existsSync(legacy) ? legacy : clean;
}
