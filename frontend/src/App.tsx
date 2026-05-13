import { useEffect, useMemo, useRef, useState } from 'react';
import './styles.css';
import {
  cancelJob,
  createJob,
  getHealth,
  type GroundingReport,
  type HealthResponse,
  getJob,
  getJobFileContent,
  getJobFiles,
  type CreateJobPayload,
  type JobFile,
  type JobResponse,
  type ValidationReport,
} from './api';
import { FileList } from './components/FileList';
import { AiRuntimeBanner } from './components/AiRuntimeBanner';
import { GroundingSummary } from './components/GroundingSummary';
import { JobForm } from './components/JobForm';
import { JobResourceUsagePanel } from './components/JobResourceUsagePanel';
import { JobStatus } from './components/JobStatus';
import { SummaryPreview } from './components/SummaryPreview';
import { ValidationSummary } from './components/ValidationSummary';

const TERMINAL_STATUSES = new Set(['completed', 'completed_with_warnings', 'failed', 'cancelled']);
const TERMINAL_SUCCESS_STATUSES = new Set(['completed', 'completed_with_warnings']);

function isUsableGroundingReport(value: unknown): value is GroundingReport {
  if (!value || typeof value !== 'object' || !('parts' in value)) {
    return false;
  }

  const parts = (value as { parts?: unknown }).parts;
  return Array.isArray(parts) && parts.length > 0;
}

function getPollingInterval(status: JobResponse['status'] | undefined): number | null {
  if (!status || TERMINAL_STATUSES.has(status)) {
    return null;
  }

  if (status === 'pending' || status === 'downloading') {
    return 4000;
  }

  return 2000;
}

