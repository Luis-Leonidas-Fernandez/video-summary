import type { BatchJobItem, JobResponse, ResourceUsageScope } from '../api';
import type { JobHealthInfo } from '../presentation';

interface JobStatusProps {
  job: JobResponse | null;
  error: string | null;
  onCancel: () => void;
  isCancelling: boolean;
  onReprocess: () => void;
  isReprocessing: boolean;
  health: JobHealthInfo | null;
  selectedItemId: string | null;
  onSelectItem: (itemId: string) => void | Promise<void>;
}

const TERMINAL_JOB_STATUSES = new Set(['completed', 'completed_with_warnings', 'failed', 'cancelled']);
const REUSABLE_JOB_STATUSES = new Set(['completed', 'completed_with_warnings']);

function getStatusLabel(status: JobResponse['status'] | undefined): string {
  if (!status) {
    return 'Sin job';
  }

  switch (status) {
    case 'completed_with_warnings':
      return 'Completado con advertencias';
    case 'cancelled':
      return 'Cancelado';
    case 'cancelling':
      return 'Cancelando';
    case 'queued':
    case 'pending':
      return 'En cola';
    case 'resolving_sources':
      return 'Resolviendo fuentes';
    case 'processing':
      return 'Procesando lote';
    case 'downloading':
      return 'Descargando';
    case 'transcribing':
      return 'Transcribiendo';
    case 'translating':
      return 'Traduciendo';
    case 'summarizing':
      return 'Generando material';
    default:
      return status;
  }
}

function getProgressLabel(job: JobResponse | null): string {
  if (!job) {
    return 'Sin actividad';
  }

  if (typeof job.progress === 'number') {
    return `${Math.round(job.progress)}%`;
  }

  if (TERMINAL_JOB_STATUSES.has(job.status)) {
    return '100%';
  }

  return 'En curso';
}

function getItemStatusLabel(status: NonNullable<JobResponse['items']>[number]['status']): string {
  switch (status) {
    case 'warning':
      return 'warning';
    case 'processing':
      return 'procesando';
    case 'pending':
      return 'pendiente';
    case 'completed':
      return 'ok';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return status;
  }
}

