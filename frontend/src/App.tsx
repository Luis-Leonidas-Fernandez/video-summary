import { useEffect, useMemo, useRef, useState } from 'react';
import './styles.css';
import {
  createJob,
  getJob,
  getJobFileContent,
  getJobFiles,
  type CreateJobPayload,
  type JobFile,
  type JobResponse,
  type ValidationReport,
} from './api';
import { FileList } from './components/FileList';
import { JobForm } from './components/JobForm';
import { JobStatus } from './components/JobStatus';
import { SummaryPreview } from './components/SummaryPreview';
import { ValidationSummary } from './components/ValidationSummary';

const TERMINAL_STATUSES = new Set(['completed', 'failed']);

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
  const [validationReport, setValidationReport] = useState<ValidationReport | null>(null);
  const [isSummaryLoading, setIsSummaryLoading] = useState(false);
  const [isValidationLoading, setIsValidationLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [areLogsCollapsed, setAreLogsCollapsed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previousStatusRef = useRef<JobResponse['status'] | null>(null);

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

  const loadValidationReport = async (jobId: string) => {
    setIsValidationLoading(true);

    try {
      const raw = await getJobFileContent(jobId, 'validation_report.json');
      const parsed = JSON.parse(raw) as ValidationReport;
      setValidationReport(parsed);
    } catch {
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

    if (job.status === 'completed') {
      setAreLogsCollapsed(true);
    }

    if (job.status !== 'completed' || previousStatus === 'completed') {
      return;
    }

    void (async () => {
      try {
        const nextFiles = await getJobFiles(job.id);
        setFiles(nextFiles);

        if (job.generateSummary) {
          await Promise.all([
            loadSummaryPreview(job.id),
            loadValidationReport(job.id),
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
    setValidationReport(null);
    setIsSummaryLoading(false);
    setIsValidationLoading(false);
    setAreLogsCollapsed(false);
    previousStatusRef.current = null;

    try {
      const created = await createJob(payload);
      setJob(created);
      setFiles(created.files);
      if (created.generateSummary && TERMINAL_STATUSES.has(created.status)) {
        await Promise.all([
          loadSummaryPreview(created.id),
          loadValidationReport(created.id),
        ]);
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'No se pudo crear el job.');
      setJob(null);
    } finally {
      setIsSubmitting(false);
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
        <JobStatus job={job} error={error} />
      </div>

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

      <ValidationSummary
        report={validationReport}
        files={files.length > 0 ? files : job?.files ?? []}
        isLoading={isValidationLoading}
      />

      <SummaryPreview content={summaryContent} isLoading={isSummaryLoading} />

      <FileList files={files.length > 0 ? files : job?.files ?? []} />
    </main>
  );
}

export default App;
