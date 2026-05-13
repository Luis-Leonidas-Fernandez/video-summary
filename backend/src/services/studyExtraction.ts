import { repairInvalidCitationsResponse } from './citationRepairService.js'
import { validateCitationIntegrity } from './citationIntegrityService.js'
import { buildCoverageMetrics, isTooCompressed } from './coverageMetricsService.js'
import { buildEvidenceWindows } from './evidenceWindowService.js'
import { generateGroundedWindowExtractionResponse } from './groundedWindowGenerator.js'
import { consolidateWindowExtractions } from './studyPartConsolidationService.js'
import { classifyWindowCompression, measureWindowCoverage } from './windowCompressionService.js'
import { resolveWindowExtraction } from './windowRecoveryService.js'
import type {
  ChunkManifestChunk,
  CitationIntegrityReport,
  CoverageMetrics,
  EvidencePackDocument,
  EvidenceWindow,
  GroundedWindowExtraction,
  ProcessingStageObserver,
  SummaryQualityStatus,
  ThinReasoningEvalBundle,
  WindowCoverageMetrics,
  WindowFinalStatus,
  WindowGenerationStatus,
  WindowRepairStatus,
  WindowExtractionStatus,
  WindowOutputFailureKind,
  RecoveryPathStep,
} from './groundingTypes.js'
import {
  validateExtractionContent,
  type ValidationMatch,
  type ValidationMetrics,
  type ValidationResult,
  type ValidationStatus,
} from './studyValidation.js'

const MAX_CITATION_REPAIR_ATTEMPTS = 1
const HEARTBEAT_INTERVAL_MS = 30_000

export interface ValidationReportPart {
  part: string
  status: ValidationStatus
  decisionReason: string
  metrics: ValidationMetrics
  matches: ValidationMatch[]
  warnings: string[]
  strongFlags: string[]
  repairAttempts: number
}

export interface ExtractionGenerationResult {
  content: string
  shortSummary: string
  title: string
  validation: ValidationReportPart
  evidencePack: EvidencePackDocument
  groundedWindows: GroundedWindowExtraction[]
  citationIntegrity: CitationIntegrityReport
  citationRepairAttempts: number
  qualityStatus: SummaryQualityStatus
  coverage: CoverageMetrics
  windowReports: Array<{
    windowId: string
    status: WindowExtractionStatus
    generationStatus: WindowGenerationStatus
    repairStatus?: WindowRepairStatus
    failureKind?: WindowOutputFailureKind
    recoveryPath: RecoveryPathStep[]
    preservedPreviousExtraction?: boolean
    parseError?: string
    rawInvalidOutputPath?: string
    recoveredJsonPath?: string
    fallbackExtraction?: boolean
    finalStatus: WindowFinalStatus
    citationIntegrity: CitationIntegrityReport
    decisionReason: string
    noteBlockCount: number
    extractionWordCount: number
    coverage: WindowCoverageMetrics
    thinReasoningEvals?: ThinReasoningEvalBundle
  }>
}

function normalizePartExtraction(partNumber: number, content: string): string {
  const partHeading = `## Parte ${String(partNumber).padStart(3, '0')}`
  const trimmed = content.trim()

  if (!trimmed) {
    return `${partHeading}\n`
  }

  if (trimmed.startsWith(partHeading)) {
    return `${trimmed}\n`
  }

  return `${partHeading}\n\n${trimmed}\n`
}

function buildReportPart(
  partNumber: number,
  status: ValidationStatus,
  validation: ValidationResult,
  repairAttempts: number,
  encounteredStrongFlags: string[] = validation.decision.strongFlags,
): ValidationReportPart {
  return {
    part: String(partNumber).padStart(3, '0'),
    status,
    decisionReason: validation.decision.decisionReason,
    metrics: validation.metrics,
    matches: validation.matches,
    warnings: validation.decision.warnings,
    strongFlags: encounteredStrongFlags,
    repairAttempts,
  }
}

function mergeIntegrity(reports: CitationIntegrityReport[]): CitationIntegrityReport {
  return {
    ok: reports.every((report) => report.ok),
    invalidCitationIds: Array.from(new Set(reports.flatMap((report) => report.invalidCitationIds))),
    malformedCitations: Array.from(new Set(reports.flatMap((report) => report.malformedCitations))),
    claimsWithoutCitation: reports.flatMap((report) => report.claimsWithoutCitation),
  }
}

