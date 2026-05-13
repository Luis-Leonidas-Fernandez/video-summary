import { spawn, type ChildProcess } from 'node:child_process';
import { appConfig } from '../config.js';
import { checkCommandAvailable } from '../utils/shell.js';
import type { AiRuntimeStatus } from '../types.js';
import { updateRuntimeSessionState } from './runtimeSessionState.js';

const OLLAMA_TAGS_URL = `${appConfig.ollamaBaseUrl}/api/tags`;
const OLLAMA_GENERATE_URL = `${appConfig.ollamaBaseUrl}/api/generate`;
const OLLAMA_REACHABILITY_TIMEOUT_MS = 2_000;
const OLLAMA_STARTUP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

export interface AiRuntimeSnapshot {
  aiRuntime: AiRuntimeStatus;
  ownedByCurrentSession: boolean;
  activeJobsCount: number;
  idleShutdownMs: number;
  lastActivityAt?: string;
  nextShutdownAt?: string;
}

async function isOllamaReachable(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_REACHABILITY_TIMEOUT_MS);

  try {
    const response = await fetch(OLLAMA_TAGS_URL, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class AiRuntimeManager {
  private status: AiRuntimeStatus = 'offline';
  private ownedByCurrentSession = false;
  private activeJobsCount = 0;
  private lastActivityAt?: Date;
  private nextShutdownAt?: Date;
  private idleTimer?: NodeJS.Timeout;
  private startupPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private ollamaProcess?: ChildProcess;
  private activeRequestControllers = new Set<AbortController>();

  async ensureReady(): Promise<void> {
    if (this.startupPromise) {
      await this.startupPromise;
      return;
    }

    if (await isOllamaReachable()) {
      if (this.activeJobsCount === 0 && this.status !== 'idle') {
        this.status = this.ownedByCurrentSession ? 'idle' : 'ready';
      }
      return;
    }

    this.startupPromise = this.startRuntime();

    try {
      await this.startupPromise;
    } finally {
      this.startupPromise = undefined;
    }
  }

  async beginJob(): Promise<void> {
    this.cancelIdleShutdown();
    await this.ensureReady();

    this.activeJobsCount += 1;
    this.status = 'busy';
    this.lastActivityAt = new Date();
  }

  async endJob(): Promise<void> {
    this.activeJobsCount = Math.max(0, this.activeJobsCount - 1);
    this.lastActivityAt = new Date();

    if (this.activeJobsCount === 0) {
      await this.unloadModel().catch(() => {
        // no-op: no queremos romper el cierre del job por una descarga fallida
      });
      this.status = 'idle';
      this.scheduleIdleShutdown();
    }
  }

  markActivity(): void {
    this.lastActivityAt = new Date();

    if (this.activeJobsCount > 0) {
      this.status = 'busy';
    }
  }

  scheduleIdleShutdown(): void {
    if (!this.ownedByCurrentSession) {
      this.nextShutdownAt = undefined;
      return;
    }

    if (this.activeJobsCount > 0) {
      return;
    }

    this.cancelIdleShutdown();
    this.nextShutdownAt = new Date(Date.now() + appConfig.ollamaIdleShutdownMs);
    this.idleTimer = setTimeout(async () => {
      if (this.activeJobsCount === 0 && this.status === 'idle') {
        await this.stopIfOwned();
        this.status = 'offline';
      }
    }, appConfig.ollamaIdleShutdownMs);
  }

  cancelIdleShutdown(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }

    this.nextShutdownAt = undefined;
  }

  async stopIfOwned(): Promise<void> {
    if (!this.ownedByCurrentSession) {
      return;
    }

    if (this.stopPromise) {
      await this.stopPromise;
      return;
    }

    this.stopPromise = this.stopRuntime();

    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = undefined;
    }
  }

  async unloadModel(): Promise<void> {
    if (!this.ownedByCurrentSession) {
      return;
    }

    await this.forceUnloadModel();
  }

  createRequestController(): AbortController {
    const controller = new AbortController();
    this.activeRequestControllers.add(controller);
    return controller;
  }

  releaseRequestController(controller: AbortController): void {
    this.activeRequestControllers.delete(controller);
  }

  async forceStopAll(): Promise<void> {
    this.abortActiveRequests();
    await this.forceUnloadModel();

    if (this.ownedByCurrentSession) {
      await this.stopIfOwned();
      this.status = 'offline';
      return;
    }

    if (this.activeJobsCount === 0) {
      this.status = (await isOllamaReachable()) ? 'ready' : 'offline';
    }
  }

  private abortActiveRequests(): void {
    for (const controller of this.activeRequestControllers) {
      controller.abort();
    }
    this.activeRequestControllers.clear();
  }

  private async forceUnloadModel(): Promise<void> {
    this.abortActiveRequests();

    if (!(await isOllamaReachable())) {
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OLLAMA_STARTUP_TIMEOUT_MS);

    try {
      await fetch(OLLAMA_GENERATE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: appConfig.ollamaModel,
          prompt: '',
          keep_alive: 0,
        }),
        signal: controller.signal,
      });
      this.lastActivityAt = new Date();
    } catch {
      // ignore unload failures; idle shutdown still acts as a fallback
    } finally {
      clearTimeout(timeout);
    }
  }

  async getStatus(): Promise<AiRuntimeSnapshot> {
    if (!this.ownedByCurrentSession && this.activeJobsCount === 0) {
      const reachable = await isOllamaReachable();
      if (reachable && this.status === 'offline') {
        this.status = 'ready';
      } else if (!reachable && this.status === 'ready') {
        this.status = 'offline';
      }
    }

    return {
      aiRuntime: this.status,
      ownedByCurrentSession: this.ownedByCurrentSession,
      activeJobsCount: this.activeJobsCount,
      idleShutdownMs: appConfig.ollamaIdleShutdownMs,
      lastActivityAt: this.lastActivityAt?.toISOString(),
      nextShutdownAt: this.nextShutdownAt?.toISOString(),
    };
  }

  private async startRuntime(): Promise<void> {
    const ollamaAvailable = await checkCommandAvailable('ollama');
    if (!ollamaAvailable) {
      this.status = 'error';
      throw new Error('No se encontró el comando `ollama` para levantar el runtime on-demand.');
    }

    this.status = 'starting';
    this.ollamaProcess = spawn('ollama', ['serve'], {
      stdio: 'ignore',
      detached: false,
      env: {
        ...process.env,
        OLLAMA_NUM_PARALLEL: String(appConfig.ollamaNumParallel),
        OLLAMA_MAX_LOADED_MODELS: String(appConfig.ollamaMaxLoadedModels),
      },
    });

    this.ownedByCurrentSession = true;
    await updateRuntimeSessionState({ ollamaStartedByBackend: true });

    this.ollamaProcess.on('exit', () => {
      this.ollamaProcess = undefined;
      this.status = this.activeJobsCount > 0 ? 'error' : 'offline';
      this.cancelIdleShutdown();
      void updateRuntimeSessionState({ ollamaStartedByBackend: false });
    });

    const started = await this.waitForReachable(true);
    if (!started) {
      this.status = 'error';
      throw new Error('Ollama no quedó disponible dentro del tiempo esperado.');
    }

    this.status = 'ready';
    this.lastActivityAt = new Date();
  }

  private async stopRuntime(): Promise<void> {
    this.cancelIdleShutdown();
    this.status = 'stopping';

    const pid = this.ollamaProcess?.pid;
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // ignore
      }
    }

    const stopped = await this.waitForReachable(false);
    if (!stopped && pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // ignore
      }
      await this.waitForReachable(false);
    }

    this.ownedByCurrentSession = false;
    this.ollamaProcess = undefined;
    this.nextShutdownAt = undefined;
    await updateRuntimeSessionState({ ollamaStartedByBackend: false });
  }

  private async waitForReachable(targetReachable: boolean): Promise<boolean> {
    const deadline = Date.now() + OLLAMA_STARTUP_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const reachable = await isOllamaReachable();
      if (reachable === targetReachable) {
        return true;
      }
      await wait(POLL_INTERVAL_MS);
    }

    return false;
  }
}

export const aiRuntimeManager = new AiRuntimeManager();
