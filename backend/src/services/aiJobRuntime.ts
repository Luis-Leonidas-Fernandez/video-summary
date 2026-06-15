import { aiRuntimeManager } from './aiRuntimeManager.js';

export function jobRequiresAi(generateSummary: boolean, generateTranslation: boolean): boolean {
  return generateSummary || generateTranslation;
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
