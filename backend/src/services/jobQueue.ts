import path from 'node:path';
import { outputRoot, ensureDir, listJobFiles, writeJson } from '../utils/files.js';
import { processVideoJob } from './videoProcessor.js';
import type { CreateJobInput, JobFileEntry, JobRecord, JobStatus } from '../types.js';

class JobQueue {
  private jobs = new Map<string, JobRecord>();
  private queue: string[] = [];
  private isProcessing = false;

  async createJob(input: CreateJobInput): Promise<JobRecord> {
    await ensureDir(outputRoot);

    const timestamp = Date.now();
    const id = `job_${timestamp}`;
    const outputDir = path.join(outputRoot, id);

    const job: JobRecord = {
      id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'pending',
      url: input.url,
      language: input.language,
      generateTranscription: input.generateTranscription ?? true,
      generateTranslation: input.generateTranslation,
      generateSummary: input.generateSummary,
      outputDir,
      files: [],
      logs: ['Trabajo creado y encolado.'],
    };

    this.jobs.set(id, job);
    this.queue.push(id);
    await ensureDir(outputDir);
    await this.persistJob(job);
    void this.processNext();

    return job;
  }

  getJob(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  getJobFiles(id: string): JobFileEntry[] {
    return this.jobs.get(id)?.files ?? [];
  }

  private async processNext(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    const nextJobId = this.queue.shift();
    if (!nextJobId) {
      return;
    }

    const job = this.jobs.get(nextJobId);
    if (!job) {
      return;
    }

    this.isProcessing = true;

    try {
      await processVideoJob(job, {
        updateStatus: async (status) => {
          job.status = status;
          job.updatedAt = new Date().toISOString();
          await this.persistJob(job);
        },
        appendLog: async (message) => {
          job.logs.push(message);
          job.updatedAt = new Date().toISOString();
          await this.persistJob(job);
        },
        refreshFiles: async () => {
          job.files = await listJobFiles(job.id, job.outputDir);
          job.updatedAt = new Date().toISOString();
          await this.persistJob(job);
        },
        failJob: async (message) => {
          job.status = 'failed';
          job.error = message;
          job.updatedAt = new Date().toISOString();
          await this.persistJob(job);
        },
      });
    } catch {
      // Error ya persistido por processVideoJob.
    } finally {
      this.isProcessing = false;
      void this.processNext();
    }
  }

  private async persistJob(job: JobRecord): Promise<void> {
    await writeJson(path.join(job.outputDir, 'job.json'), job);
  }
}

export const jobQueue = new JobQueue();

export function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isValidLanguage(value: string): value is CreateJobInput['language'] {
  return value === 'auto' || value === 'English' || value === 'Spanish';
}
