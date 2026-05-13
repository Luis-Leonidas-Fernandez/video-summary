import { aiRuntimeManager } from './aiRuntimeManager.js';

export function jobRequiresAi(generateSummary: boolean): boolean {
  return generateSummary;
}

export async function runWithAiRuntime<T>(
  requiresAi: boolean,
  work: () => Promise<T>,
): Promise<T> {
  if (!requiresAi) {
    return work();
  }

  await aiRuntimeManager.beginJob();

  try {
    return await work();
  } finally {
    await aiRuntimeManager.endJob();
  }
}