function buildWindowDecisionReason({
  status,
  integrity,
  finalStatus,
  fallbackExtraction,
  repairStatus,
  preservedPreviousExtraction,
}: {
  status: WindowExtractionStatus
  integrity: CitationIntegrityReport
  finalStatus: WindowFinalStatus
  fallbackExtraction: boolean
  repairStatus?: WindowRepairStatus
  preservedPreviousExtraction?: boolean
}): string {
  if (fallbackExtraction) {
    return 'La ventana no pudo sostener un contenido usable y se degradó a un fallback editorial. Requiere revisión humana.'
  }
  if (preservedPreviousExtraction) {
    return 'El repair falló, pero se preservó la extracción previa útil para no degradar la ventana innecesariamente.'
  }
  if (finalStatus === 'needs_review' || status === 'needs_human_review') {
    return 'La ventana sigue con problemas de citas o claims sin cita tras el repair.'
  }
  if (repairStatus === 'json_repaired') {
    return 'La ventana necesitó reparación contractual de JSON, pero se recuperó correctamente.'
  }
  if (status === 'needs_citation_repair') {
    return 'La ventana necesitó repair por integridad de citas.'
  }
  if (status === 'too_compressed') {
    if (fallbackExtraction) {
      return 'La ventana quedó demasiado comprimida y terminó en fallback editorial.'
    }
    return 'La ventana quedó demasiado comprimida para un modo exhaustivo.'
  }
  if (status === 'too_verbose') {
    return 'La ventana quedó demasiado verbosa y empieza a parecer transcripción enriquecida.'
  }
  if (status === 'very_detailed') {
    return 'La ventana quedó especialmente detallada, pero dentro de un rango sano.'
  }
  if (!integrity.ok) {
    return 'La ventana tiene problemas de integridad de citas.'
  }
  return 'Ventana cubierta con detalle suficiente.'
}

function buildShortSummary(title: string, extraction: string): string {
  const bulletLines = extraction
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .slice(0, 4)

  return [`## Resumen breve`, `- ${title}`, '', ...bulletLines].join('\n').trim() + '\n'
}


function deriveQualityStatus({
  citationIntegrity,
  validation,
  coverage,
  hasCompressedWindows,
  hasNeedsHumanReviewWindows,
}: {
  citationIntegrity: CitationIntegrityReport
  validation: ValidationResult
  coverage: CoverageMetrics
  hasCompressedWindows: boolean
  hasNeedsHumanReviewWindows: boolean
}): SummaryQualityStatus {
  if (!citationIntegrity.ok || hasNeedsHumanReviewWindows) {
    return 'needs_human_review'
  }

  if (hasCompressedWindows || isTooCompressed(coverage)) {
    return 'too_compressed'
  }

  if (validation.metrics.unmatchedCount > 0) {
    return 'partially_grounded'
  }

  return 'grounded'
}

