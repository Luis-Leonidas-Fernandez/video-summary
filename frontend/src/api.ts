export type JobStatus =
  | 'pending'
  | 'cancelling'
  | 'cancelled'
  | 'downloading'
  | 'transcribing'
  | 'translating'
  | 'summarizing'
  | 'completed'
  | 'completed_with_warnings'
  | 'failed';

export type JobLanguage = string;

export interface CreateJobPayload {
  url: string;
  language: JobLanguage;
  generateTranscription: boolean;
  generateTranslation: boolean;
  generateSummary: boolean;
  speakerCountHint?: number;
  reuseFromJobId?: string;
}

export interface JobFile {
  name: string;
  path: string;
  size: number;
  createdAt: string;
  downloadUrl: string;
}

export interface JobResourceUsage {
  durationMs: number;
  peakRssMb: number;
  peakCpuPercent: number;
  finalRssMb: number;
  finalCpuPercent: number;
  peakProcessCount: number;
  finalProcessCount: number;
  monitoringError?: string;
}

export interface JobResponse {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: JobStatus;
  url: string;
  language: JobLanguage;
  generateTranscription: boolean;
  generateTranslation: boolean;
  generateSummary: boolean;
  speakerCountHint?: number;
  reusedFromJobId?: string;
  outputDir: string;
  files: JobFile[];
  logs: string[];
  logCount: number;
  logsTruncated: boolean;
  resourceUsage?: JobResourceUsage;
  error?: string;
  progress?: number;
}

export interface ValidationReportPart {
  part: string;
  status: 'accepted' | 'accepted_with_warnings' | 'repaired' | 'failed';
  decisionReason: string;
  metrics: {
    headingCount: number;
    unmatchedCount: number;
    unmatchedRatio: number;
    semanticMatchRatio: number;
    strongDerivaDetected: boolean;
  };
  matches: Array<{
    label: string;
    normalizedLabel: string;
    matchType: 'literal_match' | 'alias_match' | 'semantic_heading_match' | 'unmatched';
    reason: string;
  }>;
  warnings: string[];
  strongFlags: string[];
  repairAttempts: number;
}

export interface ValidationReport {
  parts: ValidationReportPart[];
}

export interface GroundingClaimResult {
  id: string;
  section: string;
  text: string;
  citations: string[];
  evidence: Array<{
    citationId: string;
    chunkId: string;
    score: number;
    quote: string;
  }>;
  reason: string;
}

