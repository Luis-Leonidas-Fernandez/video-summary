import path from 'node:path';
import { promises as fs } from 'node:fs';
import { outputRoot, ensureDir, listJobFiles, writeJson, cloneTranscriptionArtifacts } from '../utils/files.js';
import { withJobContext, jobLog } from '../utils/jobContext.js';
import { jobRequiresAi, runWithAiRuntime } from './aiJobRuntime.js';
import { aiRuntimeManager } from './aiRuntimeManager.js';
import { processVideoJob } from './videoProcessor.js';
import type { CreateJobInput, JobFileEntry, JobRecord, JobResponse, JobStatus } from '../types.js';

const DEFAULT_LOG_TAIL = 200;

class JobQueue {
  private jobs = new Map<string, JobRecord>();
  private queue: string[] = [];
  private isProcessing = false;
  private currentJobId?: string;
  private activeAbortControllers = new Map<string, AbortController>();

  async createJob(input: CreateJobInput): Promise<JobRecord> {
    await ensureDir(outputRoot);

    const timestamp = Date.now();
    const id = `job_${timestamp}`;
    const outputDir = path.join(outputRoot, id);

    let reusedFromJobId: string | undefined;
    const initialLogs: string[] = ['Trabajo creado y encolado.'];

    if (input.reuseFromJobId) {
      const sourceJob = this.jobs.get(input.reuseFromJobId);
      if (!sourceJob) {
        throw new Error(`El job source ${input.reuseFromJobId} no se encuentra en memoria.`);
      }

      await ensureDir(outputDir);
      try {
        const clone = await cloneTranscriptionArtifacts(sourceJob.outputDir, outputDir);
        reusedFromJobId = input.reuseFromJobId;
        initialLogs.push(
          `[${new Date().toISOString()}] Reutilizando artefactos de transcripción del job ${input.reuseFromJobId}: ${clone.filesCopied} archivos copiados (${clone.directoriesCopied.join(', ') || 'sin subdirectorios'}).`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Error desconocido al clonar artefactos.';
        throw new Error(`No se pudieron clonar los artefactos del job source: ${message}`);
      }
    }

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
      speakerCountHint: input.speakerCountHint,
      reusedFromJobId,
      outputDir,
      files: [],
      logs: initialLogs,
      resourceUsage: undefined,
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

  getJobResponse(id: string, tail = DEFAULT_LOG_TAIL): JobResponse | undefined {
    const job = this.jobs.get(id);
    if (!job) {
      return undefined;
    }

    return serializeJob(job, tail);
  }

  getJobFiles(id: string): JobFileEntry[] {
    return this.jobs.get(id)?.files ?? [];
  }

  async cancelJob(id: string): Promise<JobRecord | undefined> {
    const job = this.jobs.get(id);
    if (!job) {
      return undefined;
    }

    if (['completed', 'completed_with_warnings', 'failed', 'cancelled'].includes(job.status)) {
      return job;
    }

    if (job.status === 'pending') {
      this.queue = this.queue.filter((jobId) => jobId !== id);
      job.status = 'cancelled';
      job.error = 'Trabajo cancelado por el usuario antes de iniciar.'
      job.logs.push(`[${new Date().toISOString()}] Trabajo cancelado por el usuario antes de iniciar.`)
      job.updatedAt = new Date().toISOString();
      await this.persistJob(job);
      return job;
    }

    if (this.currentJobId === id) {
      job.status = 'cancelling';
      job.logs.push(`[${new Date().toISOString()}] Cancelación solicitada por el usuario. Frenando pipeline y apagando runtime/modelo.`)
      job.updatedAt = new Date().toISOString();
      await this.persistJob(job);
      this.activeAbortControllers.get(id)?.abort();
      await aiRuntimeManager.forceStopAll();
      return job;
    }

    return job;
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
    this.currentJobId = nextJobId;
    const abortController = new AbortController();
    this.activeAbortControllers.set(nextJobId, abortController);

    try {
      await withJobContext(job.id, async () => {
        jobLog(`[job-start] url=${job.url} language=${job.language} generateTranscription=${job.generateTranscription} generateTranslation=${job.generateTranslation} generateSummary=${job.generateSummary} reusedFromJobId=${job.reusedFromJobId ?? 'none'}`);
        await runWithAiRuntime(jobRequiresAi(job.generateSummary), async () =>
          processVideoJob(job, {
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
          setResourceUsage: async (summary) => {
            job.resourceUsage = summary;
            job.updatedAt = new Date().toISOString();
            await this.persistJob(job);
          },
          failJob: async (message) => {
            job.status = 'failed';
            job.error = message;
            job.updatedAt = new Date().toISOString();
            await this.persistJob(job);
          },
          cancelJob: async (message) => {
            job.status = 'cancelled';
            job.error = message;
            job.updatedAt = new Date().toISOString();
            await this.persistJob(job);
          },
        }, abortController.signal),
      );
      });
    } catch {
      // Error ya persistido por processVideoJob.
    } finally {
      this.activeAbortControllers.delete(nextJobId);
      this.currentJobId = undefined;
      this.isProcessing = false;
      void this.processNext();
    }
  }

  async loadJobsFromDisk(): Promise<void> {
    const TERMINAL_STATUSES = new Set<string>(['completed', 'completed_with_warnings', 'failed', 'cancelled']);
    let entries: import('node:fs').Dirent[];

    try {
      entries = await fs.readdir(outputRoot, { withFileTypes: true });
    } catch {
      return;
    }

    const jobDirs = entries
      .filter((e) => e.isDirectory() && e.name.startsWith('job_'))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of jobDirs) {
      const jobJsonPath = path.join(outputRoot, entry.name, 'job.json');

      try {
        const raw = await fs.readFile(jobJsonPath, 'utf-8');
        const loaded = JSON.parse(raw) as JobRecord;

        if (!TERMINAL_STATUSES.has(loaded.status)) {
          loaded.status = 'failed';
          loaded.error = 'El servidor se reinició mientras el job estaba en curso.';
          loaded.updatedAt = new Date().toISOString();
          loaded.logs.push(`[${loaded.updatedAt}] Job marcado como fallido por reinicio del servidor.`);
          await this.persistJob(loaded);
        }

        this.jobs.set(loaded.id, loaded);
      } catch {
        // Si el job.json está corrupto o ausente, lo ignoramos.
      }
    }

    console.log(`[jobQueue] ${this.jobs.size} job(s) cargados desde disco.`);
  }

  private async persistJob(job: JobRecord): Promise<void> {
    await writeJson(path.join(job.outputDir, 'job.json'), job);
  }
}

export function serializeJob(job: JobRecord, tail = DEFAULT_LOG_TAIL): JobResponse {
  const safeTail = Math.max(0, tail);
  const logs = safeTail > 0 ? job.logs.slice(-safeTail) : [];

  return {
    id: job.id,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    status: job.status,
    url: job.url,
    language: job.language,
    generateTranscription: job.generateTranscription,
    generateTranslation: job.generateTranslation,
    generateSummary: job.generateSummary,
    speakerCountHint: job.speakerCountHint,
    reusedFromJobId: job.reusedFromJobId,
    outputDir: job.outputDir,
    files: job.files,
    logs,
    logCount: job.logs.length,
    logsTruncated: job.logs.length > logs.length,
    resourceUsage: job.resourceUsage,
    error: job.error,
  };
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
  return typeof value === 'string' && value.trim().length > 0;
}
