import type { HealthResponse } from '../api';

interface AiRuntimeBannerProps {
  health: HealthResponse | null;
  error: string | null;
}

function getRuntimeMessage(health: HealthResponse | null): string {
  if (!health) {
    return 'Cargando estado del runtime de IA...';
  }

  switch (health.aiRuntime) {
    case 'starting':
      return 'IA iniciando con gemma3:12b...';
    case 'busy':
      return 'IA procesando con gemma3:12b...';
    case 'idle':
      if (!health.ownedByCurrentSession && !health.nextShutdownAt) {
        return 'IA en espera sobre un runtime externo.';
      }
      return 'IA en descanso. Se apagará automáticamente si no hay nuevas tareas.';
    case 'offline':
      return 'IA apagada. Se levantará automáticamente al iniciar una tarea.';
    case 'stopping':
      return 'IA apagándose para liberar memoria...';
    case 'error':
      return 'La IA tuvo un problema al iniciar o apagarse. Revisá los logs del backend.';
    case 'ready':
      return 'IA lista con gemma3:12b.';
    default:
      return 'Estado de IA desconocido.';
  }
}

export function AiRuntimeBanner({ health, error }: AiRuntimeBannerProps) {
  const message = error
    ? `No se pudo consultar el runtime de IA: ${error}`
    : getRuntimeMessage(health);

  return (
    <section className="panel ai-runtime-panel">
      <div className="panel-header">
        <h2>Runtime de IA</h2>
        {health ? <span className={`status-pill status-${health.aiRuntime}`}>{health.aiRuntime}</span> : null}
      </div>
      <p className="panel-caption">{message}</p>
      {health ? (
        <div className="status-grid">
          <div>
            <strong>Modelo</strong>
            <p>{health.ollamaModel}</p>
          </div>
          <div>
            <strong>Jobs IA activos</strong>
            <p>{health.activeJobsCount}</p>
          </div>
          <div>
            <strong>Ownership</strong>
            <p>{health.ownedByCurrentSession ? 'Esta sesión controla Ollama' : 'Runtime externo o apagado'}</p>
          </div>
          <div>
            <strong>Idle shutdown</strong>
            <p>{Math.round(health.idleShutdownMs / 60000)} min</p>
          </div>
          {health.lastActivityAt ? (
            <div>
              <strong>Última actividad</strong>
              <p>{new Date(health.lastActivityAt).toLocaleString()}</p>
            </div>
          ) : null}
          {health.nextShutdownAt ? (
            <div>
              <strong>Próximo apagado</strong>
              <p>{new Date(health.nextShutdownAt).toLocaleString()}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