export interface GroundingReportPart {
  part: string;
  citationIntegrity: {
    ok: boolean;
    invalidCitationIds: string[];
    malformedCitations: string[];
    claimsWithoutCitation: Array<{
      claimText: string;
      section?: string;
    }>;
  };
  claimSupport: {
    supported: GroundingClaimResult[];
    unsupported: GroundingClaimResult[];
    partiallySupported: GroundingClaimResult[];
  };
  coverage: {
    transcriptWords: number;
    extractionWords: number;
    extractionToTranscriptRatio: number;
    totalChunksInPart: number;
    chunksIncludedInWindows: number;
    chunkCoverageRatio: number;
    chunksWithNoClaims: string[];
  };
  coverageGlobalStatus: 'acceptable' | 'high' | 'too_short';
  coverageLocalStatus: 'all_ok' | 'some_windows_compressed' | 'many_windows_compressed';
  metrics: {
    totalClaims: number;
    claimsWithCitation: number;
    claimsWithoutCitation: number;
    invalidCitationCount: number;
    unsupportedClaimCount: number;
    repairedCitationCount: number;
    finalStatus: 'grounded' | 'partially_grounded' | 'failed_grounding' | 'needs_human_review' | 'too_compressed';
  };
  windows: Array<{
    windowId: string;
    status: 'ok' | 'too_compressed' | 'very_detailed' | 'too_verbose' | 'needs_citation_repair' | 'needs_human_review';
    generationStatus: 'ok' | 'repaired' | 'failed';
    repairStatus?: 'not_needed' | 'ok' | 'json_repaired' | 'failed';
    failureKind?:
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
      | 'unknown';
    recoveryPath: Array<
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
    >;
    preservedPreviousExtraction?: boolean;
    parseError?: string;
    rawInvalidOutputPath?: string;
    recoveredJsonPath?: string;
    fallbackExtraction?: boolean;
    finalStatus: 'grounded' | 'partially_grounded' | 'needs_review';
    decisionReason: string;
    noteBlockCount: number;
    extractionWordCount: number;
    coverage: {
      windowId: string;
      inputWords: number;
      outputWords: number;
      outputToInputRatio: number;
      noteBlocksCount: number;
      status: 'too_compressed' | 'ok' | 'very_detailed' | 'too_verbose' | 'needs_review';
    };
  }>;
  avgWordsPerWindow: number;
  windowsTooCompressed: number;
  windowsVeryDetailed: number;
  windowsTooVerbose: number;
  fallbackRate?: number;
  recoveryMetrics?: {
    windowsRecoveredLocally: number;
    windowsRecoveredByContractRepair: number;
    windowsRecoveredByStrictReemit: number;
    windowsPreservedAfterRepairFailure: number;
    windowsFellBack: number;
  };
  rejectedWindowMetrics?: {
    languageDrift: number;
    lowContent: number;
    thinReasoning: number;
    closurePollution: number;
    singleIdeaCollapse: number;
    schemaBroken: number;
    fallbackLike: number;
    mixedMarkdownJson: number;
    alternateSchema: number;
    unknown: number;
  };
  semanticRecoveryMetrics?: {
    windowsEnrichmentAttempted: number;
    windowsEnrichedSemantically: number;
    windowsStillCompressedAfterEnrichment: number;
  };
  finalStatus: 'grounded' | 'partially_grounded' | 'failed_grounding' | 'needs_human_review' | 'too_compressed';
  decisionReason: string;
}

export interface GroundingReport {
  parts: GroundingReportPart[];
  performanceSummary?: {
    ramPeakTrackedMb: number;
    ramPeakSystemApproxMb?: number;
    fullNotesDurationMs: number;
    groundingDurationMs: number;
    unsupportedClaimCount: number;
    windowsTooCompressed: number;
  };
}

export type AiRuntimeStatus =
  | 'offline'
  | 'starting'
  | 'ready'
  | 'busy'
  | 'idle'
  | 'stopping'
  | 'error';

export interface HealthResponse {
  ok: true;
  ollamaBaseUrl: string;
  ollamaModel: 'gemma3:12b';
  aiRuntime: AiRuntimeStatus;
  ownedByCurrentSession: boolean;
  activeJobsCount: number;
  idleShutdownMs: number;
  lastActivityAt?: string;
  nextShutdownAt?: string;
}

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(error?.error ?? 'Ocurrió un error inesperado en la API.');
  }

  return response.json() as Promise<T>;
}

export async function createJob(payload: CreateJobPayload): Promise<JobResponse> {
  const response = await fetch('/api/jobs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return parseJson<JobResponse>(response);
}

export async function getJob(jobId: string): Promise<JobResponse> {
  const response = await fetch(`/api/jobs/${jobId}`);
  return parseJson<JobResponse>(response);
}

export async function getJobFiles(jobId: string): Promise<JobFile[]> {
  const response = await fetch(`/api/jobs/${jobId}/files`);
  return parseJson<JobFile[]>(response);
}

export async function getJobFileContent(jobId: string, fileName: string): Promise<string> {
  const response = await fetch(`/api/jobs/${jobId}/files/${encodeURIComponent(fileName)}`);

  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(error?.error ?? 'No se pudo leer el archivo solicitado.');
  }

  return response.text();
}

export async function getHealth(): Promise<HealthResponse> {
  const response = await fetch('/api/health');
  return parseJson<HealthResponse>(response);
}

export async function cancelJob(jobId: string): Promise<JobResponse> {
  const response = await fetch(`/api/jobs/${jobId}/cancel`, {
    method: 'POST',
  });

  return parseJson<JobResponse>(response);
}
