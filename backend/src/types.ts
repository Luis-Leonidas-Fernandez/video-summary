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

export interface CreateJobInput {
  url: string;
  language: JobLanguage;
  generateTranscription?: boolean;
  generateTranslation: boolean;
  generateSummary: boolean;
  speakerCountHint?: number;
  reuseFromJobId?: string;
}

export interface JobFileEntry {
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

export interface JobRecord {
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
  files: JobFileEntry[];
  logs: string[];
  resourceUsage?: JobResourceUsage;
  error?: string;
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
  files: JobFileEntry[];
  logs: string[];
  logCount: number;
  logsTruncated: boolean;
  resourceUsage?: JobResourceUsage;
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
