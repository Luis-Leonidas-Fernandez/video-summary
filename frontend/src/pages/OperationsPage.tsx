import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AiRuntimeBanner } from '../components/AiRuntimeBanner';
import { DesktopEnvironmentPanel } from '../components/DesktopEnvironmentPanel';
import { JobForm } from '../components/JobForm';
import { JobStatus } from '../components/JobStatus';
import { SystemMemoryWidget } from '../components/SystemMemoryWidget';
import { type CreateJobPayload } from '../api';
import { isDesktopApp } from '../desktop';
import { useJobSession } from '../hooks/useJobSession';
import { useRuntimeHealth } from '../hooks/useRuntimeHealth';
import { buildReviewRoute, getJobModeLabel, getWorkflowHeadline, pickDefaultItemId } from '../job-ui';
import { deriveJobHealth } from '../presentation';

function getStoredLastJobId(): string | null {
  return localStorage.getItem('lastJobId');
}

export function OperationsPage() {
  const desktopMode = isDesktopApp();
  const [initialJobId] = useState<string | null>(() => getStoredLastJobId());
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const itemSelectionPinnedRef = useRef(false);
  const { health, healthError, refreshHealth } = useRuntimeHealth();
  const {
    job,
    error,
    isLoadingJob,
    isSubmitting,
    isCancelling,
    isReprocessing,
    createNewJob,
    cancelCurrentJob,
    reprocessCurrentJob,
  } = useJobSession({
    initialJobId,
    persistLastJob: true,
  });

  const jobHealth = useMemo(() => deriveJobHealth(job, null, null), [job]);

  const enabledOutputsLabel = useMemo(() => {
    if (!job) {
      return 'transcripción · traducción · estudio';
    }

    const labels = [
      job.generateTranscription ? 'transcripción' : null,
      job.generateTranslation ? 'traducción' : null,
      job.generateSummary ? 'estudio' : null,
    ].filter(Boolean);

    return labels.length > 0 ? labels.join(' · ') : 'sin salidas activas';
  }, [job]);

  const heroStatusLabel = job ? getWorkflowHeadline(job) : 'Sin job activo';
  const reviewUrl = job ? buildReviewRoute(job.id) : null;
  const reviewCtaLabel = job
    ? (job.status === 'completed' || job.status === 'completed_with_warnings' || job.status === 'failed' || job.status === 'cancelled'
      ? 'Abrir último job procesado'
      : 'Abrir revisión del job actual')
    : null;

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

  const handleSubmit = async (payload: CreateJobPayload) => {
    setSelectedItemId(null);
    itemSelectionPinnedRef.current = false;
    await createNewJob(payload);
  };

  const handleReprocess = async () => {
    setSelectedItemId(null);
    itemSelectionPinnedRef.current = false;
    await reprocessCurrentJob();
  };

  const handleCancel = async () => {
    await cancelCurrentJob();
    await refreshHealth();
  };

  const handleSelectItem = (itemId: string) => {
    itemSelectionPinnedRef.current = true;
    setSelectedItemId(itemId);
  };

  return (
    <main className="app-shell">
      <header className="app-hero panel panel-hero">
        <div className="hero-main">
          <p className="eyebrow">Operations · local-first · auditable</p>
          <h1>Procesamiento local de video, claro de punta a punta</h1>
          <p className="hero-copy">
            Esta vista queda enfocada en operar: runtime, modelo, creación del job, monitoreo del lote y acciones principales.
          </p>
          <div className="hero-inline-list">
            <span className="subtle-pill">Modo: {getJobModeLabel(job)}</span>
            <span className="subtle-pill">Modelo: {health?.ollamaModel ?? job?.modelMetadata?.ollamaModelUsed ?? 'sin dato'}</span>
            <span className="subtle-pill">Salidas: {enabledOutputsLabel}</span>
          </div>
        </div>
        <div className="hero-aside">
          <span className="hero-kicker">Workflow actual</span>
          <strong>{getWorkflowHeadline(job)}</strong>
          <p>
            {job
              ? `Job ${job.id.slice(0, 8)} · ${getJobModeLabel(job)}${job.summary ? ` · ${job.summary.totalItems} item(s)` : ''}`
              : 'Pegá una URL única, una lista manual o una playlist de YouTube y corré todo desde la misma vista.'}
          </p>
          <div className="hero-stat-grid">
            <div className="hero-stat-card">
              <span className="hero-stat-label">Estado</span>
              <strong className="hero-stat-value">{job ? job.status.replaceAll('_', ' ') : isLoadingJob ? 'loading' : 'idle'}</strong>
              <span className="hero-stat-meta">{heroStatusLabel}</span>
            </div>
            <div className="hero-stat-card">
              <span className="hero-stat-label">Items</span>
              <strong className="hero-stat-value">{job?.summary?.totalItems ?? 0}</strong>
              <span className="hero-stat-meta">
                {job ? `activos ${job.summary?.pendingItems ?? 0} · warning ${job.summary?.warningItems ?? 0}` : 'sin lote cargado'}
              </span>
            </div>
            <div className="hero-stat-card">
              <span className="hero-stat-label">Health</span>
              <strong className="hero-stat-value">{jobHealth?.label ?? 'Preparado'}</strong>
              <span className="hero-stat-meta">{jobHealth?.description ?? 'Esperando una nueva corrida.'}</span>
            </div>
          </div>
        </div>
      </header>

      <AiRuntimeBanner health={health} error={healthError} onRefreshHealth={refreshHealth} />

      <section className="workflow-grid">
        <JobForm isSubmitting={isSubmitting} onSubmit={handleSubmit} />
        <JobStatus
          job={job}
          error={error}
          onCancel={handleCancel}
          isCancelling={isCancelling}
          onReprocess={handleReprocess}
          isReprocessing={isReprocessing}
          health={jobHealth}
          selectedItemId={selectedItemId}
          onSelectItem={handleSelectItem}
          reviewUrl={reviewUrl}
        />
      </section>

      <section className="content-grid">
        <div className="content-main">
          <section className="panel page-focus-panel">
            <div className="panel-header panel-header-top">
              <div>
                <p className="eyebrow">Siguiente paso</p>
                <h2>Revisión separada del resultado</h2>
                <p className="panel-caption">
                  La auditoría completa ahora vive en otra página: summary, artifacts, grounding, validation, recursos y logs.
                </p>
              </div>
            </div>
            <div className="review-cta-box">
              <p className="panel-caption">
                {job
                  ? 'Cuando quieras mirar el resultado en serio, abrí la página de review del job actual.'
                  : 'Primero creá o restaurá un job. Después vas a poder abrir la revisión completa sin mezclarla con la operación.'}
              </p>
              {reviewUrl && reviewCtaLabel ? (
                <Link to={reviewUrl} className="secondary-button button-link">
                  {reviewCtaLabel}
                </Link>
              ) : null}
            </div>
          </section>
        </div>

        <div className="content-side">
          {desktopMode ? <DesktopEnvironmentPanel /> : null}
          <SystemMemoryWidget visible />
        </div>
      </section>
    </main>
  );
}
