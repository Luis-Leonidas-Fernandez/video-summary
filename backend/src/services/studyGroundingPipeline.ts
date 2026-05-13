import path from 'node:path'
import { appConfig } from '../config.js'
import { extractClaimsFromWindowExtractions, type StudyClaimsDocument } from './claimExtraction.js'
import { generateGroundingReport } from './groundingService.js'
import type {
  ChunkManifestChunk,
  ChunkManifestDocument,
  ClaimSupportReport,
  CitationIntegrityReport,
  CoverageGlobalStatus,
  CoverageLocalStatus,
  CoverageMetrics,
  EvidencePackDocument,
  GroundedWindowExtraction,
  GroundingMetrics,
  GroundingPartReport,
  GroundingPerformanceSummary,
  GroundingReport,
  ProcessingStageObserver,
  SummaryQualityStatus,
  ThinReasoningEvalBundle,
  WindowCoverageMetrics,
  WindowExtractionStatus,
  WindowOutputFailureKind,
  RecoveryPathStep,
  WorkerClaimSupportPart,
} from './groundingTypes.js'
import { renderEvidenceWindowMarkdown } from './evidenceWindowService.js'
import { writeJson, writeText } from '../utils/files.js'

export interface StudyGroundingPart {
  partNumber: number
  chunks: ChunkManifestChunk[]
}

export interface GroundingPartInput {
  partNumber: number
  groundedWindows: GroundedWindowExtraction[]
  evidencePack: EvidencePackDocument
  citationIntegrity: CitationIntegrityReport
  citationRepairAttempts: number
  coverage: CoverageMetrics
  windowReports: Array<{
    windowId: string
    status: WindowExtractionStatus
    generationStatus: 'ok' | 'repaired' | 'failed'
    repairStatus?: 'not_needed' | 'ok' | 'json_repaired' | 'failed'
    failureKind?: WindowOutputFailureKind
    recoveryPath: RecoveryPathStep[]
    preservedPreviousExtraction?: boolean
    parseError?: string
    rawInvalidOutputPath?: string
    recoveredJsonPath?: string
    fallbackExtraction?: boolean
    finalStatus: 'grounded' | 'partially_grounded' | 'needs_review'
    citationIntegrity: CitationIntegrityReport
    decisionReason: string
    noteBlockCount: number
    extractionWordCount: number
    coverage: WindowCoverageMetrics
    thinReasoningEvals?: ThinReasoningEvalBundle
  }>
}

const HEARTBEAT_INTERVAL_MS = 30_000

export function formatPartId(partNumber: number): string {
  return String(partNumber).padStart(3, '0')
}

export function formatChunkId(partNumber: number, chunkOrder: number): string {
  return `part_${formatPartId(partNumber)}:chunk_${String(chunkOrder).padStart(3, '0')}`
}

export function buildChunkManifest(jobId: string, studyParts: StudyGroundingPart[]): ChunkManifestDocument {
  return {
    jobId,
    parts: studyParts.map((part) => ({
      part: formatPartId(part.partNumber),
      chunks: part.chunks,
    })),
  }
}

function emptyClaimSupport(): ClaimSupportReport {
  return {
    supported: [],
    unsupported: [],
    partiallySupported: [],
  }
}

function buildCoverageGlobalStatus(coverage: CoverageMetrics): CoverageGlobalStatus {
  if (coverage.extractionToTranscriptRatio < appConfig.minExhaustiveWordRatio || coverage.chunkCoverageRatio < appConfig.minExhaustiveChunkCoverageRatio) {
    return 'too_short'
  }

  if (coverage.extractionToTranscriptRatio >= 0.75 && coverage.chunkCoverageRatio >= 1) {
    return 'high'
  }

  return 'acceptable'
}

function buildCoverageLocalStatus(windows: GroundingPartInput['windowReports']): CoverageLocalStatus {
  const compressedCount = windows.filter((window) => window.coverage.status === 'too_compressed').length

  if (compressedCount === 0) {
    return 'all_ok'
  }

  if (compressedCount >= Math.ceil(windows.length / 2)) {
    return 'many_windows_compressed'
  }

  return 'some_windows_compressed'
}

