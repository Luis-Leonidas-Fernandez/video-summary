import { useEffect, useState } from 'react';
import { getSystemDiagnostics, type SystemDiagnosticsResponse } from '../api';

function getDependencyTone(ok: boolean): 'healthy' | 'failed' {
  return ok ? 'healthy' : 'failed';
}

function summarizeCatalogModels(modelNames: string[] | undefined): string {
  if (!modelNames || modelNames.length === 0) {
    return 'Sin modelos reportados';
  }

  if (modelNames.length <= 4) {
    return modelNames.join(', ');
  }

  return `${modelNames.slice(0, 4).join(', ')} +${modelNames.length - 4} más`;
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
            <span className={`status-pill ${diagnostics.catalogReachable ? 'health-healthy' : 'health-warning'}`}>
              Ollama catálogo: {diagnostics.catalogReachable ? 'reachable' : 'sin respuesta'}
            </span>
          </div>

          <div className="desktop-dependency-list">
            <article className="desktop-dependency-card">
              <div className="desktop-dependency-topline">
                <strong>Backend PATH efectivo</strong>
                <span className="status-pill subtle-pill">Desktop env</span>
              </div>
              <p className="panel-caption">
                Este es el PATH que ve el backend embebido dentro de la app desktop. Si Finder no hereda Homebrew, el problema aparece acá.
              </p>
              <details className="details-panel">
                <summary>Ver PATH completo</summary>
                <p className="desktop-dependency-meta">{diagnostics.backendPath || '(vacío)'}</p>
              </details>
            </article>

            <article className="desktop-dependency-card">
              <div className="desktop-dependency-topline">
                <strong>Catálogo Ollama consultado</strong>
                <span className={`status-pill ${diagnostics.catalogReachable ? 'health-healthy' : 'health-warning'}`}>
                  {diagnostics.catalogModelCount ?? 0} modelo(s)
                </span>
              </div>
              <p className="desktop-dependency-meta">Base URL: {diagnostics.ollamaBaseUrl}</p>
              <p className="panel-caption">{summarizeCatalogModels(diagnostics.catalogModelNames)}</p>
              {diagnostics.catalogModelNames && diagnostics.catalogModelNames.length > 0 ? (
                <details className="details-panel">
                  <summary>Ver nombres detectados</summary>
                  <ul className="forensic-list">
                    {diagnostics.catalogModelNames.map((modelName) => (
                      <li key={modelName}>{modelName}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </article>
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
                {dependency.configuredCommand ? (
                  <p className="desktop-dependency-meta">Comando configurado: {dependency.configuredCommand}</p>
                ) : null}
                {dependency.resolvedValue ? (
                  <p className="desktop-dependency-meta">Resuelto: {dependency.resolvedValue}</p>
                ) : null}
                {dependency.source ? (
                  <p className="desktop-dependency-meta">Fuente: {dependency.source}</p>
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
