import type { JobResponse } from '../api';

interface JobStatusProps {
  job: JobResponse | null;
  error: string | null;
}

export function JobStatus({ job, error }: JobStatusProps) {
  return (
    <section className="panel">
      <h2>Estado</h2>

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
            <p className={`status-pill status-${job.status}`}>{job.status}</p>
          </div>
          <div>
            <strong>URL</strong>
            <p>{job.url}</p>
          </div>
          <div>
            <strong>Output</strong>
            <p>{job.outputDir}</p>
          </div>
          {job.error ? (
            <div className="status-error">
              <strong>Error</strong>
              <p>{job.error}</p>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