async function processWindow({
  window,
  observer,
}: {
  window: EvidenceWindow
  observer?: ProcessingStageObserver
}): Promise<{
  extraction: GroundedWindowExtraction
  integrity: CitationIntegrityReport
  status: WindowExtractionStatus
  generationStatus: WindowGenerationStatus
  repairStatus?: WindowRepairStatus
  failureKind?: WindowOutputFailureKind
  recoveryPath: RecoveryPathStep[]
  preservedPreviousExtraction?: boolean
  parseError?: string
  rawInvalidOutputPath?: string
  recoveredJsonPath?: string
  fallbackExtraction: boolean
  finalStatus: WindowFinalStatus
  coverage: WindowCoverageMetrics
  repairAttempts: number
  thinReasoningEvals?: ThinReasoningEvalBundle
}> {
  const allowedCitationIds = window.evidence.map((item) => item.citationId)
  const allowedCitationIdSet = new Set(allowedCitationIds)
  let repairAttempts = 0
  await observer?.log(`[window:${window.windowId}] start generation`)
  await observer?.snapshot('full_notes:window:generation:start', { windowId: window.windowId })
  const generationRawOutput = await runWithHeartbeat({
    observer,
    stage: 'full_notes:window:generation',
    metadata: { windowId: window.windowId },
    task: () => generateGroundedWindowExtractionResponse({ window }),
  })
  let generationResolution = await resolveWindowExtraction({
    stage: 'generation',
    rawOutput: generationRawOutput,
    window,
    allowedCitationIds,
    observer,
    generationStatusWhenOk: 'ok',
  })
  let extraction = generationResolution.extraction
  let thinReasoningEvals = generationResolution.thinReasoningEvals
  await observer?.snapshot('full_notes:window:generation:end', {
    windowId: window.windowId,
    noteBlocks: extraction.noteBlocks.length,
  })
  await observer?.log(`[window:${window.windowId}] generation done`)

  await observer?.log(`[window:${window.windowId}] start citation integrity`)
  await observer?.snapshot('full_notes:window:integrity:start', { windowId: window.windowId })
  let integrity = validateCitationIntegrity({ extraction, allowedCitationIds: allowedCitationIdSet })
  await observer?.snapshot('full_notes:window:integrity:end', {
    windowId: window.windowId,
    invalidCitationIds: integrity.invalidCitationIds.length,
    malformedCitations: integrity.malformedCitations.length,
    claimsWithoutCitation: integrity.claimsWithoutCitation.length,
  })
  await observer?.log(`[window:${window.windowId}] citation integrity done`)
  let status: WindowExtractionStatus = generationResolution.forcedNeedsReview
    ? 'needs_human_review'
    : integrity.ok
    ? classifyWindowCompression({ window, extraction, integrityOk: true })
    : 'needs_citation_repair'
  if (!generationResolution.forcedNeedsReview && (generationResolution.failureKind === 'low_content' || generationResolution.failureKind === 'thin_reasoning' || generationResolution.failureKind === 'closure_pollution' || generationResolution.failureKind === 'single_idea_collapse') && status === 'ok') {
    status = 'too_compressed'
  }
  let repairStatus: WindowRepairStatus = 'not_needed'
  let parseError = generationResolution.parseError
  let rawInvalidOutputPath = generationResolution.rawInvalidOutputPath
  let recoveredJsonPath = generationResolution.recoveredJsonPath
  let fallbackExtraction = generationResolution.fallbackExtraction
  let finalStatus: WindowFinalStatus = generationResolution.forcedNeedsReview ? 'needs_review' : 'grounded'
  let failureKind = generationResolution.failureKind
  let recoveryPath = [...generationResolution.recoveryPath]
  let preservedPreviousExtraction = generationResolution.preservedPreviousExtraction

  if (!generationResolution.forcedNeedsReview && !integrity.ok && MAX_CITATION_REPAIR_ATTEMPTS > 0) {
    repairAttempts = 1
    await observer?.log(`[window:${window.windowId}] start repair`)
    await observer?.snapshot('full_notes:window:repair:start', { windowId: window.windowId })
    const repairRawOutput = await runWithHeartbeat({
      observer,
      stage: 'full_notes:window:repair',
      metadata: { windowId: window.windowId },
      task: () =>
        repairInvalidCitationsResponse({
          originalExtraction: extraction,
          invalidCitationIds: integrity.invalidCitationIds,
          malformedCitations: integrity.malformedCitations,
          claimsWithoutCitation: integrity.claimsWithoutCitation,
          allowedWindow: window,
        }),
    })
    const repairResolution = await resolveWindowExtraction({
      stage: 'repair',
      rawOutput: repairRawOutput,
      window,
      allowedCitationIds,
      observer,
      generationStatusWhenOk: generationResolution.generationStatus,
      repairStatusWhenOk: 'ok',
      previousUsefulExtraction: {
        extraction,
        generationStatus: generationResolution.generationStatus,
        useful: extraction.noteBlocks.length > 0 && !fallbackExtraction,
      },
    })
    extraction = repairResolution.extraction
    integrity = validateCitationIntegrity({ extraction, allowedCitationIds: allowedCitationIdSet })
    repairStatus = repairResolution.repairStatus ?? 'ok'
    parseError = repairResolution.parseError ?? parseError
    rawInvalidOutputPath = repairResolution.rawInvalidOutputPath ?? rawInvalidOutputPath
    recoveredJsonPath = repairResolution.recoveredJsonPath ?? recoveredJsonPath
    fallbackExtraction = repairResolution.fallbackExtraction
    finalStatus = repairResolution.forcedNeedsReview ? 'needs_review' : finalStatus
    failureKind = repairResolution.failureKind ?? failureKind
    recoveryPath = repairResolution.recoveryPath
    preservedPreviousExtraction = repairResolution.preservedPreviousExtraction ?? preservedPreviousExtraction
    thinReasoningEvals = repairResolution.thinReasoningEvals ?? thinReasoningEvals
    generationResolution = {
      ...generationResolution,
      generationStatus: repairResolution.generationStatus,
    }
    status = repairResolution.forcedNeedsReview
      ? 'needs_human_review'
      : integrity.ok
      ? classifyWindowCompression({ window, extraction, integrityOk: true })
      : 'needs_human_review'
    if (!repairResolution.forcedNeedsReview && (repairResolution.failureKind === 'low_content' || repairResolution.failureKind === 'thin_reasoning' || repairResolution.failureKind === 'closure_pollution' || repairResolution.failureKind === 'single_idea_collapse') && status === 'ok') {
      status = 'too_compressed'
    }
    await observer?.snapshot('full_notes:window:repair:end', {
      windowId: window.windowId,
      invalidCitationIds: integrity.invalidCitationIds.length,
      malformedCitations: integrity.malformedCitations.length,
      claimsWithoutCitation: integrity.claimsWithoutCitation.length,
    })
    await observer?.log(`[window:${window.windowId}] repair done`)
  }

  const coverage = measureWindowCoverage({
    window,
    extraction,
    integrityOk: integrity.ok,
  })

  if (!generationResolution.forcedNeedsReview && !fallbackExtraction) {
    finalStatus = status === 'needs_human_review'
      ? 'needs_review'
      : status === 'too_compressed'
        ? 'partially_grounded'
        : 'grounded'
  }

  return {
    extraction,
    integrity,
    status,
    generationStatus: generationResolution.generationStatus,
    repairStatus,
    failureKind,
    recoveryPath,
    preservedPreviousExtraction,
    parseError,
    rawInvalidOutputPath,
    recoveredJsonPath,
    fallbackExtraction,
    finalStatus,
    coverage,
    repairAttempts,
    thinReasoningEvals,
  }
}

