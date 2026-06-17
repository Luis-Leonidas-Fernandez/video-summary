import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { deleteAllJobs, deleteJob, listJobs, type JobResponse } from '../api';
import { buildReviewRoute, getJobModeLabel, TERMINAL_STATUSES } from '../job-ui';
import { deriveJobHealth } from '../presentation';

function formatDate(value?: string): string {
  if (!value) {
    return '—';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }

  return date.toLocaleString();
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

function clearStoredLastJobIfMatches(jobId: string) {
  if (localStorage.getItem('lastJobId') === jobId) {
    localStorage.removeItem('lastJobId');
  }
}

export function JobsLibraryPage() {
  const [jobs, setJobs] = useState<JobResponse[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingJobId, setDeletingJobId] = useState<string | null>(null);
  const [isDeletingAll, setIsDeletingAll] = useState(false);

  const loadJobs = useCallback(async () => {
    setIsLoading(true);
    try {
      const nextJobs = await listJobs();
      setJobs(nextJobs);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'No se pudo cargar el listado de jobs.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  const terminalJobsCount = useMemo(
    () => jobs.filter((job) => TERMINAL_STATUSES.has(job.status)).length,
    [jobs],
  );
  const hasActiveJobs = useMemo(
    () => jobs.some((job) => !TERMINAL_STATUSES.has(job.status)),
    [jobs],
  );

  const handleDeleteJob = async (job: JobResponse) => {
    const confirmDelete = window.confirm(`¿Seguro que querés eliminar el job ${job.id}? Esta acción borra sus artifacts.`);
    if (!confirmDelete) {
      return;
    }

    setDeletingJobId(job.id);
    try {
      await deleteJob(job.id);
      clearStoredLastJobIfMatches(job.id);
      setJobs((current) => current.filter((currentJob) => currentJob.id !== job.id));
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'No se pudo eliminar el job.');
    } finally {
      setDeletingJobId(null);
    }
  };

  const handleDeleteAll = async () => {
    const confirmDelete = window.confirm('¿Seguro que querés eliminar TODOS los jobs guardados? Esta acción borra artifacts y logs.');
    if (!confirmDelete) {
      return;
    }

    setIsDeletingAll(true);
    try {
      await deleteAllJobs();
      localStorage.removeItem('lastJobId');
      setJobs([]);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'No se pudieron eliminar los jobs.');
    } finally {
      setIsDeletingAll(false);
    }
  };

  return (
    <main className="app-shell">
      <header className="panel panel-hero jobs-library-hero">
        <div className="hero-main">
          <p className="eyebrow">Biblioteca de jobs</p>
          <h1>Todos los procesamientos guardados</h1>
          <p className="hero-copy">
            Acá ves el inventario completo de jobs: estado, modo, modelo, duración, warnings y acceso directo a la revisión.
          </p>
        </div>
        <div className="hero-aside">
          <span className="hero-kicker">Acciones rápidas</span>
          <strong>{jobs.length} job(s) detectados</strong>
          <p>{terminalJobsCount} terminales listos para limpieza. Si uno sigue activo, primero cancelalo desde Operación.</p>
          <div className="panel-actions">
            <Link to="/" className="secondary-button button-link">
              Volver a Operación
            </Link>
            <button
              type="button"
              className="danger-button"
              onClick={() => void handleDeleteAll()}
              disabled={isDeletingAll || jobs.length === 0 || hasActiveJobs}
              title={hasActiveJobs ? 'Primero cancelá o dejá terminar los jobs activos.' : 'Eliminar todos los jobs terminales.'}
            >
              {isDeletingAll ? 'Eliminando...' : 'Eliminar todos'}
            </button>
          </div>
        </div>
      </header>

      {error ? (
        <div className="inline-alert inline-alert-danger">
          <strong>Ojo</strong>
          <p>{error}</p>
        </div>
      ) : null}

      {isLoading ? (
        <section className="panel">
          <div className="empty-state">
            <p>Cargando jobs guardados...</p>
          </div>
        </section>
      ) : jobs.length === 0 ? (
        <section className="panel">
          <div className="empty-state">
            <p>No hay jobs guardados en este entorno.</p>
            <p className="panel-caption">Cuando proceses videos, esta página te va a dejar limpiarlos uno por uno o de una sola vez.</p>
          </div>
        </section>
      ) : (
        <section className="jobs-library-grid">
          {jobs.map((job) => {
            const health = deriveJobHealth(job, null, null);
            const canDelete = TERMINAL_STATUSES.has(job.status);
            return (
              <article key={job.id} className="panel jobs-library-card">
                <div className="panel-header panel-header-top">
                  <div>
                    <p className="eyebrow">Job {job.id.slice(0, 8)}</p>
                    <h2>{job.originalInput?.playlistUrl ?? job.originalInput?.url ?? job.url}</h2>
                    <p className="panel-caption">
                      {getJobModeLabel(job)} · creado {formatDate(job.createdAt)}
                    </p>
                  </div>
                  <div className="status-badges jobs-library-badges">
                    <span className={`status-pill status-${job.status}`}>{job.status.replace(/_/g, ' ')}</span>
                    {health ? <span className={`status-pill health-pill health-${health.status}`}>{health.label}</span> : null}
                  </div>
                </div>

                <div className="jobs-library-metrics">
                  <div className="metric-card">
                    <span className="metric-label">Items</span>
                    <p className="metric-value">{job.summary?.totalItems ?? job.items?.length ?? 0}</p>
                    <span className="metric-hint">warning {job.summary?.warningItems ?? 0} · failed {job.summary?.failedItems ?? 0}</span>
                  </div>
                  <div className="metric-card">
                    <span className="metric-label">Modelo</span>
                    <p className="metric-value metric-value-compact">{job.modelMetadata?.ollamaModelUsed ?? 'sin dato'}</p>
                    <span className="metric-hint">{job.modelMetadata?.modelSelectionSource ?? 'sin fuente'}</span>
                  </div>
                  <div className="metric-card">
                    <span className="metric-label">Duración</span>
                    <p className="metric-value">{formatDuration(job.batchWallClockMs)}</p>
                    <span className="metric-hint">actualizado {formatDate(job.updatedAt)}</span>
                  </div>
                </div>

                <p className="panel-caption jobs-library-description">
                  {health?.description ?? 'Sin descripción adicional.'}
                </p>

                <div className="panel-actions jobs-library-actions">
                  <Link to={buildReviewRoute(job.id)} className="secondary-button button-link">
                    Abrir revisión
                  </Link>
                  <button
                    type="button"
                    className="danger-button"
                    onClick={() => void handleDeleteJob(job)}
                    disabled={!canDelete || deletingJobId === job.id}
                    title={canDelete ? 'Eliminar job y artifacts' : 'Primero cancelá o esperá a que termine el job.'}
                  >
                    {deletingJobId === job.id ? 'Eliminando...' : 'Eliminar'}
                  </button>
                </div>
              </article>
            );
          })}
        </section>
      )}
    </main>
  );
}
