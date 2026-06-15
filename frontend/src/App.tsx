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
import { SystemMemoryWidget } from './components/SystemMemoryWidget';
import { SummaryPreview } from './components/SummaryPreview';
import { ValidationSummary } from './components/ValidationSummary';
import { deriveJobHealth } from './presentation';

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

  if (status === 'queued' || status === 'pending' || status === 'resolving_sources') {
    return 4000;
  }

  return 2000;
}

function getWorkflowHeadline(job: JobResponse | null): string {
  if (!job) {
    return 'Prepará el próximo procesamiento';
  }

  switch (job.status) {
    case 'completed':
      return 'Resultado listo para leer y auditar';
    case 'completed_with_warnings':
      return 'Resultado listo, pero con señales para revisar';
    case 'failed':
      return 'El pipeline necesita intervención';
    case 'cancelled':
      return 'Procesamiento cancelado';
    case 'cancelling':
      return 'Frenando el pipeline actual';
    case 'resolving_sources':
      return 'Resolviendo videos del lote';
    default:
      return 'Pipeline en ejecución';
  }
}

function getJobModeLabel(job: JobResponse | null): string {
  if (!job?.inputMode) {
    return 'single_url';
  }
  switch (job.inputMode) {
    case 'url_list':
      return 'lista manual';
    case 'playlist':
      return 'playlist';
    default:
      return 'video único';
  }
}

function pickDefaultItemId(job: JobResponse | null): string | null {
  if (!job?.items?.length) {
    return null;
  }

  const active = job.summary?.activeItemId && job.items.find((item) => item.itemId === job.summary?.activeItemId);
  if (active) {
    return active.itemId;
  }

  const lastCompleted = [...job.items]
    .filter((item) => item.status === 'completed' || item.status === 'warning')
    .sort((left, right) => right.index - left.index)[0];

  return lastCompleted?.itemId ?? job.items[0]?.itemId ?? null;
}