function buildDecisionReason(
  status: SummaryQualityStatus,
  integrity: CitationIntegrityReport,
  support: ClaimSupportReport,
  coverage: CoverageMetrics,
  coverageGlobalStatus: CoverageGlobalStatus,
  coverageLocalStatus: CoverageLocalStatus,
  windowsNeedingReview: number,
): string {
  if (status === 'needs_human_review') {
    const issues = [
      integrity.invalidCitationIds.length > 0 ? `${integrity.invalidCitationIds.length} citas inválidas` : null,
      integrity.malformedCitations.length > 0 ? `${integrity.malformedCitations.length} citas mal formadas` : null,
      integrity.claimsWithoutCitation.length > 0 ? `${integrity.claimsWithoutCitation.length} claims sin cita` : null,
      windowsNeedingReview > 0 ? `${windowsNeedingReview} ventanas requieren revisión` : null,
    ].filter(Boolean).join(', ')
    return issues || 'La integridad de citas falló y requiere revisión humana.'
  }

  if (status === 'too_compressed') {
    return `Extracción demasiado comprimida: ratio de palabras ${Math.round(coverage.extractionToTranscriptRatio * 100)}% y cobertura de chunks ${Math.round(coverage.chunkCoverageRatio * 100)}%.`
  }

  if (coverageGlobalStatus === 'high' && coverageLocalStatus !== 'all_ok') {
    return 'Cobertura global alta, pero varias ventanas quedaron comprimidas.'
  }

  if (status === 'failed_grounding') {
    return `${support.unsupported.length} claims sin soporte suficiente.`
  }

  if (status === 'partially_grounded') {
    return `${support.unsupported.length} claims sin soporte suficiente y ${support.partiallySupported.length} parcialmente respaldados.`
  }

  return 'Resumen verificado con evidencia suficiente y cobertura alta.'
}

function buildMetrics({
  totalClaims,
  citationIntegrity,
  support,
  repairedCitationCount,
  finalStatus,
}: {
  totalClaims: number
  citationIntegrity: CitationIntegrityReport
  support: ClaimSupportReport
  repairedCitationCount: number
  finalStatus: SummaryQualityStatus
}): GroundingMetrics {
  return {
    totalClaims,
    claimsWithCitation: Math.max(0, totalClaims - citationIntegrity.claimsWithoutCitation.length),
    claimsWithoutCitation: citationIntegrity.claimsWithoutCitation.length,
    invalidCitationCount: citationIntegrity.invalidCitationIds.length + citationIntegrity.malformedCitations.length,
    unsupportedClaimCount: support.unsupported.length,
    repairedCitationCount,
    finalStatus,
  }
}

function determineFinalStatus({
  citationIntegrity,
  support,
  coverage,
  windows,
}: {
  citationIntegrity: CitationIntegrityReport
  support: ClaimSupportReport
  coverage: CoverageMetrics
  windows: GroundingPartInput['windowReports']
}): SummaryQualityStatus {
  if (!citationIntegrity.ok || windows.some((window) => window.finalStatus === 'needs_review')) {
    return 'needs_human_review'
  }

  if (coverage.extractionToTranscriptRatio < appConfig.minExhaustiveWordRatio || coverage.chunkCoverageRatio < appConfig.minExhaustiveChunkCoverageRatio) {
    return 'too_compressed'
  }

  if (support.unsupported.length > 0 && support.supported.length === 0 && support.partiallySupported.length === 0) {
    return 'failed_grounding'
  }

  if (support.unsupported.length > 0 || support.partiallySupported.length > 0) {
    return 'partially_grounded'
  }

  return 'grounded'
}

