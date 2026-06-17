import { useEffect, useState } from 'react';
import { getSystemDiagnostics, type SystemDiagnosticsResponse } from '../api';

function getDependencyTone(ok: boolean): 'healthy' | 'failed' {
  return ok ? 'healthy' : 'failed';
}

export function DesktopEnvironmentPanel() {
  const [diagnostics, setDiagnostics] = useState<SystemDiagnosticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refreshDiagnostics = async () => {
    setIsLoading(true);
    try {
      const nextDiagnostics = await getSystemDiagnostics();
      setDiagnostics(nextDiagnostics);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'No se pudo cargar el diagnóstico del entorno.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void refreshDiagnostics();
  }, []);

  return (
    <section className="panel desktop-environment-panel">
      <div className="panel-header panel-header-top">
        <div>
          <p className="eyebrow">Desktop readiness</p>
          <h2>Diagnóstico del entorno</h2>
          <p className="panel-caption">
            La app te esconde la terminal, pero igual necesita herramientas locales. Acá ves qué está listo y qué falta sin salir de la UI.
          </p>
        </div>
        <button type="button" className="ghost-button" onClick={() => void refreshDiagnostics()} disabled={isLoading}>
          {isLoading ? 'Verificando...' : 'Revisar entorno'}
        </button>
      </div>

      {error ? <p className="error-message">{error}</p> : null}

      {diagnostics ? (
        <>
          <div className="status-badges">
            <span className={`status-pill ${diagnostics.allRequiredAvailable ? 'health-healthy' : 'health-needs_review'}`}>
              {diagnostics.allRequiredAvailable ? 'Entorno listo' : 'Faltan dependencias'}
            </span>
            <span className="status-pill subtle-pill">Modo: {diagnostics.appMode}</span>
          </div>

          <div className="desktop-dependency-list">
            {diagnostics.dependencies.map((dependency) => (
              <article key={dependency.key} className={`desktop-dependency-card desktop-dependency-${getDependencyTone(dependency.ok)}`}>
                <div className="desktop-dependency-topline">
                  <strong>{dependency.label}</strong>
                  <span className={`status-pill health-${getDependencyTone(dependency.ok)}`}>{dependency.ok ? 'OK' : 'Falta'}</span>
                </div>
                <p className="panel-caption">{dependency.detail}</p>
                <p className="desktop-dependency-meta">Esperado: {dependency.expected}</p>
                {dependency.resolvedValue ? (
                  <p className="desktop-dependency-meta">Configurado: {dependency.resolvedValue}</p>
                ) : null}
                {dependency.resolutionHint ? (
                  <p className="desktop-dependency-hint">{dependency.resolutionHint}</p>
                ) : null}
              </article>
            ))}
          </div>
        </>
      ) : (
        !isLoading ? <p className="panel-caption">No hay diagnóstico disponible todavía.</p> : null
      )}
    </section>
  );
}
