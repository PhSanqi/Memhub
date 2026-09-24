import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loopbackPortOccupied, probeService, waitForService, type MemhubServiceKind } from "./service-readiness.js";

export interface ManagedServiceSpec {
  name: string;
  entrypoint: string;
  args: string[];
  healthUrl: string;
  kind: MemhubServiceKind;
  cwd: string;
  env?: Record<string, string>;
}

export interface ProcessStackEvent {
  type: "ready" | "started" | "stopped" | "restart_scheduled" | "unhealthy" | "fatal";
  service?: string;
  pid?: number;
  attempt?: number;
  delayMs?: number;
  reason?: string;
}

export interface ManagedProcessStackOptions {
  services: ManagedServiceSpec[];
  readinessTimeoutMs?: number;
  healthIntervalMs?: number;
  failureThreshold?: number;
  maxRestarts?: number;
  restartWindowMs?: number;
  shutdownTimeoutMs?: number;
  onEvent?: (event: ProcessStackEvent) => void;
}

/**
 * Owns children only in direct/Windows mode. Linux production keeps systemd as
 * the sole supervisor; never run both for the same ports/state root.
 */
export class ManagedProcessStack {
  private readonly services: ManagedServiceSpec[];
  private readonly options: Required<Omit<ManagedProcessStackOptions, "services" | "onEvent">>;
  private readonly onEvent: (event: ProcessStackEvent) => void;
  private readonly children = new Map<string, ChildProcess>();
  private readonly failures = new Map<string, number>();
  private readonly restartTimes: number[] = [];
  private desired = false;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private stoppingChildren?: Promise<void>;
  private recoveryTimer?: NodeJS.Timeout;
  private monitor?: NodeJS.Timeout;
  private monitoring = false;
  private recovering = false;
  private startupAbort?: AbortController;
  private fatalReason?: string;
  private readonly retryJitter: number;

  constructor(input: ManagedProcessStackOptions) {
    if (input.services.length === 0) throw new Error("Memhub stack needs at least one service");
    if (new Set(input.services.map((item) => item.name)).size !== input.services.length) {
      throw new Error("duplicate managed service name");
    }
    this.services = input.services.map((service) => ({ ...service, entrypoint: resolve(service.entrypoint), cwd: resolve(service.cwd) }));
    this.options = {
      readinessTimeoutMs: input.readinessTimeoutMs ?? 20_000,
      healthIntervalMs: input.healthIntervalMs ?? 2_000,
      failureThreshold: input.failureThreshold ?? 3,
      maxRestarts: input.maxRestarts ?? 5,
      restartWindowMs: input.restartWindowMs ?? 120_000,
      shutdownTimeoutMs: input.shutdownTimeoutMs ?? 3_000
    };
    this.onEvent = input.onEvent ?? (() => undefined);
    const seed = this.services.map((service) => `${service.cwd}:${service.healthUrl}`).join("|");
    this.retryJitter = 0.85 + createHash("sha256").update(seed).digest().readUInt16BE(0) / 0xffff * 0.3;
  }

  get status() {
    return {
      desired: this.desired,
      ready: this.desired && !this.starting && !this.recovering && !this.recoveryTimer && this.children.size === this.services.length,
      recovering: this.recovering || Boolean(this.recoveryTimer),
      fatalReason: this.fatalReason,
      pids: Object.fromEntries([...this.children].map(([name, child]) => [name, child.pid ?? null]))
    };
  }

