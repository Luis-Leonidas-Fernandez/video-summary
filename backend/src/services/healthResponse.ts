import { appConfig } from '../config.js';
import type { HealthResponse } from '../types.js';
import { aiRuntimeManager } from './aiRuntimeManager.js';

export async function getHealthResponse(): Promise<HealthResponse> {
  const runtime = await aiRuntimeManager.getStatus();

  return {
    ok: true,
    ollamaBaseUrl: appConfig.ollamaBaseUrl,
    ollamaModel: appConfig.ollamaModel as 'gemma3:12b',
    aiRuntime: runtime.aiRuntime,
    ownedByCurrentSession: runtime.ownedByCurrentSession,
    activeJobsCount: runtime.activeJobsCount,
    idleShutdownMs: runtime.idleShutdownMs,
    lastActivityAt: runtime.lastActivityAt,
    nextShutdownAt: runtime.nextShutdownAt,
  };
}
