import { useCallback, useEffect, useState } from 'react';
import { cancelJob, createJob, getJob, type CreateJobPayload, type JobResponse } from '../api';
import { getPollingInterval, TERMINAL_STATUSES } from '../job-ui';

interface UseJobSessionOptions {
  initialJobId?: string | null;
  persistLastJob?: boolean;
}

function persistLastJobId(jobId: string | null, enabled: boolean) {
  if (!enabled) {
    return;
  }

  if (jobId) {
    localStorage.setItem('lastJobId', jobId);
    return;
  }

  localStorage.removeItem('lastJobId');
}

export function useJobSession({ initialJobId = null, persistLastJob = false }: UseJobSessionOptions) {
  const [jobId, setJobId] = useState<string | null>(initialJobId);
  const [job, setJob] = useState<JobResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoadingJob, setIsLoadingJob] = useState(Boolean(initialJobId));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isReprocessing, setIsReprocessing] = useState(false);

  useEffect(() => {
    setJobId(initialJobId ?? null);
  }, [initialJobId]);

  const loadJob = useCallback(async (nextJobId: string) => {
    const loaded = await getJob(nextJobId);
    setJob(loaded);
    setError(null);
    return loaded;
  }, []);

  useEffect(() => {
    if (!jobId) {
      setJob(null);
      setError(null);
      setIsLoadingJob(false);
      return;
    }

    let cancelled = false;
    setIsLoadingJob(true);

    void (async () => {
      try {
        const loaded = await getJob(jobId);
        if (cancelled) {
          return;
        }

        setJob(loaded);
        setError(null);
      } catch (loadError) {
        if (cancelled) {
          return;
        }

        setJob(null);
        setError(loadError instanceof Error ? loadError.message : 'No se pudo cargar el job.');
      } finally {
        if (!cancelled) {
          setIsLoadingJob(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [jobId]);

  useEffect(() => {
    const intervalMs = getPollingInterval(job?.status);
    if (!job || !intervalMs) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void (async () => {
        try {
          const refreshed = await getJob(job.id);
          setJob(refreshed);
          setError(null);
        } catch (pollError) {
          setError(pollError instanceof Error ? pollError.message : 'No se pudo refrescar el job.');
        }
      })();
    }, intervalMs);

    return () => window.clearInterval(intervalId);
  }, [job]);

  const createNewJob = useCallback(async (payload: CreateJobPayload) => {
    setIsSubmitting(true);
    setError(null);

    try {
      const created = await createJob(payload);
      setJob(created);
      setJobId(created.id);
      persistLastJobId(created.id, persistLastJob);
      return created;
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : 'No se pudo crear el job.';
      setError(message);
      setJob(null);
      throw new Error(message);
    } finally {
      setIsSubmitting(false);
    }
  }, [persistLastJob]);

  const reprocessCurrentJob = useCallback(async () => {
    if (!job || isReprocessing || job.inputMode !== 'single_url') {
      return null;
    }

    const sourceUrl = job.originalInput?.url ?? job.url;
    if (!sourceUrl) {
      const message = 'No se pudo reconstruir la URL original para reprocesar.';
      setError(message);
      throw new Error(message);
    }

    setIsReprocessing(true);
    setError(null);

    try {
      const created = await createJob({
        url: sourceUrl,
        transcriptionLanguage: job.transcriptionLanguage,
        outputLanguage: job.outputLanguage,
        generateTranscription: job.generateTranscription,
        generateTranslation: job.generateTranslation,
        generateSummary: job.generateSummary,
        speakerCountHint: job.speakerCountHint,
        reuseFromJobId: job.id,
      });

      setJob(created);
      setJobId(created.id);
      persistLastJobId(created.id, persistLastJob);
      return created;
    } catch (reprocessError) {
      const message = reprocessError instanceof Error ? reprocessError.message : 'No se pudo reprocesar el job.';
      setError(message);
      throw new Error(message);
    } finally {
      setIsReprocessing(false);
    }
  }, [isReprocessing, job, persistLastJob]);

  const cancelCurrentJob = useCallback(async () => {
    if (!job || TERMINAL_STATUSES.has(job.status) || job.status === 'cancelling') {
      return null;
    }

    setIsCancelling(true);
    setError(null);

    try {
      const cancelledJob = await cancelJob(job.id);
      setJob(cancelledJob);
      return cancelledJob;
    } catch (cancelError) {
      const message = cancelError instanceof Error ? cancelError.message : 'No se pudo cancelar el pipeline.';
      setError(message);
      throw new Error(message);
    } finally {
      setIsCancelling(false);
    }
  }, [job]);

  const clearSession = useCallback(() => {
    setJob(null);
    setJobId(null);
    setError(null);
    persistLastJobId(null, persistLastJob);
  }, [persistLastJob]);

  return {
    job,
    error,
    isLoadingJob,
    isSubmitting,
    isCancelling,
    isReprocessing,
    createNewJob,
    cancelCurrentJob,
    reprocessCurrentJob,
    loadJob,
    clearSession,
  };
}
