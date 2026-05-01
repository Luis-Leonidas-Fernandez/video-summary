export type JobStatus =
  | 'pending'
  | 'downloading'
  | 'transcribing'
  | 'translating'
  | 'summarizing'
  | 'completed'
  | 'failed';

export type JobLanguage = string;

export interface CreateJobInput {
  url: string;
  language: JobLanguage;
  generateTranscription?: boolean;
  generateTranslation: boolean;
  generateSummary: boolean;
}

export interface JobFileEntry {
  name: string;
  path: string;
  size: number;
  createdAt: string;
  downloadUrl: string;
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
  outputDir: string;
  files: JobFileEntry[];
  logs: string[];
  error?: string;
}