async function runWithHeartbeat<T>({
  observer,
  stage,
  metadata,
  task,
}: {
  observer?: ProcessingStageObserver
  stage: string
  metadata?: Record<string, unknown>
  task: () => Promise<T>
}): Promise<T> {
  const startedAt = Date.now()
  const timer = observer
    ? setInterval(() => {
        const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000)
        void observer.log(`[heartbeat] ${stage} still running... elapsed=${elapsedSeconds}s`)
        void observer.snapshot(`${stage}:heartbeat`, {
          ...metadata,
          elapsedSeconds,
        })
      }, HEARTBEAT_INTERVAL_MS)
    : undefined

  try {
    return await task()
  } finally {
    if (timer) {
      clearInterval(timer)
    }
  }
}

export async function generateExtractionForPart({
  transcription,
  chunks,
  partNumber,
  observer,
}: {
  transcription: string
  chunks: ChunkManifestChunk[]
  partNumber: number
  observer?: ProcessingStageObserver
}): Promise<ExtractionGenerationResult> {
  const part = String(partNumber).padStart(3, '0')
  const evidencePack = buildEvidenceWindows({
    part,
    chunks,
  })

  const windowResults = [] as Array<{
    window: EvidenceWindow
    extraction: GroundedWindowExtraction
    integrity: CitationIntegrityReport
    status: WindowExtractionStatus
    generationStatus: WindowGenerationStatus
    repairStatus?: WindowRepairStatus
    failureKind?: WindowOutputFailureKind
    recoveryPath: RecoveryPathStep[]
    preservedPreviousExtraction?: boolean
    parseError?: string
    rawInvalidOutputPath?: string
    recoveredJsonPath?: string
    fallbackExtraction: boolean
    finalStatus: WindowFinalStatus
    coverage: WindowCoverageMetrics
    repairAttempts: number
    thinReasoningEvals?: ThinReasoningEvalBundle
  }>

  for (const window of evidencePack.windows) {
    const processed = await processWindow({ window, observer })
    windowResults.push({
      window,
      extraction: processed.extraction,
      integrity: processed.integrity,
      status: processed.status,
      generationStatus: processed.generationStatus,
      repairStatus: processed.repairStatus,
      failureKind: processed.failureKind,
      recoveryPath: processed.recoveryPath,
      preservedPreviousExtraction: processed.preservedPreviousExtraction,
      parseError: processed.parseError,
      rawInvalidOutputPath: processed.rawInvalidOutputPath,
      recoveredJsonPath: processed.recoveredJsonPath,
      fallbackExtraction: processed.fallbackExtraction,
      finalStatus: processed.finalStatus,
      coverage: processed.coverage,
      repairAttempts: processed.repairAttempts,
      thinReasoningEvals: processed.thinReasoningEvals,
    })
  }

  await observer?.snapshot('full_notes:consolidation:start', { part })
  const consolidated = consolidateWindowExtractions({
    partNumber,
    windows: windowResults.map((result) => result.extraction),
  })
  await observer?.snapshot('full_notes:consolidation:end', {
    part,
    windows: windowResults.length,
    noteBlocks: consolidated.noteBlocks.length,
  })
  const extraction = normalizePartExtraction(partNumber, consolidated.extraction)
  const shortSummary = buildShortSummary(consolidated.title, consolidated.extraction)
  const coverage = buildCoverageMetrics({
    transcript: transcription,
    extraction,
    windows: evidencePack.windows,
    groundedWindows: windowResults.map((result) => result.extraction),
    allChunkIds: chunks.map((chunk) => chunk.chunkId),
  })

  const validation = validateExtractionContent({ transcription, extraction })
  const encounteredStrongFlags = [...validation.decision.strongFlags]
  const citationIntegrity = mergeIntegrity(windowResults.map((result) => result.integrity))
  const citationRepairAttempts = windowResults.reduce((sum, result) => sum + result.repairAttempts, 0)
  const hasCompressedWindows = windowResults.some((result) => result.status === 'too_compressed')
  const hasNeedsHumanReviewWindows = windowResults.some((result) => result.finalStatus === 'needs_review')

  const qualityStatus = deriveQualityStatus({
    citationIntegrity,
    validation,
    coverage,
    hasCompressedWindows,
    hasNeedsHumanReviewWindows,
  })

  const status: ValidationStatus = qualityStatus === 'needs_human_review' || validation.decision.action === 'reject_or_repair'
    ? 'failed'
    : citationRepairAttempts > 0
      ? 'repaired'
      : validation.decision.action === 'accept_with_warnings' || qualityStatus === 'too_compressed' || qualityStatus === 'partially_grounded'
        ? 'accepted_with_warnings'
        : 'accepted'

  return {
    content: extraction,
    shortSummary,
    title: consolidated.title,
    validation: buildReportPart(partNumber, status, validation, citationRepairAttempts, encounteredStrongFlags),
    evidencePack,
    groundedWindows: windowResults.map((result) => result.extraction),
    citationIntegrity,
    citationRepairAttempts,
    qualityStatus,
    coverage,
    windowReports: windowResults.map((result) => ({
      windowId: result.window.windowId,
      status: result.status,
      generationStatus: result.generationStatus,
      repairStatus: result.repairStatus,
      failureKind: result.failureKind,
      recoveryPath: result.recoveryPath,
      preservedPreviousExtraction: result.preservedPreviousExtraction,
      parseError: result.parseError,
      rawInvalidOutputPath: result.rawInvalidOutputPath,
      recoveredJsonPath: result.recoveredJsonPath,
      fallbackExtraction: result.fallbackExtraction,
        finalStatus: result.finalStatus,
        citationIntegrity: result.integrity,
        decisionReason: buildWindowDecisionReason({
          status: result.status,
          integrity: result.integrity,
          finalStatus: result.finalStatus,
          fallbackExtraction: result.fallbackExtraction,
          repairStatus: result.repairStatus,
          preservedPreviousExtraction: result.preservedPreviousExtraction,
        }),
      noteBlockCount: result.coverage.noteBlocksCount,
      extractionWordCount: result.coverage.outputWords,
      coverage: result.coverage,
      thinReasoningEvals: result.thinReasoningEvals,
    })),
  }
}

export function consolidateExtractions(extractions: string[]): string {
  const content = extractions
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n')

  return `${content.trim()}\n`
}
