import path from 'node:path'
import { promises as fs } from 'node:fs'
import { appConfig } from '../config.js'
import { checkCommandAvailable, runCommand } from '../utils/shell.js'
import type { WorkerGroundingReport } from './groundingTypes.js'
import { aiRuntimeManager } from './aiRuntimeManager.js'

async function ensureGroundingRuntimeAvailable(): Promise<void> {
  const pythonAvailable = await checkCommandAvailable(appConfig.groundingPythonBin)
  if (!pythonAvailable) {
    throw new Error(`No se encontró el binario de Python configurado para grounding: ${appConfig.groundingPythonBin}`)
  }

  const workerExists = await fs.access(appConfig.groundingWorkerPath).then(() => true).catch(() => false)
  if (!workerExists) {
    throw new Error(`No se encontró el worker de grounding: ${appConfig.groundingWorkerPath}`)
  }
}

export async function generateGroundingReport({
  jobId,
  outputDir,
  manifestPath,
  claimsPaths,
  log,
  signal,
}: {
  jobId: string
  outputDir: string
  manifestPath: string
  claimsPaths: string[]
  log: (message: string) => Promise<void>
  signal?: AbortSignal
}): Promise<WorkerGroundingReport> {
  await ensureGroundingRuntimeAvailable()
  await aiRuntimeManager.ensureReady()
  aiRuntimeManager.markActivity()

  const reportPath = path.join(outputDir, 'grounding_worker_report.json')
  const args = [
    appConfig.groundingWorkerPath,
    'validate',
    '--job-id',
    jobId,
    '--manifest',
    manifestPath,
    '--output',
    reportPath,
    '--ollama-base-url',
    appConfig.ollamaBaseUrl,
    '--ollama-llm-model',
    appConfig.ollamaModel,
    '--ollama-embed-model',
    appConfig.groundingOllamaEmbedModel,
    '--ollama-num-ctx',
    String(appConfig.groundingOllamaNumCtx),
    '--ollama-num-predict',
    String(appConfig.groundingOllamaNumPredict),
    '--top-k',
    String(appConfig.groundingTopK),
    '--supported-threshold',
    String(appConfig.groundingSupportedThreshold),
    '--weak-threshold',
    String(appConfig.groundingWeakThreshold),
    '--claims',
    ...claimsPaths,
  ]

  let stdout = ''
  let stderr = ''

  await runCommand({
    command: appConfig.groundingPythonBin,
    args,
    signal,
    onStdout: async (chunk) => {
      stdout += chunk
    },
    onStderr: async (chunk) => {
      stderr += chunk
    },
  })

  if (stdout.trim()) {
    await log(`[grounding] ${stdout.trim()}`)
  }
  if (stderr.trim()) {
    await log(`[grounding:stderr] ${stderr.trim()}`)
  }

  aiRuntimeManager.markActivity()
  const raw = await fs.readFile(reportPath, 'utf-8')
  return JSON.parse(raw) as WorkerGroundingReport
}
