import { resolveApiUrl } from './desktop';

export type JobStatus =
  | 'pending'
  | 'queued'
  | 'resolving_sources'
  | 'processing'
  | 'downloading'
  | 'transcribing'
  | 'translating'
  | 'summarizing'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'completed_with_warnings'
  | 'failed';

export type ItemStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'warning';
export type JobLanguage = string;
export type JobInputMode = 'single_url' | 'url_list' | 'playlist';
export type BatchFailurePolicy = 'continue_on_item_failure' | 'fail_fast';
export type TranscriptionQuality = 'ok' | 'suspicious' | 'poor';
export type GroundingStatus = 'grounded' | 'partially_grounded' | 'failed_grounding' | 'needs_human_review' | 'too_compressed' | 'legacy_warning' | 'unknown';
export type ResourceUsageScope = 'batch_aggregate' | 'last_item' | 'single_item';
export type TranslationStatus = 'reused_spanish_transcription' | 'translated_to_spanish' | 'skipped';

export type CreateJobPayload = {
  language?: JobLanguage;
  transcriptionLanguage?: JobLanguage;
  outputLanguage?: JobLanguage;
  generateTranscription: boolean;
  generateTranslation: boolean;
  generateSummary: boolean;
  speakerCountHint?: number;
  reuseFromJobId?: string;
} & (
  | { url: string; urls?: never; playlistUrl?: never }
  | { url?: never; urls: string[]; playlistUrl?: never }
  | { url?: never; urls?: never; playlistUrl: string }
);

export interface JobOriginalInput {
  url?: string;
  urls?: string[];
  playlistUrl?: string;
}

export interface JobFile {
  itemId?: string;
  name: string;
  filename: string;
  relativePath: string;
  path: string;
  size: number;
  createdAt: string;
  downloadUrl: string;
  mimeType?: string;
  kind?: 'transcript' | 'summary' | 'grounding' | 'audio' | 'video' | 'log' | 'report' | 'other';
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

export type ModelSelectionSource = 'runtime_state' | 'env';

export interface JobModelMetadata {
  ollamaModelUsed: string;
  modelSelectionSource: ModelSelectionSource;
}

export interface BatchJobItem {
  itemId: string;
  index: number;
  sourceUrl: string;
  normalizedUrl: string;
  sourceType: 'single' | 'batch_list' | 'playlist';
  status: ItemStatus;
  outputDir: string;
  files: JobFile[];
  error?: string;
  warnings?: string[];
  progress?: number;
  startedAt?: string;
  completedAt?: string;
  itemWallClockMs?: number;
  currentStage?: 'pending' | 'processing' | 'downloading' | 'transcribing' | 'translating' | 'summarizing';
  resourceUsage?: JobResourceUsage;
  transcriptionQuality?: TranscriptionQuality;
  groundingStatus?: GroundingStatus;
  groundingDecisionReason?: string;
  detectedSourceLanguage?: string;
  translationStatus?: TranslationStatus;
  claimsValidated?: number;
  unsupportedClaimCount?: number;
  invalidCitationCount?: number;
  windowsTooCompressed?: number;
}

export interface JobBatchSummary {
  totalItems: number;
  completedItems: number;
  failedItems: number;
  cancelledItems: number;
  pendingItems: number;
  warningItems: number;
  activeItemId?: string;
}

export interface JobResponse {
  schemaVersion?: number;
  id: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  batchWallClockMs?: number;
  resourceUsageScope?: ResourceUsageScope;
  status: JobStatus;
  url: string;
  inputMode?: JobInputMode;
  originalInput?: JobOriginalInput;
  sourceUrls?: string[];
  resolvedAt?: string;
  resolutionError?: string;
  failurePolicy?: BatchFailurePolicy;
  language: JobLanguage;
  transcriptionLanguage: JobLanguage;
  outputLanguage: JobLanguage;
  generateTranscription: boolean;
  generateTranslation: boolean;
  generateSummary: boolean;
  speakerCountHint?: number;
  reusedFromJobId?: string;
  outputDir: string;
  files: JobFile[];
  items?: BatchJobItem[];
  summary?: JobBatchSummary;
  logs: string[];
  logCount: number;
  logsTruncated: boolean;
  resourceUsage?: JobResourceUsage;
  modelMetadata?: JobModelMetadata;
  detectedSourceLanguage?: string;
  translationStatus?: TranslationStatus;
  error?: string;
  progress?: number;
}

export interface LocalModelInfo {
  name: string;
  digest?: string;
  size?: number;
  modifiedAt?: string;
  family?: 'llm' | 'embedding' | 'unknown';
  selectable: boolean;
  unselectableReason?: 'embedding_model' | 'unknown_family';
}

export interface ModelSelectionResponse {
  activeModel: string;
  defaultModel: string;
  source: ModelSelectionSource;
  activeModelAvailable: boolean;
  availableModels: LocalModelInfo[];
  ollamaBaseUrl: string;
  catalogReachable: boolean;
  catalogModelCount: number;
  warning?: string;
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
    finalStatus?: 'accepted' | 'accepted_with_warnings' | 'needs_review';
    fallbackExtraction?: boolean;
    decisionReason?: string;
    coverage: {
      status: 'ok' | 'too_compressed' | 'very_detailed' | 'too_verbose' | 'needs_review';
      inputWords: number;
      outputWords: number;
    };
  }>;
  windowsTooCompressed: number;
  fallbackRate?: number;
  rejectedWindowMetrics?: {
    schemaBroken?: number;
    thinReasoning?: number;
  };
  finalStatus: 'grounded' | 'partially_grounded' | 'failed_grounding' | 'needs_human_review' | 'too_compressed';
  decisionReason: string;
}

