export type SummaryQualityStatus = 'grounded' | 'partially_grounded' | 'failed_grounding' | 'needs_human_review' | 'too_compressed'
export type StudyOutputMode = 'exhaustive_notes' | 'short_summary'
export type WindowCoverageStatus = 'too_compressed' | 'ok' | 'very_detailed' | 'too_verbose' | 'needs_review'
export type CoverageGlobalStatus = 'acceptable' | 'high' | 'too_short'
export type CoverageLocalStatus = 'all_ok' | 'some_windows_compressed' | 'many_windows_compressed'
export type JobFinalStatus = 'completed' | 'completed_with_warnings' | 'failed'
export type WindowOutputFailureKind =
  | 'empty_blocks'
  | 'json_syntax'
  | 'markdown_wrapped'
  | 'mixed_markdown_json'
  | 'pseudo_json_object_keys'
  | 'alternate_schema'
  | 'truncated_json'
  | 'non_json_text'
  | 'language_drift'
  | 'low_content'
  | 'thin_reasoning'
  | 'closure_pollution'
  | 'single_idea_collapse'
  | 'technical_fallback_like_output'
  | 'unknown'
export type RecoveryPathStep =
  | 'local_parse'
  | 'jsonrepair'
  | 'simple_draft_parse'
  | 'contract_repair'
  | 'simple_draft_contract_repair'
  | 'strict_reemit'
  | 'semantic_enrichment'
  | 'preserve_previous_extraction'
  | 'fallback_editorial'
  | 'fallback_raw'
export type WindowExtractionStatus =
  | 'ok'
  | 'too_compressed'
  | 'very_detailed'
  | 'too_verbose'
  | 'needs_citation_repair'
  | 'needs_human_review'
export type WindowGenerationStatus = 'ok' | 'repaired' | 'failed'
export type WindowRepairStatus = 'not_needed' | 'ok' | 'json_repaired' | 'failed'
export type WindowFinalStatus = 'grounded' | 'partially_grounded' | 'needs_review'
export type NoteBlockCoverageType = 'definition' | 'explanation' | 'example' | 'argument' | 'sequence' | 'detail'

export interface ChunkManifestChunk {
  chunkId: string
  part: string
  order: number
  audioPath: string
  transcriptionPath: string
  text: string
  startSeconds: number
  endSeconds: number
  overlapDetected?: boolean
  speakerCountHint?: number
  transcriptionConfidence?: 'normal' | 'lower'
  overlapRiskScore?: number
  overlapSignals?: string[]
}

export interface ChunkManifestPart {
  part: string
  chunks: ChunkManifestChunk[]
}

export interface ChunkManifestDocument {
  jobId: string
  parts: ChunkManifestPart[]
}

export interface EvidenceChunk {
  citationId: string
  sourceChunkId: string
  text: string
  role: 'primary' | 'overlap_context'
  source?: string
  score?: number
  overlapDetected?: boolean
  speakerCountHint?: number
  transcriptionConfidence?: 'normal' | 'lower'
  overlapRiskScore?: number
  overlapSignals?: string[]
}

export interface EvidenceWindow {
  windowId: string
  part: string
  chunkRange: {
    from: string
    to: string
  }
  evidence: EvidenceChunk[]
  overlapDetected?: boolean
  speakerCountHint?: number
  transcriptionConfidence?: 'normal' | 'lower'
  overlapChunkCount?: number
}

export interface EvidencePackDocument {
  part: string
  windows: EvidenceWindow[]
}

export interface NoteBlock {
  heading: string
  content: string
  citations: string[]
  coverageType: NoteBlockCoverageType
}

export interface GroundedWindowExtraction {
  windowId: string
  noteBlocks: NoteBlock[]
  insufficientEvidenceClaims: Array<{
    claim: string
    section?: string
  }>
}

export interface CitationIntegrityIssueClaim {
  claimText: string
  section?: string
}

export interface CitationIntegrityReport {
  ok: boolean
  invalidCitationIds: string[]
  malformedCitations: string[]
  claimsWithoutCitation: CitationIntegrityIssueClaim[]
}

export interface WindowCompressionMetrics {
  noteBlockCount: number
  outputWords: number
}

export interface WindowCoverageMetrics {
  windowId: string
  inputWords: number
  outputWords: number
  outputToInputRatio: number
  compressionThresholdApplied: number
  noteBlocksCount: number
  status: WindowCoverageStatus
}

export interface ThinReasoningEvalCheck {
  name: string
  passed: boolean
  detail: string
}

export type ReasoningSignal =
  | 'contrast'
  | 'objection'
  | 'response'
  | 'example'
  | 'historical_context'
  | 'causal'