function App() {
  const [job, setJob] = useState<JobResponse | null>(null);
  const [files, setFiles] = useState<JobFile[]>([]);
  const [summaryContent, setSummaryContent] = useState<string | null>(null);
  const [groundingReport, setGroundingReport] = useState<GroundingReport | null>(null);
  const [validationReport, setValidationReport] = useState<ValidationReport | null>(null);
  const [isSummaryLoading, setIsSummaryLoading] = useState(false);
  const [isValidationLoading, setIsValidationLoading] = useState(false);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isReprocessing, setIsReprocessing] = useState(false);
  const [areLogsCollapsed, setAreLogsCollapsed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previousStatusRef = useRef<JobResponse['status'] | null>(null);

  const refreshHealth = async (): Promise<void> => {
    try {
      const nextHealth = await getHealth();
      setHealth(nextHealth);
      setHealthError(null);
    } catch (nextError) {
      setHealthError(nextError instanceof Error ? nextError.message : 'No se pudo consultar el runtime de IA.');
    }
  };

  useEffect(() => {
    const savedJobId = localStorage.getItem('lastJobId');
    if (!savedJobId) {
      return;
    }

    void (async () => {
      try {
        const restored = await getJob(savedJobId);
        setJob(restored);
        setFiles(restored.files);

        if (new Set(['completed', 'completed_with_warnings']).has(restored.status)) {
          setAreLogsCollapsed(true);
          if (restored.generateSummary) {
            await Promise.all([
              loadSummaryPreview(restored.id),
              loadReviewReports(restored.id),
            ]);
          }
        }
      } catch {
        localStorage.removeItem('lastJobId');
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;

    void refreshHealth();
    const intervalId = window.setInterval(() => {
      void (async () => {
        try {
          const nextHealth = await getHealth();
          if (cancelled) {
            return;
          }
          setHealth(nextHealth);
          setHealthError(null);
        } catch (nextError) {
          if (cancelled) {
            return;
          }
          setHealthError(nextError instanceof Error ? nextError.message : 'No se pudo consultar el runtime de IA.');
        }
      })();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  const loadSummaryPreview = async (jobId: string) => {
    setIsSummaryLoading(true);

    try {
      let content: string;
      try {
        content = await getJobFileContent(jobId, 'full_study_notes_es.txt');
      } catch {
        content = await getJobFileContent(jobId, 'summary_es.txt');
      }
      setSummaryContent(content);
    } catch (summaryError) {
      setSummaryContent(null);
      if (job?.generateSummary) {
        setError(summaryError instanceof Error ? summaryError.message : 'No se pudo cargar el material de estudio.');
      }
    } finally {
      setIsSummaryLoading(false);
    }
  };

  const loadReviewReports = async (jobId: string) => {
    setIsValidationLoading(true);

    try {
      try {
        const rawGrounding = await getJobFileContent(jobId, 'grounding_report.json');
        const parsedGrounding = JSON.parse(rawGrounding) as unknown;
        setGroundingReport(isUsableGroundingReport(parsedGrounding) ? parsedGrounding : null);
      } catch {
        setGroundingReport(null);
      }

      try {
        const rawValidation = await getJobFileContent(jobId, 'validation_report.json');
        const parsedValidation = JSON.parse(rawValidation) as ValidationReport;
        setValidationReport(parsedValidation);
      } catch {
        setValidationReport(null);
      }
    } catch {
      setGroundingReport(null);
      setValidationReport(null);
    } finally {
      setIsValidationLoading(false);
    }
  };

  useEffect(() => {
    const intervalMs = getPollingInterval(job?.status);
    if (!job || !intervalMs) {
      return;
    }

    const intervalId = window.setInterval(async () => {
      try {
        const refreshedJob = await getJob(job.id);
        setJob(refreshedJob);

        if (TERMINAL_STATUSES.has(refreshedJob.status)) {
          const nextFiles = await getJobFiles(refreshedJob.id);
          setFiles(nextFiles);
        }
      } catch (pollError) {
        setError(pollError instanceof Error ? pollError.message : 'No se pudo refrescar el job.');
      }
    }, intervalMs);

    return () => window.clearInterval(intervalId);
  }, [job?.id, job?.status]);

  useEffect(() => {
    if (!job) {
      return;
    }

    const previousStatus = previousStatusRef.current;
    previousStatusRef.current = job.status;

    if (TERMINAL_SUCCESS_STATUSES.has(job.status)) {
      setAreLogsCollapsed(true);
    }

    if (
      !TERMINAL_SUCCESS_STATUSES.has(job.status)
      || (previousStatus != null && TERMINAL_SUCCESS_STATUSES.has(previousStatus))
    ) {
      return;
    }

    void (async () => {
      try {
        const nextFiles = await getJobFiles(job.id);
        setFiles(nextFiles);

        if (job.generateSummary) {
          await Promise.all([
            loadSummaryPreview(job.id),
            loadReviewReports(job.id),
          ]);
        }
      } catch (refreshError) {
        setError(refreshError instanceof Error ? refreshError.message : 'No se pudieron refrescar los artefactos finales.');
      }
    })();
  }, [job]);

  const handleSubmit = async (payload: CreateJobPayload) => {
    setIsSubmitting(true);
    setError(null);
    setFiles([]);
    setSummaryContent(null);
    setGroundingReport(null);
    setValidationReport(null);
    setIsSummaryLoading(false);
    setIsValidationLoading(false);
    setAreLogsCollapsed(false);
    previousStatusRef.current = null;

    try {
      const created = await createJob(payload);
      localStorage.setItem('lastJobId', created.id);
      setJob(created);
      setFiles(created.files);
      if (created.generateSummary && TERMINAL_SUCCESS_STATUSES.has(created.status)) {
        await Promise.all([
          loadSummaryPreview(created.id),
          loadReviewReports(created.id),
        ]);
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'No se pudo crear el job.');
      setJob(null);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReprocess = async () => {
    if (!job || isReprocessing) {
      return;
    }

    setIsReprocessing(true);
    setError(null);
    setFiles([]);
    setSummaryContent(null);
    setGroundingReport(null);
    setValidationReport(null);
    setIsSummaryLoading(false);
    setIsValidationLoading(false);
    setAreLogsCollapsed(false);
    previousStatusRef.current = null;

    try {
      const created = await createJob({
        url: job.url,
        language: job.language,
        generateTranscription: job.generateTranscription,
        generateTranslation: job.generateTranslation,
        generateSummary: job.generateSummary,
        speakerCountHint: job.speakerCountHint,
        reuseFromJobId: job.id,
      });
      localStorage.setItem('lastJobId', created.id);
      setJob(created);
      setFiles(created.files);
    } catch (reprocessError) {
      setError(reprocessError instanceof Error ? reprocessError.message : 'No se pudo reprocesar el job.');
    } finally {
      setIsReprocessing(false);
    }
  };

  const handleCancelPipeline = async () => {
    if (!job || TERMINAL_STATUSES.has(job.status) || job.status === 'cancelling') {
      return;
    }

    setIsCancelling(true);
    setError(null);

    try {
      const cancelledJob = await cancelJob(job.id);
      setJob(cancelledJob);
      const nextHealth = await getHealth();
      setHealth(nextHealth);
      setHealthError(null);
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : 'No se pudo cancelar el pipeline.');
    } finally {
      setIsCancelling(false);
    }
  };

  const visibleLogsText = useMemo(() => job?.logs?.join('\n') ?? '', [job?.logs]);
  const logsCaption = useMemo(() => {
    if (!job) {
      return 'Todavía no hay logs.';
    }

    if (job.logCount === 0) {
      return 'Todavía no hay logs.';
    }

    const visibleCount = job.logs.length;
    if (job.logsTruncated) {
      return `Mostrando últimas ${visibleCount} líneas de ${job.logCount}. Hay más logs disponibles.`;
    }

    return `Mostrando ${visibleCount} líneas de ${job.logCount}.`;
  }, [job]);

  return (
    <main className="app-shell">
      <header>
        <p className="eyebrow">MVP local para Mac</p>
        <h1>Video Study Tool</h1>
        <p>
          Pegá una URL de YouTube, descargá el audio, transcribí con whisper y guardá todo en
          <code> /output</code>.
        </p>
      </header>

      <div className="layout-grid">
        <JobForm isSubmitting={isSubmitting} onSubmit={handleSubmit} />
        <JobStatus job={job} error={error} onCancel={handleCancelPipeline} isCancelling={isCancelling} onReprocess={handleReprocess} isReprocessing={isReprocessing} />
      </div>

      <AiRuntimeBanner health={health} error={healthError} onRefreshHealth={refreshHealth} />
      <JobResourceUsagePanel resourceUsage={job?.resourceUsage} />

      <section className="panel">
        <div className="panel-header">
          <h2>Logs / progreso</h2>
          <button
            type="button"
            className="ghost-button"
            onClick={() => setAreLogsCollapsed((current) => !current)}
          >
            {areLogsCollapsed ? 'Mostrar logs' : 'Ocultar logs'}
          </button>
        </div>
        <p className="panel-caption">{logsCaption}</p>
        {!areLogsCollapsed ? (
          <pre className="log-viewer">{visibleLogsText || 'Todavía no hay logs.'}</pre>
        ) : null}
      </section>

      <GroundingSummary
        report={groundingReport}
        files={files.length > 0 ? files : job?.files ?? []}
        isLoading={isValidationLoading}
      />

      <ValidationSummary
        report={groundingReport ? null : validationReport}
        files={files.length > 0 ? files : job?.files ?? []}
        isLoading={isValidationLoading}
      />

      <SummaryPreview content={summaryContent} isLoading={isSummaryLoading} />

      <FileList files={files.length > 0 ? files : job?.files ?? []} />
    </main>
  );
}

export default App;