function getSelectedItem(job: JobResponse | null, selectedItemId: string | null) {
  if (!job?.items?.length || !selectedItemId) {
    return null;
  }
  return job.items.find((item) => item.itemId === selectedItemId) ?? null;
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
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const previousStatusRef = useRef<JobResponse['status'] | null>(null);
  const itemSelectionPinnedRef = useRef(false);

  const refreshHealth = async (): Promise<void> => {
    try {
      const nextHealth = await getHealth();
      setHealth(nextHealth);
      setHealthError(null);
    } catch (nextError) {
      setHealthError(nextError instanceof Error ? nextError.message : 'No se pudo consultar el runtime de IA.');
    }
  };

  const loadSummaryPreview = async (jobId: string, itemId?: string | null) => {
    setIsSummaryLoading(true);

    try {
      let content: string;
      try {
        content = await getJobFileContent(jobId, 'full_study_notes_es.txt', itemId ?? undefined);
      } catch {
        content = await getJobFileContent(jobId, 'summary_es.txt', itemId ?? undefined);
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

  const loadReviewReports = async (jobId: string, itemId?: string | null) => {
    setIsValidationLoading(true);

    try {
      try {
        const rawGrounding = await getJobFileContent(jobId, 'grounding_report.json', itemId ?? undefined);
        const parsedGrounding = JSON.parse(rawGrounding) as unknown;
        setGroundingReport(isUsableGroundingReport(parsedGrounding) ? parsedGrounding : null);
      } catch {
        setGroundingReport(null);
      }

      try {
        const rawValidation = await getJobFileContent(jobId, 'validation_report.json', itemId ?? undefined);
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

  const refreshArtifactsForSelection = async (currentJob: JobResponse, itemId: string | null) => {
    const scopedFiles = await getJobFiles(currentJob.id, itemId ?? undefined);
    setFiles(scopedFiles);

    if (!currentJob.generateSummary || !TERMINAL_SUCCESS_STATUSES.has(currentJob.status)) {
      return;
    }

    await Promise.all([
      loadSummaryPreview(currentJob.id, itemId),
      loadReviewReports(currentJob.id, itemId),
    ]);
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
        const nextSelectedItemId = pickDefaultItemId(restored);
        setSelectedItemId(nextSelectedItemId);
        await refreshArtifactsForSelection(restored, nextSelectedItemId);

        if (new Set(['completed', 'completed_with_warnings']).has(restored.status)) {
          setAreLogsCollapsed(true);
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

  useEffect(() => {
    if (!job) {
      setSelectedItemId(null);
      itemSelectionPinnedRef.current = false;
      return;
    }

    const itemStillExists = selectedItemId && job.items?.some((item) => item.itemId === selectedItemId);
    if (itemSelectionPinnedRef.current && itemStillExists) {
      return;
    }

    const nextSelectedItemId = pickDefaultItemId(job);
    if (nextSelectedItemId !== selectedItemId) {
      setSelectedItemId(nextSelectedItemId);
    }
  }, [job, selectedItemId]);

  useEffect(() => {
    const intervalMs = getPollingInterval(job?.status);
    if (!job || !intervalMs) {
      return;
    }

    const intervalId = window.setInterval(async () => {
      try {
        const refreshedJob = await getJob(job.id);
        setJob(refreshedJob);

        const nextSelectedItemId = itemSelectionPinnedRef.current && selectedItemId && refreshedJob.items?.some((item) => item.itemId === selectedItemId)
          ? selectedItemId
          : pickDefaultItemId(refreshedJob);

        if (TERMINAL_STATUSES.has(refreshedJob.status) || refreshedJob.status === 'processing') {
          const nextFiles = await getJobFiles(refreshedJob.id, nextSelectedItemId ?? undefined);
          setFiles(nextFiles);
        }
      } catch (pollError) {
        setError(pollError instanceof Error ? pollError.message : 'No se pudo refrescar el job.');
      }
    }, intervalMs);

    return () => window.clearInterval(intervalId);
  }, [job?.id, job?.status, selectedItemId]);

  useEffect(() => {
    if (!job) {
      return;
    }

    const previousStatus = previousStatusRef.current;
    previousStatusRef.current = job.status;

    if (TERMINAL_SUCCESS_STATUSES.has(job.status)) {
      setAreLogsCollapsed(true);
    }

    if (!TERMINAL_SUCCESS_STATUSES.has(job.status)) {
      return;
    }

    if (previousStatus != null && TERMINAL_SUCCESS_STATUSES.has(previousStatus) && previousStatus === job.status) {
      return;
    }

    void refreshArtifactsForSelection(job, selectedItemId);
  }, [job, selectedItemId]);

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
    setSelectedItemId(null);
    previousStatusRef.current = null;
    itemSelectionPinnedRef.current = false;

    try {
      const created = await createJob(payload);
      localStorage.setItem('lastJobId', created.id);
      setJob(created);
      const nextSelectedItemId = pickDefaultItemId(created);
      setSelectedItemId(nextSelectedItemId);
      await refreshArtifactsForSelection(created, nextSelectedItemId);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'No se pudo crear el job.');
      setJob(null);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReprocess = async () => {
    if (!job || isReprocessing || job.inputMode !== 'single_url') {
      return;
    }

    const sourceUrl = job.originalInput?.url ?? job.url;
    if (!sourceUrl) {
      setError('No se pudo reconstruir la URL original para reprocesar.');
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
    setSelectedItemId(null);
    previousStatusRef.current = null;
    itemSelectionPinnedRef.current = false;

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
      localStorage.setItem('lastJobId', created.id);
      setJob(created);
      const nextSelectedItemId = pickDefaultItemId(created);
      setSelectedItemId(nextSelectedItemId);
      await refreshArtifactsForSelection(created, nextSelectedItemId);
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

  const handleSelectItem = async (itemId: string) => {
    if (!job) {
      return;
    }

    itemSelectionPinnedRef.current = true;
    setSelectedItemId(itemId);
    setSummaryContent(null);
    setGroundingReport(null);
    setValidationReport(null);

    try {
      await refreshArtifactsForSelection(job, itemId);
    } catch (selectionError) {
      setError(selectionError instanceof Error ? selectionError.message : 'No se pudieron cargar los artefactos del item seleccionado.');
    }
  };

  const activeFiles = files.length > 0 ? files : job?.files ?? [];
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

  const selectedItem = useMemo(() => getSelectedItem(job, selectedItemId), [job, selectedItemId]);
  const jobHealth = useMemo(
    () => deriveJobHealth(job, groundingReport, validationReport),
    [job, groundingReport, validationReport],
  );

  return (
    <main className="app-shell">
      <header className="app-hero panel panel-hero">
        <div>
          <p className="eyebrow">MVP local para Mac</p>
          <h1>Video Study Tool</h1>
          <p className="hero-copy">
            Procesá videos largos o lotes cortos con una UI más clara: runtime, job activo, grounding, resultados y forense técnico en capas separadas.
          </p>
        </div>
        <div className="hero-aside">
          <span className="hero-kicker">Workflow actual</span>
          <strong>{getWorkflowHeadline(job)}</strong>
          <p>
            {job
              ? `Job ${job.id.slice(0, 8)} · modo ${getJobModeLabel(job)}${job.summary ? ` · ${job.summary.totalItems} item(s)` : ''}`
              : 'Pegá una URL, una lista manual o una playlist de YouTube para correr el pipeline desde una sola vista.'}
          </p>
        </div>
      </header>

      <AiRuntimeBanner health={health} error={healthError} onRefreshHealth={refreshHealth} />

      <section className="workflow-grid">
        <JobForm isSubmitting={isSubmitting} onSubmit={handleSubmit} />
        <JobStatus
          job={job}
          error={error}
          onCancel={handleCancelPipeline}
          isCancelling={isCancelling}
          onReprocess={handleReprocess}
          isReprocessing={isReprocessing}
          health={jobHealth}
          selectedItemId={selectedItemId}
          onSelectItem={handleSelectItem}
        />
      </section>

      <section className="content-grid">
        <div className="content-main">
          <SummaryPreview content={summaryContent} isLoading={isSummaryLoading} />
          <FileList files={activeFiles} title={selectedItem ? `Archivos de ${selectedItem.itemId}` : 'Archivos generados'} />
        </div>

        <div className="content-side">
          <SystemMemoryWidget visible={job !== null} />
          <GroundingSummary report={groundingReport} files={activeFiles} isLoading={isValidationLoading} health={jobHealth} />
          <JobResourceUsagePanel resourceUsage={job?.resourceUsage} scope={job?.resourceUsageScope} batchWallClockMs={job?.batchWallClockMs} />
          <ValidationSummary report={groundingReport ? null : validationReport} files={activeFiles} isLoading={isValidationLoading} />
        </div>
      </section>

      <section className="panel forensic-panel">
        <div className="panel-header">
          <div>
            <h2>Forense y logs técnicos</h2>
            <p className="panel-caption">Todo lo operativo va arriba. Acá dejás lo fino: logs, rutas, trazas y debugging del pipeline.</p>
          </div>
          <button
            type="button"
            className="ghost-button"
            onClick={() => setAreLogsCollapsed((current) => !current)}
          >
            {areLogsCollapsed ? 'Mostrar detalle técnico' : 'Ocultar detalle técnico'}
          </button>
        </div>
        <p className="panel-caption">{logsCaption}</p>
        {!areLogsCollapsed ? (
          <pre className="log-viewer">{visibleLogsText || 'Todavía no hay logs.'}</pre>
        ) : null}
      </section>
    </main>
  );
}

export default App;
