import { appConfig } from '../config.js';
import type { HealthResponse } from '../types.js';
import { aiRuntimeManager } from './aiRuntimeManager.js';
import { modelSelectionService } from './modelSelectionService.js';

export async function getHealthResponse(): Promise<HealthResponse> {
  const runtime = await aiRuntimeManager.getStatus();
  const selection = await modelSelectionService.getActiveModelState();

  return {
    ok: true,
    ollamaBaseUrl: appConfig.ollamaBaseUrl,
    ollamaModel: selection.activeModel,
    aiRuntime: runtime.aiRuntime,
    ownedByCurrentSession: runtime.ownedByCurrentSession,
    activeJobsCount: runtime.activeJobsCount,
    idleShutdownMs: runtime.idleShutdownMs,
    lastActivityAt: runtime.lastActivityAt,
    nextShutdownAt: runtime.nextShutdownAt,
  };
}
