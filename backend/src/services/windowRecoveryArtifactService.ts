import type { EvidenceWindow, ProcessingStageObserver } from './groundingTypes.js'

export type RecoveryStage = 'generation' | 'repair'

export interface ParseDebugArtifactPaths {
  rawInvalidOutputPath?: string
  recoveredJsonPath?: string
}

export async function persistParseDebugArtifacts({
  observer,
  stage,
  window,
  rawOutput,
  parseError,
  allowedCitationIds,
  recoveryAttempted,
  recoveryStatus,
  recoveredJsonText,
  failureKind,
  recoveryPath,
}: {
  observer?: ProcessingStageObserver
  stage: RecoveryStage
  window: EvidenceWindow
  rawOutput: string
  parseError: string
  allowedCitationIds: string[]
  recoveryAttempted: boolean
  recoveryStatus: 'succeeded' | 'failed'
  recoveredJsonText?: string
  failureKind?: string
  recoveryPath?: string[]
}): Promise<ParseDebugArtifactPaths> {
  if (!observer?.writeArtifact) {
    return {}
  }

  const rawInvalidOutputPath = await observer.writeArtifact(
    `${stage}_raw_${window.windowId}.txt`,
    rawOutput,
  )

  const parseErrorReport = {
    windowId: window.windowId,
    stage,
    error: parseError,
    rawPreview: rawOutput.slice(0, 800),
    allowedCitationIds,
    recoveryAttempted,
    recoveryStatus,
    failureKind,
    recoveryPath,
  }

  await observer.writeArtifact(
    `${stage}_parse_error_${window.windowId}.json`,
    JSON.stringify(parseErrorReport, null, 2),
  )

  let recoveredJsonPath: string | undefined
  if (recoveredJsonText?.trim()) {
    recoveredJsonPath = await observer.writeArtifact(
      `${stage}_recovered_${window.windowId}.json`,
      recoveredJsonText,
    )
  }

  return {
    rawInvalidOutputPath,
    recoveredJsonPath,
  }
}