function buildPartReport({
  part,
  totalClaims,
  citationIntegrity,
  support,
  repairedCitationCount,
  coverage,
  windows,
}: {
  part: string
  totalClaims: number
  citationIntegrity: CitationIntegrityReport
  support: ClaimSupportReport
  repairedCitationCount: number
  coverage: CoverageMetrics
  windows: GroundingPartInput['windowReports']
}): GroundingPartReport {
  const finalStatus = determineFinalStatus({ citationIntegrity, support, coverage, windows })
  const coverageGlobalStatus = buildCoverageGlobalStatus(coverage)
  const coverageLocalStatus = buildCoverageLocalStatus(windows)
  const avgWordsPerWindow = windows.length > 0
    ? Number((windows.reduce((sum, window) => sum + window.extractionWordCount, 0) / windows.length).toFixed(1))
    : 0
  const windowsTooCompressed = windows.filter((window) => window.coverage.status === 'too_compressed').length
  const windowsVeryDetailed = windows.filter((window) => window.coverage.status === 'very_detailed').length
  const windowsTooVerbose = windows.filter((window) => window.coverage.status === 'too_verbose').length
  const windowsFellBack = windows.filter((window) => window.fallbackExtraction).length
  const fallbackRate = windows.length > 0 ? Number((windowsFellBack / windows.length).toFixed(3)) : 0
  const recoveryMetrics = {
    windowsRecoveredLocally: windows.filter((window) =>
      window.generationStatus === 'repaired'
      && !window.recoveryPath.includes('contract_repair')
      && !window.recoveryPath.includes('simple_draft_contract_repair')
      && !window.recoveryPath.includes('strict_reemit')
      && !window.fallbackExtraction,
    ).length,
    windowsRecoveredByContractRepair: windows.filter((window) =>
      (window.recoveryPath.includes('contract_repair') || window.recoveryPath.includes('simple_draft_contract_repair'))
      && !window.fallbackExtraction,
    ).length,
    windowsRecoveredByStrictReemit: windows.filter((window) =>
      window.recoveryPath.includes('strict_reemit') && !window.fallbackExtraction,
    ).length,
    windowsPreservedAfterRepairFailure: windows.filter((window) => window.preservedPreviousExtraction).length,
    windowsFellBack,
  }
  const rejectedWindows = windows.filter((window) =>
    window.finalStatus === 'needs_review' || Boolean(window.failureKind),
  )
  const rejectedWindowMetrics = {
    languageDrift: rejectedWindows.filter((window) => window.failureKind === 'language_drift').length,
    lowContent: rejectedWindows.filter((window) => window.failureKind === 'low_content').length,
    thinReasoning: rejectedWindows.filter((window) => window.failureKind === 'thin_reasoning').length,
    closurePollution: rejectedWindows.filter((window) => window.failureKind === 'closure_pollution').length,
    singleIdeaCollapse: rejectedWindows.filter((window) => window.failureKind === 'single_idea_collapse').length,
    schemaBroken: rejectedWindows.filter((window) =>
      window.failureKind === 'empty_blocks'
      || window.failureKind === 'json_syntax'
      || window.failureKind === 'markdown_wrapped'
      || window.failureKind === 'mixed_markdown_json'
      || window.failureKind === 'pseudo_json_object_keys'
      || window.failureKind === 'alternate_schema'
      || window.failureKind === 'truncated_json'
      || window.failureKind === 'non_json_text',
    ).length,
    fallbackLike: rejectedWindows.filter((window) => window.failureKind === 'technical_fallback_like_output').length,
    mixedMarkdownJson: rejectedWindows.filter((window) => window.failureKind === 'mixed_markdown_json').length,
    alternateSchema: rejectedWindows.filter((window) => window.failureKind === 'alternate_schema').length,
    unknown: rejectedWindows.filter((window) => !window.failureKind || window.failureKind === 'unknown').length,
  }
  const semanticRecoveryMetrics = {
    windowsEnrichmentAttempted: windows.filter((window) => window.recoveryPath.includes('semantic_enrichment')).length,
    windowsEnrichedSemantically: windows.filter((window) => window.recoveryPath.includes('semantic_enrichment') && window.generationStatus === 'repaired' && !window.fallbackExtraction).length,
    windowsStillCompressedAfterEnrichment: windows.filter((window) => window.recoveryPath.includes('semantic_enrichment') && window.coverage.status === 'too_compressed').length,
  }

  return {
    part,
    citationIntegrity,
    claimSupport: support,
    coverage,
    coverageGlobalStatus,
    coverageLocalStatus,
    metrics: buildMetrics({
      totalClaims,
      citationIntegrity,
      support,
      repairedCitationCount,
      finalStatus,
    }),
    windows,
    avgWordsPerWindow,
    windowsTooCompressed,
    windowsVeryDetailed,
    windowsTooVerbose,
    fallbackRate,
    recoveryMetrics,
    rejectedWindowMetrics,
    semanticRecoveryMetrics,
    finalStatus,
    decisionReason: buildDecisionReason(
      finalStatus,
      citationIntegrity,
      support,
      coverage,
      coverageGlobalStatus,
      coverageLocalStatus,
      windows.filter((window) => window.finalStatus === 'needs_review').length,
    ),
  }
}