export interface RewriteEval {
  materialImprovement: boolean
  resolvedCriticalPrioritiesCount: number
  lostSignals: ReasoningSignal[]
  addedUnsupportedClaims: boolean
  citationIntegrityOk: boolean
  decision: 'accept' | 'reject'
}

export interface ThinReasoningEvalResult {
  stage: 'plan' | 'critique' | 'rewrite'
  passed: boolean
  score: number
  checks: ThinReasoningEvalCheck[]
  summary: string
  rewriteEval?: RewriteEval
}

export interface ThinReasoningEvalBundle {
  plan: ThinReasoningEvalResult
  critique: ThinReasoningEvalResult
  rewrite?: ThinReasoningEvalResult
  execution?: {
    plannerRan: boolean
    plannerRepaired: boolean
    critiqueRan: boolean
    rewriteRan: boolean
    rewriteRejected: boolean
    resolveRan?: boolean
    rewriteControlledRan?: boolean
    resolvedChangeCount?: number
    appliedChangeCount?: number
    effectiveAppliedChangeCount?: number
    effectiveTargetSignalRestoreCount?: number
    rejectedChangeCount?: number
    experimentalRewriteAccepted?: boolean
  }
}

export interface GroundingEvidence {
  citationId: string
  chunkId: string
  score: number
  quote: string
}

export interface GroundingClaimResult {
  id: string
  section: string
  text: string
  citations: string[]
  evidence: GroundingEvidence[]
  reason: string
}

export interface ClaimSupportReport {
  supported: GroundingClaimResult[]
  unsupported: GroundingClaimResult[]
  partiallySupported: GroundingClaimResult[]
}

export interface CoverageMetrics {
  transcriptWords: number
  extractionWords: number
  extractionToTranscriptRatio: number
  totalChunksInPart: number
  chunksIncludedInWindows: number
  chunkCoverageRatio: number
  chunksWithNoClaims: string[]
}

export interface GroundingMetrics {
  totalClaims: number
  claimsWithCitation: number
  claimsWithoutCitation: number
  invalidCitationCount: number
  unsupportedClaimCount: number
  repairedCitationCount: number
  finalStatus: SummaryQualityStatus
}

export interface GroundingWindowReport {
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
  noteBlockCount: number
  extractionWordCount: number
  coverage: WindowCoverageMetrics
  thinReasoningEvals?: ThinReasoningEvalBundle
  decisionReason: string
  citationIntegrity: CitationIntegrityReport
}

export interface GroundingPartReport {
  part: string
  citationIntegrity: CitationIntegrityReport
  claimSupport: ClaimSupportReport
  coverage: CoverageMetrics
  coverageGlobalStatus: CoverageGlobalStatus
  coverageLocalStatus: CoverageLocalStatus
  metrics: GroundingMetrics
  windows: GroundingWindowReport[]
  avgWordsPerWindow: number
  windowsTooCompressed: number
  windowsVeryDetailed: number
  windowsTooVerbose: number
  fallbackRate: number
  recoveryMetrics: {
    windowsRecoveredLocally: number
    windowsRecoveredByContractRepair: number
    windowsRecoveredByStrictReemit: number
    windowsPreservedAfterRepairFailure: number
    windowsFellBack: number
  }
  rejectedWindowMetrics: {
    languageDrift: number
    lowContent: number
    thinReasoning: number
    closurePollution: number
    singleIdeaCollapse: number
    schemaBroken: number
    fallbackLike: number
    mixedMarkdownJson: number
    alternateSchema: number
    unknown: number
  }
  semanticRecoveryMetrics?: {
    windowsEnrichmentAttempted: number
    windowsEnrichedSemantically: number
    windowsStillCompressedAfterEnrichment: number
  }
  finalStatus: SummaryQualityStatus
  decisionReason: string
}

export interface GroundingPerformanceSummary {
  ramPeakTrackedMb: number
  ramPeakSystemApproxMb?: number
  fullNotesDurationMs: number
  groundingDurationMs: number
  unsupportedClaimCount: number
  windowsTooCompressed: number
}

export interface GroundingReport {
  parts: GroundingPartReport[]
  performanceSummary?: GroundingPerformanceSummary
}

export interface WorkerClaimSupportPart {
  part: string
  claimSupport: ClaimSupportReport
}

export interface WorkerGroundingReport {
  parts: WorkerClaimSupportPart[]
}

export interface ProcessingStageObserver {
  log: (message: string) => Promise<void>
  snapshot: (stage: string, metadata?: Record<string, unknown>) => Promise<void>
  writeArtifact?: (fileName: string, content: string) => Promise<string>
}
