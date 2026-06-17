import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { FileList } from '../components/FileList';
import { GroundingSummary } from '../components/GroundingSummary';
import { JobResourceUsagePanel } from '../components/JobResourceUsagePanel';
import { SummaryPreview } from '../components/SummaryPreview';
import { ValidationSummary } from '../components/ValidationSummary';
import { resolveApiUrl } from '../desktop';
import { useJobArtifacts } from '../hooks/useJobArtifacts';
import { useJobSession } from '../hooks/useJobSession';
import {
  buildBatchWordZipDownloadUrl,
  getJobModeLabel,
  getSelectedItem,
  getWorkflowHeadline,
  hasBatchWordExports,
  pickDefaultItemId,
} from '../job-ui';
import { deriveJobHealth } from '../presentation';

export function JobReviewPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [areLogsCollapsed, setAreLogsCollapsed] = useState(false);
  const itemSelectionPinnedRef = useRef(false);
  const {
    job,
    error,
    isLoadingJob,
  } = useJobSession({
    initialJobId: jobId ?? null,
    persistLastJob: false,
  });

  const {
    files,
    summaryContent,
    groundingReport,
    validationReport,
    isSummaryLoading,
    isValidationLoading,
    artifactError,
  } = useJobArtifacts(job, selectedItemId);

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
    if (job?.status === 'completed' || job?.status === 'completed_with_warnings') {
      setAreLogsCollapsed(true);
    }
  }, [job?.status]);

  const selectedItem = useMemo(() => getSelectedItem(job, selectedItemId), [job, selectedItemId]);
  const hasBatchWordZip = useMemo(() => hasBatchWordExports(job), [job]);
  const batchWordZipUrl = useMemo(
    () => (job && hasBatchWordExports(job) ? buildBatchWordZipDownloadUrl(job.id) : null),
    [job],
  );
  const jobHealth = useMemo(
    () => deriveJobHealth(job, groundingReport, validationReport),
    [job, groundingReport, validationReport],
  );
  const activeFiles = useMemo(() => (files.length > 0 ? files : job?.files ?? []), [files, job?.files]);
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

  const handleSelectItem = (itemId: string) => {
    itemSelectionPinnedRef.current = true;
    setSelectedItemId(itemId);
  };

  if (!jobId) {
    return (
      <main className="app-shell">
        <section className="panel empty-state-panel">
          <h1>Review no disponible</h1>
          <p className="panel-caption">La URL no tiene un job válido para revisar.</p>
          <Link to="/" className="secondary-button button-link">Volver a operación</Link>
        </section>
      </main>
    );
  }

  if (!job && isLoadingJob) {
    return (
      <main className="app-shell">
        <section className="panel empty-state-panel">
          <h1>Cargando review</h1>
          <p className="panel-caption">Estamos levantando el job {jobId} para mostrar summary, artifacts y grounding.</p>
        </section>
      </main>
    );
  }

  if (!job) {
    return (
      <main className="app-shell">
        <section className="panel empty-state-panel">
          <h1>Job no disponible</h1>
          <p className="panel-caption">{error ?? 'No se encontró un job con ese identificador o ya no está disponible.'}</p>
          <Link to="/" className="secondary-button button-link">Volver a operación</Link>
        </section>
      </main>
    );
  }

  const visibleLogsText = job.logs.join('\n');

  return (
    <main className="app-shell">
      <header className="panel review-header-panel">
        <div className="review-header-topline">
          <Link to="/" className="ghost-button button-link">← Volver a operación</Link>
          <div className="status-badges">
            <span className={`status-pill status-${job.status}`}>{job.status.replace(/_/g, ' ')}</span>
            {jobHealth ? <span className={`status-pill health-pill health-${jobHealth.status}`}>Health: {jobHealth.label}</span> : null}
          </div>
        </div>

        <div className="review-header-grid">
          <div>
            <p className="eyebrow">Review page</p>
            <h1>Revisión completa del job</h1>
            <p className="hero-copy">
              Esta página separa lectura, grounding y forense técnico de la operación diaria. Acá revisás el resultado con más contexto y menos ruido operativo.
            </p>
          </div>

          <div className="hero-aside">
            <span className="hero-kicker">Job seleccionado</span>
            <strong>{getWorkflowHeadline(job)}</strong>
            <p>Job {job.id.slice(0, 8)} · {getJobModeLabel(job)}{job.summary ? ` · ${job.summary.totalItems} item(s)` : ''}</p>
            <div className="hero-inline-list">
              <span className="subtle-pill">Modelo: {job.modelMetadata?.ollamaModelUsed ?? 'sin dato'}</span>
              <span className="subtle-pill">Idioma salida: {job.outputLanguage}</span>
              {selectedItem ? <span className="subtle-pill">Item: {selectedItem.itemId}</span> : null}
            </div>
          </div>
        </div>
      </header>

      {artifactError ? (
        <section className="panel">
          <p className="error-message">{artifactError}</p>
        </section>
      ) : null}

      <section className="content-grid">
        <div className="content-main">
          <SummaryPreview content={summaryContent} isLoading={isSummaryLoading} />
          <FileList files={activeFiles} title={selectedItem ? `Archivos de ${selectedItem.itemId}` : 'Archivos generados'} />
        </div>

        <div className="content-side">
          <GroundingSummary report={groundingReport} files={activeFiles} isLoading={isValidationLoading} health={jobHealth} />
          <JobResourceUsagePanel resourceUsage={job.resourceUsage} scope={job.resourceUsageScope} batchWallClockMs={job.batchWallClockMs} />
          <ValidationSummary report={groundingReport ? null : validationReport} files={activeFiles} isLoading={isValidationLoading} />
        </div>
      </section>

      <section className="panel review-items-panel">
        <div className="panel-header panel-header-top">
          <div>
            <p className="eyebrow">Batch review</p>
            <h2>Items y enfoque actual</h2>
            <p className="panel-caption">La selección del item vive solo en esta página. No toca la URL en esta iteración.</p>
          </div>
          <div className="panel-actions">
            {hasBatchWordZip && batchWordZipUrl ? (
              <a href={resolveApiUrl(batchWordZipUrl)} className="secondary-button button-link" download>
                Descargar todos los Word (.zip)
              </a>
            ) : null}
            {selectedItem ? <span className="subtle-pill">Item activo: {selectedItem.itemId}</span> : null}
          </div>
        </div>

        {job.items?.length ? (
          <div className="item-selector-list">
            {job.items.map((item) => {
              const isSelected = item.itemId === selectedItemId;
              return (
                <button
                  key={item.itemId}
                  type="button"
                  className={`item-chip ${isSelected ? 'item-chip-selected' : ''}`}
                  onClick={() => handleSelectItem(item.itemId)}
                >
                  <span className="item-chip-index">{item.itemId}</span>
                  <span className={`item-chip-status item-chip-status-${item.status}`}>{item.status}</span>
                  <div className="item-chip-body">
                    <span className="item-chip-url">{item.sourceUrl}</span>
                    <span className="item-chip-meta">
                      {item.groundingStatus ?? 'sin grounding'} · {item.translationStatus ?? 'sin traducción'} · {item.transcriptionQuality ?? 'sin señal'}
                    </span>
                  </div>
                  <span className="item-chip-progress">{typeof item.progress === 'number' ? `${Math.round(item.progress)}%` : '—'}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="panel-caption">
            {job.status === 'resolving_sources'
              ? 'La playlist todavía está resolviendo fuentes; los items van a aparecer cuando termine esa etapa.'
              : 'Este job no tiene items múltiples para revisar.'}
          </p>
        )}
      </section>

      <section className="panel forensic-panel">
        <div className="panel-header">
          <div>
            <h2>Forense y logs técnicos</h2>
            <p className="panel-caption">Todo el detalle fino queda acá: logs, trazas y debugging del pipeline.</p>
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