export interface GroundingReport {
  parts: GroundingReportPart[];
  performanceSummary?: {
    ramPeakTrackedMb: number;
  };
}

export interface HealthResponse {
  ok: true;
  ollamaBaseUrl: string;
  ollamaModel: string;
  aiRuntime: 'offline' | 'starting' | 'ready' | 'busy' | 'idle' | 'stopping' | 'error';
  ownedByCurrentSession: boolean;
  activeJobsCount: number;
  idleShutdownMs: number;
  lastActivityAt?: string;
  nextShutdownAt?: string;
}

export interface SystemMemoryResponse {
  totalMb: number;
  usedMb: number;
  freeMb: number;
  usedPercent: number;
}

export interface SystemDependencyStatus {
  key: string;
  label: string;
  kind: 'command' | 'file' | 'config';
  ok: boolean;
  expected: string;
  configuredCommand?: string;
  resolvedValue?: string;
  source?: 'env' | 'path' | 'known_path' | 'missing' | 'config';
  detail: string;
  resolutionHint?: string;
}

export interface SystemDiagnosticsResponse {
  appMode: 'web' | 'desktop';
  allRequiredAvailable: boolean;
  generatedAt: string;
  backendPath: string;
  ollamaBaseUrl: string;
  catalogReachable?: boolean;
  catalogModelCount?: number;
  catalogModelNames?: string[];
  dependencies: SystemDependencyStatus[];
}

async function fetchJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const resolvedInput = typeof input === 'string' ? resolveApiUrl(input) : input;
  const response = await fetch(resolvedInput, init);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed with status ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export async function createJob(payload: CreateJobPayload): Promise<JobResponse> {
  return fetchJson<JobResponse>('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function listJobs(): Promise<JobResponse[]> {
  return fetchJson<JobResponse[]>('/api/jobs');
}

export async function getJob(jobId: string): Promise<JobResponse> {
  return fetchJson<JobResponse>(`/api/jobs/${jobId}`);
}

export async function getJobFiles(jobId: string, itemId?: string): Promise<JobFile[]> {
  const endpoint = itemId
    ? `/api/jobs/${jobId}/items/${encodeURIComponent(itemId)}/files`
    : `/api/jobs/${jobId}/files`;
  return fetchJson<JobFile[]>(endpoint);
}

export async function getJobFileContent(jobId: string, filename: string, itemId?: string): Promise<string> {
  const encodedFilename = encodeURIComponent(filename);
  const endpoint = itemId
    ? `/api/jobs/${jobId}/items/${encodeURIComponent(itemId)}/files/${encodedFilename}`
    : `/api/jobs/${jobId}/files/${encodedFilename}`;
  const response = await fetch(resolveApiUrl(endpoint));
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `File request failed with status ${response.status}`);
  }
  return response.text();
}

export async function cancelJob(jobId: string): Promise<JobResponse> {
  return fetchJson<JobResponse>(`/api/jobs/${jobId}/cancel`, {
    method: 'POST',
  });
}

export async function deleteJob(jobId: string): Promise<{ ok: true; jobId: string }> {
  return fetchJson<{ ok: true; jobId: string }>(`/api/jobs/${jobId}`, {
    method: 'DELETE',
  });
}

export async function deleteAllJobs(): Promise<{ ok: true; deletedCount: number }> {
  return fetchJson<{ ok: true; deletedCount: number }>('/api/jobs', {
    method: 'DELETE',
  });
}

export async function getHealth(): Promise<HealthResponse> {
  return fetchJson<HealthResponse>('/api/health');
}

export async function getAvailableModels(): Promise<LocalModelInfo[]> {
  return fetchJson<LocalModelInfo[]>('/api/models');
}

export async function getModelSelection(): Promise<ModelSelectionResponse> {
  return fetchJson<ModelSelectionResponse>('/api/model-selection');
}

export async function updateModelSelection(model: string): Promise<ModelSelectionResponse> {
  return fetchJson<ModelSelectionResponse>('/api/model-selection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
}


export async function getSystemMemory(): Promise<SystemMemoryResponse> {
  return fetchJson<SystemMemoryResponse>('/api/system/memory');
}

export async function getSystemDiagnostics(): Promise<SystemDiagnosticsResponse> {
  return fetchJson<SystemDiagnosticsResponse>('/api/system/dependencies');
}

export async function downloadBatchWordZip(jobId: string): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch(resolveApiUrl(`/api/jobs/${jobId}/download/study-notes.zip`));
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Zip request failed with status ${response.status}`);
  }

  const contentDisposition = response.headers.get('content-disposition') ?? '';
  const filenameMatch = contentDisposition.match(/filename="?([^"]+)"?/i);
  const filename = filenameMatch?.[1] ?? `job_${jobId}_study_notes_es.zip`;
  const blob = await response.blob();
  return { blob, filename };
}
