import type { JobResponse } from '../api';

interface JobStatusProps {
  job: JobResponse | null;
  error: string | null;
  onCancel: () => void;
  isCancelling: boolean;
  onReprocess: () => void;
  isReprocessing: boolean;
}

const TERMINAL_JOB_STATUSES = new Set(['completed', 'completed_with_warnings', 'failed', 'cancelled']);
const REUSABLE_JOB_STATUSES = new Set(['completed', 'completed_with_warnings']);

export function JobStatus({ job, error, onCancel, isCancelling, onReprocess, isReprocessing }: JobStatusProps) {
  const userFacingJobError = job?.error?.split('\n')[0]
  const statusLabel = job?.status === 'completed_with_warnings'
    ? 'Completado con advertencias'
    : job?.status === 'cancelled'
      ? 'Cancelado'
      : job?.status === 'cancelling'
        ? 'Cancelando'
        : job?.status
  const canCancel = job != null && !TERMINAL_JOB_STATUSES.has(job.status) && job.status !== 'cancelling'
  const canReprocess = job != null && REUSABLE_JOB_STATUSES.has(job.status)

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Estado</h2>
        <div className="panel-actions">
          {canReprocess ? (
            <button
              type="button"
              className="secondary-button"
              onClick={onReprocess}
              disabled={isReprocessing}
              title="Crea un nuevo job reutilizando la transcripción del actual y re-ejecuta solo el procesamiento de ventanas."
            >
              {isReprocessing ? 'Encolando...' : 'Reprocesar (reusa transcripción)'}
            </button>
          ) : null}
          <button
            type="button"
            className="danger-button"
            onClick={onCancel}
            disabled={!canCancel || isCancelling}
          >
            {isCancelling || job?.status === 'cancelling' ? 'Frenando pipeline...' : 'Frenar pipeline y apagar IA'}
          </button>
        </div>
      </div>

      {error ? <p className="error-message">{error}</p> : null}

      {!job ? (
        <p>Todavía no hay jobs cargados.</p>
      ) : (
        <div className="status-grid">
          <div>
            <strong>Job ID</strong>
            <p>{job.id}</p>
          </div>
          <div>
            <strong>Estado actual</strong>
            <p className={`status-pill status-${job.status}`}>{statusLabel}</p>
          </div>
          <div>
            <strong>Logs</strong>
            <p>{job.logCount} líneas{job.logsTruncated ? ' (vista parcial)' : ''}</p>
          </div>
          <div>
            <strong>URL</strong>
            <p>{job.url}</p>
          </div>
          <div>
            <strong>Output</strong>
            <p>{job.outputDir}</p>
          </div>
          {job.modelMetadata ? (
            <div>
              <strong>Modelo usado</strong>
              <p>{job.modelMetadata.ollamaModelUsed} ({job.modelMetadata.modelSelectionSource === 'runtime_state' ? 'selección persistida' : 'default .env'})</p>
            </div>
          ) : null}
          {job.reusedFromJobId ? (
            <div>
              <strong>Reutilizó transcripción de</strong>
              <p>{job.reusedFromJobId}</p>
            </div>
          ) : null}
          {job.error ? (
            <div className="status-error">
              <strong>Error</strong>
              <p>{userFacingJobError}</p>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