function formatDuration(durationMs?: number): string {
  if (durationMs == null || Number.isNaN(durationMs)) {
    return '—';
  }

  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

function getResourceScopeLabel(scope?: ResourceUsageScope): string {
  switch (scope) {
    case 'batch_aggregate':
      return 'Agregado del lote';
    case 'last_item':
      return 'Último item';
    case 'single_item':
      return 'Item único';
    default:
      return 'No informado';
  }
}

function getGroundingStatusLabel(item: BatchJobItem): string {
  switch (item.groundingStatus) {
    case 'grounded':
      return 'grounded';
    case 'partially_grounded':
      return 'partially grounded';
    case 'needs_human_review':
      return 'needs review';
    case 'too_compressed':
      return 'too compressed';
    case 'failed_grounding':
      return 'failed grounding';
    case 'legacy_warning':
      return 'legacy warning';
    default:
      return item.groundingStatus ?? 'sin grounding';
  }
}

function getTranscriptionQualityLabel(item: BatchJobItem): string {
  switch (item.transcriptionQuality) {
    case 'ok':
      return 'transcripción ok';
    case 'suspicious':
      return 'transcripción sospechosa';
    case 'poor':
      return 'transcripción pobre';
    default:
      return 'sin señal';
  }
}

function getTranslationStatusLabel(status?: JobResponse['translationStatus'] | BatchJobItem['translationStatus']): string {
  switch (status) {
    case 'reused_spanish_transcription':
      return 'español reutilizado';
    case 'translated_to_spanish':
      return 'traducido al español';
    case 'skipped':
      return 'sin traducción';
    default:
      return 'sin dato';
  }
}

export function JobStatus({
  job,
  error,
  onCancel,
  isCancelling,
  onReprocess,
  isReprocessing,
  health,
  selectedItemId,
  onSelectItem,
}: JobStatusProps) {
  const userFacingJobError = job?.error?.split('\n')[0];
  const statusLabel = getStatusLabel(job?.status);
  const canCancel = job != null && !TERMINAL_JOB_STATUSES.has(job.status) && job.status !== 'cancelling';
  const canReprocess = job != null && REUSABLE_JOB_STATUSES.has(job.status) && job.inputMode === 'single_url';
  const selectedItem = job?.items?.find((item) => item.itemId === selectedItemId) ?? null;

  return (
    <section className="panel job-status-panel">
      <div className="panel-header panel-header-top">
        <div>
          <p className="eyebrow">Job activo</p>
          <h2>Estado y control</h2>
          <p className="panel-caption">Operación primero: estado, health, progreso, lote y acciones. Lo forense queda más abajo.</p>
        </div>
        <div className="panel-actions">
          {canReprocess ? (
            <button
              type="button"
              className="secondary-button"
              onClick={onReprocess}
              disabled={isReprocessing}
              title="Crea un nuevo job reutilizando la transcripción del actual y re-ejecuta solo el procesamiento de ventanas."
            >
              {isReprocessing ? 'Encolando...' : 'Reprocesar'}
            </button>
          ) : null}
          <button
            type="button"
            className="danger-button"
            onClick={onCancel}
            disabled={!canCancel || isCancelling}
          >
            {isCancelling || job?.status === 'cancelling' ? 'Frenando pipeline...' : 'Cancelar job'}
          </button>
        </div>
      </div>

      {error ? <p className="error-message">{error}</p> : null}

      {!job ? (
        <div className="empty-state">
          <p>Todavía no hay jobs cargados.</p>
          <p className="panel-caption">Creá uno nuevo desde el formulario y la vista se llena sola con progreso, grounding y outputs.</p>
        </div>
      ) : (
        <>
          <div className="status-hero-card">
            <div>
              <p className="eyebrow">Running summary</p>
              <div className="status-badges">
                <span className={`status-pill status-${job.status}`}>{statusLabel}</span>
                {health ? <span className={`status-pill health-pill health-${health.status}`}>Health: {health.label}</span> : null}
              </div>
              <p className="status-hero-copy">{health?.description ?? 'Seguimiento operativo del job actual.'}</p>
            </div>
            <div className="status-progress-block">
              <span className="status-progress-label">Progreso</span>
              <strong>{getProgressLabel(job)}</strong>
              {job.modelMetadata ? <span className="status-inline-meta">Modelo: {job.modelMetadata.ollamaModelUsed}</span> : null}
              {job.batchWallClockMs != null ? <span className="status-inline-meta">Duración lote: {formatDuration(job.batchWallClockMs)}</span> : null}
            </div>
          </div>

          <div className="status-metric-grid">
            <div className="metric-card">
              <span className="metric-label">Entrada</span>
              <p className="metric-value metric-value-compact">{job.inputMode === 'url_list' ? 'Lista manual' : job.inputMode === 'playlist' ? 'Playlist' : job.url}</p>
              <span className="metric-hint">{job.inputMode === 'single_url' ? job.url : `${job.summary?.totalItems ?? 0} item(s)`}</span>
            </div>
            <div className="metric-card">
              <span className="metric-label">Items</span>
              <p className="metric-value">{job.summary?.totalItems ?? job.items?.length ?? 0}</p>
              <span className="metric-hint">
                OK {job.summary?.completedItems ?? 0} · warning {job.summary?.warningItems ?? 0} · failed {job.summary?.failedItems ?? 0}
              </span>
            </div>
            <div className="metric-card">
              <span className="metric-label">Pendientes</span>
              <p className="metric-value">{job.summary?.pendingItems ?? 0}</p>
              <span className="metric-hint">Cancelados {job.summary?.cancelledItems ?? 0}</span>
            </div>
            <div className="metric-card">
              <span className="metric-label">Duración total</span>
              <p className="metric-value">{formatDuration(job.batchWallClockMs)}</p>
              <span className="metric-hint">Recursos: {getResourceScopeLabel(job.resourceUsageScope)}</span>
            </div>
            {job.modelMetadata ? (
              <div className="metric-card">
                <span className="metric-label">Modelo usado</span>
                <p className="metric-value metric-value-compact">{job.modelMetadata.ollamaModelUsed}</p>
                <span className="metric-hint">{job.modelMetadata.modelSelectionSource === 'runtime_state' ? 'Selección persistida' : 'Default del .env'}</span>
              </div>
            ) : null}
            {job.reusedFromJobId ? (
              <div className="metric-card">
                <span className="metric-label">Reutilización</span>
                <p className="metric-value metric-value-compact">{job.reusedFromJobId}</p>
                <span className="metric-hint">Reusa transcripción anterior</span>
              </div>
            ) : null}
          </div>

          {selectedItem ? (
            <div className="inline-alert inline-alert-info">
              <strong>{selectedItem.itemId}</strong>
              <p>
                Estado {getItemStatusLabel(selectedItem.status)} · grounding {getGroundingStatusLabel(selectedItem)} · {getTranscriptionQualityLabel(selectedItem)} · duración {formatDuration(selectedItem.itemWallClockMs)}
              </p>
              <p>
                Fuente {selectedItem.detectedSourceLanguage ?? 'sin dato'} · salida {getTranslationStatusLabel(selectedItem.translationStatus)} · claims {selectedItem.claimsValidated ?? 0} · unsupported {selectedItem.unsupportedClaimCount ?? 0} · citas inválidas {selectedItem.invalidCitationCount ?? 0} · ventanas comprimidas {selectedItem.windowsTooCompressed ?? 0}
              </p>
            </div>
          ) : null}

          {job.error ? (
            <div className="inline-alert inline-alert-danger">
              <strong>Error principal</strong>
              <p>{userFacingJobError}</p>
              {job.resolutionError ? <p>Resolución de fuentes: {job.resolutionError}</p> : null}
            </div>
          ) : null}

          {job.items && job.items.length > 0 ? (
            <div className="item-selector-panel">
              <div className="item-selector-header">
                <div>
                  <strong>Items del lote</strong>
                  <p className="panel-caption">Elegí qué video querés inspeccionar abajo. Cada item mantiene artifacts y estado aislados.</p>
                </div>
                {job.summary?.activeItemId ? <span className="status-pill subtle-pill">Activo: {job.summary.activeItemId}</span> : null}
              </div>
              <div className="item-selector-list">
                {job.items.map((item) => {
                  const isSelected = item.itemId === selectedItemId;
                  return (
                    <button
                      key={item.itemId}
                      type="button"
                      className={`item-chip ${isSelected ? 'item-chip-selected' : ''}`}
                      onClick={() => void onSelectItem(item.itemId)}
                    >
                      <span className="item-chip-index">{item.itemId}</span>
                      <span className={`item-chip-status item-chip-status-${item.status}`}>{getItemStatusLabel(item.status)}</span>
                      <span className="item-chip-url">{item.sourceUrl}</span>
                      <span className="item-chip-url">{getGroundingStatusLabel(item)} · {getTranscriptionQualityLabel(item)} · {getTranslationStatusLabel(item.translationStatus)}</span>
                      {typeof item.progress === 'number' ? <span className="item-chip-progress">{Math.round(item.progress)}%</span> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : job.status === 'resolving_sources' ? (
            <div className="inline-alert inline-alert-info">
              <strong>Resolviendo playlist</strong>
              <p>El job padre ya existe, pero todavía no creó items. Esto evita timeouts mientras yt-dlp expande la playlist.</p>
            </div>
          ) : null}

          <details className="disclosure-card">
            <summary>Ver metadata técnica del job</summary>
            <div className="disclosure-content metadata-grid">
              <div>
                <strong>Job ID</strong>
                <p>{job.id}</p>
              </div>
              <div>
                <strong>Modo</strong>
                <p>{job.inputMode}</p>
              </div>
              <div>
                <strong>Output</strong>
                <p>{job.outputDir}</p>
              </div>
              <div>
                <strong>Idioma del audio</strong>
                <p>{job.transcriptionLanguage}</p>
              </div>
              <div>
                <strong>Idioma final</strong>
                <p>{job.outputLanguage}</p>
              </div>
              <div>
                <strong>Idioma detectado</strong>
                <p>{job.detectedSourceLanguage ?? selectedItem?.detectedSourceLanguage ?? 'sin dato'}</p>
              </div>
              <div>
                <strong>Estado traducción</strong>
                <p>{getTranslationStatusLabel(job.translationStatus ?? selectedItem?.translationStatus)}</p>
              </div>
              <div>
                <strong>Inicio</strong>
                <p>{job.startedAt ? new Date(job.startedAt).toLocaleString() : '—'}</p>
              </div>
              <div>
                <strong>Fin</strong>
                <p>{job.completedAt ? new Date(job.completedAt).toLocaleString() : '—'}</p>
              </div>
              <div>
                <strong>Transcripción</strong>
                <p>{job.generateTranscription ? 'Sí' : 'No'}</p>
              </div>
              <div>
                <strong>Traducción</strong>
                <p>{job.generateTranslation ? 'Sí' : 'No'}</p>
              </div>
              <div>
                <strong>Resumen</strong>
                <p>{job.generateSummary ? 'Sí' : 'No'}</p>
              </div>
              {job.speakerCountHint ? (
                <div>
                  <strong>Hint speakers</strong>
                  <p>{job.speakerCountHint}</p>
                </div>
              ) : null}
              {job.resolvedAt ? (
                <div>
                  <strong>Fuentes resueltas</strong>
                  <p>{new Date(job.resolvedAt).toLocaleString()}</p>
                </div>
              ) : null}
              {job.failurePolicy ? (
                <div>
                  <strong>Failure policy</strong>
                  <p>{job.failurePolicy}</p>
                </div>
              ) : null}
            </div>
          </details>
        </>
      )}
    </section>
  );
}