async function writePartDocuments({
  outputDir,
  parts,
}: {
  outputDir: string
  parts: GroundingPartInput[]
}): Promise<StudyClaimsDocument[]> {
  const claimsDocuments = parts.map((part) =>
    extractClaimsFromWindowExtractions({
      partNumber: part.partNumber,
      windows: part.groundedWindows,
      evidence: part.evidencePack.windows.flatMap((window) => window.evidence.map((item) => ({ ...item, windowId: window.windowId }))),
    }),
  )

  await Promise.all(
    parts.flatMap((part, index) => [
      writeJson(path.join(outputDir, `claims_part_${formatPartId(part.partNumber)}.json`), claimsDocuments[index]),
      writeJson(path.join(outputDir, `evidence_part_${formatPartId(part.partNumber)}.json`), part.evidencePack),
      writeText(
        path.join(outputDir, `evidence_pack_part_${formatPartId(part.partNumber)}.md`),
        part.evidencePack.windows.map((window) => renderEvidenceWindowMarkdown(window)).join('\n\n'),
      ),
      writeJson(path.join(outputDir, `citation_integrity_part_${formatPartId(part.partNumber)}.json`), part.citationIntegrity),
    ]),
  )

  return claimsDocuments
}

function supportMap(parts: WorkerClaimSupportPart[]): Map<string, ClaimSupportReport> {
  return new Map(parts.map((part) => [part.part, part.claimSupport]))
}

export async function generateGroundingArtifacts({
  jobId,
  outputDir,
  studyParts,
  parts,
  log,
  signal,
  observer,
  performanceContext,
}: {
  jobId: string
  outputDir: string
  studyParts: StudyGroundingPart[]
  parts: GroundingPartInput[]
  log: (message: string) => Promise<void>
  signal?: AbortSignal
  observer?: ProcessingStageObserver
  performanceContext?: Omit<GroundingPerformanceSummary, 'unsupportedClaimCount'>
}): Promise<GroundingReport> {
  const chunkManifestPath = path.join(outputDir, 'chunk_manifest.json')
  const groundingReportPath = path.join(outputDir, 'grounding_report.json')

  const chunkManifest = buildChunkManifest(jobId, studyParts)
  await writeJson(chunkManifestPath, chunkManifest)

  const claimsDocuments = await writePartDocuments({ outputDir, parts })
  const eligibleParts = parts.filter((part) => part.citationIntegrity.ok)

  let supportByPart = new Map<string, ClaimSupportReport>()
  let workerFailedMessage: string | null = null
  if (eligibleParts.length > 0) {
    try {
      const workerReport = await runWithHeartbeat({
        observer,
        stage: 'grounding',
        metadata: { eligibleParts: eligibleParts.length },
        task: () =>
          generateGroundingReport({
            jobId,
            outputDir,
            manifestPath: chunkManifestPath,
            claimsPaths: eligibleParts.map((part) => path.join(outputDir, `claims_part_${formatPartId(part.partNumber)}.json`)),
            log,
            signal,
          }),
      })
      supportByPart = supportMap(workerReport.parts)
    } catch (error) {
      workerFailedMessage = error instanceof Error ? error.message : 'Error desconocido en grounding.'
      await log(`Grounding semántico no disponible; las partes elegibles pasan a revisión humana. Motivo: ${workerFailedMessage}`)
    }
  }

  const partsReport = parts.map((part, index) => {
    const support = supportByPart.get(formatPartId(part.partNumber)) ?? emptyClaimSupport()
    const partReport = buildPartReport({
      part: claimsDocuments[index].part,
      totalClaims: claimsDocuments[index].claims.length,
      citationIntegrity: part.citationIntegrity,
      support,
      repairedCitationCount: part.citationRepairAttempts,
      coverage: part.coverage,
      windows: part.windowReports,
    })

    if (workerFailedMessage && part.citationIntegrity.ok) {
      return {
        ...partReport,
        finalStatus: 'needs_human_review' as SummaryQualityStatus,
        metrics: {
          ...partReport.metrics,
          finalStatus: 'needs_human_review' as SummaryQualityStatus,
        },
        decisionReason: `Grounding semántico no disponible: ${workerFailedMessage}`,
      }
    }

    return partReport
  })

  const report: GroundingReport = {
    parts: partsReport,
    performanceSummary: performanceContext
      ? {
          ...performanceContext,
          unsupportedClaimCount: partsReport.reduce((sum, part) => sum + part.metrics.unsupportedClaimCount, 0),
        }
      : undefined,
  }

  await writeJson(groundingReportPath, report)
  await log(`Grounding por claims guardado en ${groundingReportPath}.`)
  return report
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
  await observer?.snapshot(`${stage}:start`, metadata)
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
    await observer?.snapshot(`${stage}:end`, metadata)
  }
}
