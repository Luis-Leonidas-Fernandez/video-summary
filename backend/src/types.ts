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
export type BatchSourceType = 'single' | 'batch_list' | 'playlist';
export type BatchFailurePolicy = 'continue_on_item_failure' | 'fail_fast';
export type TranscriptionQuality = 'ok' | 'suspicious' | 'poor';
export type GroundingStatus = 'grounded' | 'partially_grounded' | 'failed_grounding' | 'needs_human_review' | 'too_compressed' | 'legacy_warning' | 'unknown';
export type ResourceUsageScope = 'batch_aggregate' | 'last_item' | 'single_item';
export type TranslationStatus = 'reused_spanish_transcription' | 'translated_to_spanish' | 'skipped';

export interface CreateJobInput {
  url?: string;
  urls?: string[];
  playlistUrl?: string;
  language?: JobLanguage;
  transcriptionLanguage?: JobLanguage;
  outputLanguage?: JobLanguage;
  generateTranscription?: boolean;
  generateTranslation: boolean;
  generateSummary: boolean;
  speakerCountHint?: number;
  reuseFromJobId?: string;
}

export interface JobOriginalInput {
  url?: string;
  urls?: string[];
  playlistUrl?: string;
}

export interface JobFileEntry {
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
  sourceType: BatchSourceType;
  status: ItemStatus;
  outputDir: string;
  files: JobFileEntry[];
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

export interface JobRecord {
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
  files: JobFileEntry[];
  items?: BatchJobItem[];
  summary?: JobBatchSummary;
  logs: string[];
  resourceUsage?: JobResourceUsage;
  modelMetadata?: JobModelMetadata;
  detectedSourceLanguage?: string;
  translationStatus?: TranslationStatus;
  error?: string;
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
  files: JobFileEntry[];
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

export interface JobLogsResponse {
  jobId: string;
  logs: string[];
  logCount: number;
  tail: number;
  logsTruncated: boolean;
}

export type AiRuntimeStatus =
  | 'offline'
  | 'starting'
  | 'ready'
  | 'busy'
  | 'idle'
  | 'stopping'
  | 'error';

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
  warning?: string;
}

export interface HealthResponse {
  ok: true;
  ollamaBaseUrl: string;
  ollamaModel: string;
  aiRuntime: AiRuntimeStatus;
  ownedByCurrentSession: boolean;
  activeJobsCount: number;
  idleShutdownMs: number;
  lastActivityAt?: string;
  nextShutdownAt?: string;
}
