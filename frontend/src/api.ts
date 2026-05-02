export type JobStatus =
  | 'pending'
  | 'downloading'
  | 'transcribing'
  | 'translating'
  | 'summarizing'
  | 'completed'
  | 'failed';

export type JobLanguage = string;

export interface CreateJobPayload {
  url: string;
  language: JobLanguage;
  generateTranscription: boolean;
  generateTranslation: boolean;
  generateSummary: boolean;
}

export interface JobFile {
  name: string;
  path: string;
  size: number;
  createdAt: string;
  downloadUrl: string;
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
  outputDir: string;
  files: JobFile[];
  logs: string[];
  logCount: number;
  logsTruncated: boolean;
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