  async start(): Promise<void> {
    if (this.stopping) await this.stopping;
    if (this.starting) return this.starting;
    if (this.desired && (this.recovering || this.recoveryTimer)) return;
    if (this.desired && this.children.size === this.services.length && !this.recoveryTimer && !this.recovering) return;
    this.desired = true;
    this.fatalReason = undefined;
    this.starting = this.startOwnedChildren().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  /** Retry only transient first-start failures. Existing ports/invalid installs are never taken over. */
  async startWithRetry(input: { attempts?: number; delayMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    const attempts = input.attempts ?? 5;
    const delayMs = input.delayMs ?? 1_000;
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10 ||
        !Number.isInteger(delayMs) || delayMs < 10 || delayMs > 30_000) {
      throw new RangeError("invalid startup retry policy");
    }
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (input.signal?.aborted) throw new Error("stack startup cancelled");
      try {
        await this.start();
        if (input.signal?.aborted) {
          await this.stop();
          throw new Error("stack startup cancelled");
        }
        return;
      } catch (error) {
        await this.stop();
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === attempts || input.signal?.aborted ||
            /entrypoint missing|port already in use|invalid|loopback|permission denied/i.test(message)) {
          throw error;
        }
        const waitMs = Math.min(30_000, delayMs * 2 ** (attempt - 1));
        this.onEvent({ type: "restart_scheduled", reason: `startup failed: ${message}`, attempt, delayMs: waitMs });
        await new Promise<void>((resolveDelay, rejectDelay) => {
          const timer = setTimeout(() => { input.signal?.removeEventListener("abort", abort); resolveDelay(); }, waitMs);
          const abort = () => { clearTimeout(timer); rejectDelay(new Error("stack startup cancelled")); };
          input.signal?.addEventListener("abort", abort, { once: true });
          if (input.signal?.aborted) abort();
        });
      }
    }
  }

  private async startOwnedChildren(): Promise<void> {
    const abort = new AbortController();
    this.startupAbort = abort;
    try {
      // Refuse another owner rather than adopting/killing a systemd or unrelated process.
      for (const spec of this.services) {
        if (!existsSync(spec.entrypoint)) throw new Error(`${spec.name} entrypoint missing: ${spec.entrypoint}`);
        if (await loopbackPortOccupied(spec.healthUrl)) throw new Error(`${spec.name} port already in use; use its existing supervisor`);
      }
      for (const spec of this.services) {
        if (!this.desired || abort.signal.aborted) throw new Error("stack startup cancelled");
        let spawnError: Error | undefined;
        const child = spawn(process.execPath, [spec.entrypoint, ...spec.args], {
          cwd: spec.cwd,
          env: { ...process.env, ...spec.env },
          stdio: "inherit",
          windowsHide: true
        });
        child.once("error", (error) => { spawnError = error; });
        child.once("exit", (code, signal) => {
          if (this.children.get(spec.name) === child && this.desired && !this.recovering && !this.starting) {
            this.scheduleRecovery(`${spec.name} exited (${code ?? signal ?? "unknown"})`);
          }
        });
        this.children.set(spec.name, child);
        this.onEvent({ type: "started", service: spec.name, pid: child.pid });
        await waitForService({
          url: spec.healthUrl,
          kind: spec.kind,
          timeoutMs: this.options.readinessTimeoutMs,
          signal: abort.signal,
          isAlive: () => !spawnError && child.exitCode === null && child.signalCode === null
        });
        this.onEvent({ type: "ready", service: spec.name, pid: child.pid });
      }
      this.failures.clear();
      this.beginMonitor();
    } catch (error) {
      await this.stopOwnedChildren();
      throw error;
    } finally {
      if (this.startupAbort === abort) this.startupAbort = undefined;
    }
  }

  private beginMonitor(): void {
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = setInterval(() => { void this.checkHealth(); }, this.options.healthIntervalMs);
  }

  private async checkHealth(): Promise<void> {
    if (this.monitoring || !this.desired || this.recovering || this.starting || this.recoveryTimer) return;
    this.monitoring = true;
    try {
      for (const spec of this.services) {
        const child = this.children.get(spec.name);
        if (!child || child.exitCode !== null || child.signalCode !== null) {
          this.scheduleRecovery(`${spec.name} exited`);
          return;
        }
        const probe = await probeService(spec.healthUrl, spec.kind);
        const failures = probe.ok ? 0 : (this.failures.get(spec.name) ?? 0) + 1;
        this.failures.set(spec.name, failures);
        if (failures >= this.options.failureThreshold) {
          this.onEvent({ type: "unhealthy", service: spec.name, reason: probe.reason });
          this.scheduleRecovery(`${spec.name} health failure (${probe.reason})`);
          return;
        }
      }
    } finally {
      this.monitoring = false;
    }
  }

  private scheduleRecovery(reason: string): void {
    if (!this.desired || this.recovering || this.recoveryTimer) return;
    if (this.monitor) { clearInterval(this.monitor); this.monitor = undefined; }
    const now = Date.now();
    while (this.restartTimes.length && this.restartTimes[0]! < now - this.options.restartWindowMs) this.restartTimes.shift();
    if (this.restartTimes.length >= this.options.maxRestarts) {
      this.fatalReason = `restart budget exhausted: ${reason}`;
      this.desired = false;
      this.onEvent({ type: "fatal", reason: this.fatalReason });
      void this.stopOwnedChildren();
      return;
    }
    this.restartTimes.push(now);
    const attempt = this.restartTimes.length;
    const delayMs = Math.round(Math.min(30_000, 1_000 * 2 ** (attempt - 1)) * this.retryJitter);
    this.onEvent({ type: "restart_scheduled", reason, attempt, delayMs });
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      void this.recover();
    }, delayMs);
  }

  private async recover(): Promise<void> {
    if (!this.desired || this.recovering) return;
    this.recovering = true;
    let failure: string | undefined;
    try {
      await this.stopOwnedChildren();
      if (this.desired) await this.startOwnedChildren();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      this.recovering = false;
    }
    if (failure && this.desired) this.scheduleRecovery(failure);
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.desired = false;
    this.startupAbort?.abort();
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = undefined;
    this.stopping = (async () => {
      if (this.starting) await this.starting.catch(() => undefined);
      while (this.recovering) await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      await this.stopOwnedChildren();
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  private async stopOwnedChildren(): Promise<void> {
    if (this.stoppingChildren) return this.stoppingChildren;
    this.stoppingChildren = this.terminateOwnedChildren().finally(() => { this.stoppingChildren = undefined; });
    return this.stoppingChildren;
  }

  private async terminateOwnedChildren(): Promise<void> {
    const owned = [...this.children].reverse();
    this.children.clear();
    for (const [name, child] of owned) {
      await stopChild(child, this.options.shutdownTimeoutMs);
      this.onEvent({ type: "stopped", service: name, pid: child.pid });
    }
  }
}

async function stopChild(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const closed = new Promise<void>((resolveClosed) => child.once("close", () => resolveClosed()));
  child.kill("SIGTERM");
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<void>((resolveTimeout) => { timer = setTimeout(resolveTimeout, timeoutMs); })
    ]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await closed;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}
