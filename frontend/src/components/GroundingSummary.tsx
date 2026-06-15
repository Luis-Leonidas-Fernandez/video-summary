import type { GroundingReport, JobFile } from '../api';
import { summarizeGrounding, type JobHealthInfo } from '../presentation';

interface GroundingSummaryProps {
  report: GroundingReport | null;
  files: JobFile[];
  isLoading: boolean;
  health: JobHealthInfo | null;
}

function getStatusLabel(status: GroundingReport['parts'][number]['finalStatus']): string {
  switch (status) {
    case 'grounded':
      return 'Resumen verificado';
    case 'partially_grounded':
      return 'Resumen parcialmente respaldado';
    case 'failed_grounding':
      return 'Resumen con problemas de evidencia';
    case 'needs_human_review':
      return 'Requiere revisión humana';
    case 'too_compressed':
      return 'Demasiado comprimido';
    default:
      return status;
  }
}

function getStatusClassName(status: GroundingReport['parts'][number]['finalStatus']): string {
  if (status === 'grounded') return 'validation-pill validation-accepted';
  if (status === 'partially_grounded') return 'validation-pill validation-accepted_with_warnings';
  return 'validation-pill validation-failed';
}

function findFile(files: JobFile[], name: string): JobFile | undefined {
  return files.find((file) => file.filename === name || file.name === name || file.relativePath === name);
}

function getWindowCoverageLabel(
  status: GroundingReport['parts'][number]['windows'][number]['coverage']['status'],
): string {
  switch (status) {
    case 'too_compressed':
      return 'demasiado comprimida';
    case 'very_detailed':
      return 'muy detallada';
    case 'too_verbose':
      return 'demasiado verbosa';
    case 'needs_review':
      return 'requiere revisión';
    default:
      return 'ok';
  }
}

function getKpiTone(value: number, warnAt: number, failAt: number): string {
  if (value >= failAt) {
    return 'kpi-danger';
  }
  if (value >= warnAt) {
    return 'kpi-warning';
  }
  return 'kpi-ok';
}

export function GroundingSummary({ report, files, isLoading, health }: GroundingSummaryProps) {
  if (isLoading && !report) {
    return (
      <section className="panel grounding-panel">
        <h2>Estado de respaldo</h2>
        <p>Cargando grounding por claims...</p>
      </section>
    );
  }

  if (!report || report.parts.length === 0) {
    return null;
  }

  const summary = summarizeGrounding(report);
  if (!summary) {
    return null;
  }

  return (
    <section className="panel grounding-panel">
      <div className="panel-header panel-header-top">
        <div>
          <p className="eyebrow">Operational summary</p>
          <h2>Grounding y salud del resultado</h2>
          <p className="panel-caption">Semáforo primero. Auditoría fina después.</p>
        </div>
        {health ? <span className={`status-pill health-pill health-${health.status}`}>{health.label}</span> : null}
      </div>

      <div className="kpi-grid">
        <div className={`kpi-card ${getKpiTone(summary.invalidCitationCount, 1, 1)}`}>
          <span>Citas inválidas</span>
          <strong>{summary.invalidCitationCount}</strong>
        </div>
        <div className={`kpi-card ${getKpiTone(summary.unsupportedClaimCount, 1, 1)}`}>
          <span>Claims unsupported</span>
          <strong>{summary.unsupportedClaimCount}</strong>
        </div>
        <div className={`kpi-card ${getKpiTone(summary.fallbackRatePercent, 10, 30)}`}>
          <span>Fallback rate</span>
          <strong>{summary.fallbackRatePercent}%</strong>
        </div>
        <div className={`kpi-card ${getKpiTone(summary.schemaBrokenCount, 1, 1)}`}>
          <span>Schema broken</span>
          <strong>{summary.schemaBrokenCount}</strong>
        </div>
        <div className={`kpi-card ${getKpiTone(summary.thinReasoningCount, 1, 3)}`}>
          <span>Thin reasoning</span>
          <strong>{summary.thinReasoningCount}</strong>
        </div>
        <div className={`kpi-card ${getKpiTone(summary.windowsTooCompressed, 1, 3)}`}>
          <span>Ventanas comprimidas</span>
          <strong>{summary.windowsTooCompressed}</strong>
        </div>
      </div>

      <div className="grounding-summary-bar">
        <span>{summary.reviewedWindows} ventanas auditadas</span>
        <span>{summary.needsHumanReview ? 'Requiere revisión humana' : 'Sin revisión humana obligatoria'}</span>
        {report.performanceSummary ? <span>Pico RAM: {report.performanceSummary.ramPeakTrackedMb} MB</span> : null}
      </div>

      <details className="disclosure-card" open>
        <summary>Ver desglose por parte</summary>
        <div className="disclosure-content validation-list">
          {report.parts.map((part) => {
            const claimsFile = findFile(files, `claims_part_${part.part}.json`);
            const extractionFile = findFile(files, `extraction_part_${part.part}.txt`);
            const evidenceFile = findFile(files, `evidence_part_${part.part}.json`);
            const integrityFile = findFile(files, `citation_integrity_part_${part.part}.json`);
            const problematicClaims = [...part.claimSupport.unsupported, ...part.claimSupport.partiallySupported];

            return (
              <article key={part.part} className="validation-card grounding-part-card">
                <div className="validation-card-header">
                  <div>
                    <h3>Parte {part.part}</h3>
                    <p className="validation-meta">{part.decisionReason}</p>
                  </div>
                  <span className={getStatusClassName(part.finalStatus)}>{getStatusLabel(part.finalStatus)}</span>
                </div>

                <div className="grounding-metric-grid">
                  <p className="validation-meta">
                    Claims: {part.metrics.totalClaims} · Con cita: {part.metrics.claimsWithCitation} · Sin cita: {part.metrics.claimsWithoutCitation}
                  </p>
                  <p className="validation-meta">
                    Ratio palabras: {Math.round(part.coverage.extractionToTranscriptRatio * 100)}% · Cobertura chunks: {Math.round(part.coverage.chunkCoverageRatio * 100)}%
                  </p>
                  <p className="validation-meta">
                    Fallback rate: {Math.round((part.fallbackRate ?? 0) * 100)}% · Unsupported: {part.metrics.unsupportedClaimCount}
                  </p>
                  <p className="validation-meta">
                    Ventanas: {part.windows.length} · Compresión: {part.windowsTooCompressed} · Thin reasoning: {part.rejectedWindowMetrics?.thinReasoning ?? 0}
                  </p>
                </div>

                {!part.citationIntegrity.ok ? (
                  <div className="validation-details">
                    {part.citationIntegrity.invalidCitationIds.length > 0 ? (
                      <p>
                        <strong>Citas inválidas:</strong> {part.citationIntegrity.invalidCitationIds.join(', ')}
                      </p>
                    ) : null}
                    {part.citationIntegrity.malformedCitations.length > 0 ? (
                      <p>
                        <strong>Citas mal formadas:</strong> {part.citationIntegrity.malformedCitations.join(', ')}
                      </p>
                    ) : null}
                  </div>
                ) : problematicClaims.length > 0 ? (
                  <ul className="validation-details">
                    {problematicClaims.slice(0, 4).map((claim) => (
                      <li key={claim.id}>
                        <strong>{part.claimSupport.unsupported.some((item) => item.id === claim.id) ? 'unsupported' : 'partially_supported'}</strong>: {claim.text}
                        <br />
                        <span>{claim.reason}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="validation-ok">No hay claims problemáticos en esta parte.</p>
                )}

                <details className="disclosure-card disclosure-card-nested">
                  <summary>Ver ventanas y recovery path</summary>
                  <ul className="validation-details compact-window-list">
                    {part.windows.map((window) => {
                      const rawInvalidFile = window.rawInvalidOutputPath
                        ? findFile(files, window.rawInvalidOutputPath.split('/').slice(-1)[0] ?? '')
                        : undefined;
                      const recoveredJsonFile = window.recoveredJsonPath
                        ? findFile(files, window.recoveredJsonPath.split('/').slice(-1)[0] ?? '')
                        : undefined;

                      return (
                        <li key={`${part.part}-${window.windowId}`}>
                          <strong>{window.windowId}</strong>: {getWindowCoverageLabel(window.coverage.status)} · entrada {window.coverage.inputWords} palabras · salida {window.coverage.outputWords} palabras
                          <br />
                          <span>
                            generación {window.generationStatus} · repair {window.repairStatus ?? 'not_needed'} · final {window.finalStatus}
                            {window.fallbackExtraction ? ' · fallback determinístico' : ''}
                            {window.preservedPreviousExtraction ? ' · preservó extracción previa útil' : ''}
                          </span>
                          <br />
                          <span>{window.decisionReason}</span>
                          {window.recoveryPath?.length ? (
                            <>
                              <br />
                              <span>recoveryPath: {window.recoveryPath.join(' → ')}</span>
                            </>
                          ) : null}
                          {rawInvalidFile || recoveredJsonFile ? (
                            <>
                              <br />
                              {rawInvalidFile ? (
                                <a href={rawInvalidFile.downloadUrl} target="_blank" rel="noreferrer">
                                  Ver raw inválido
                                </a>
                              ) : null}
                              {rawInvalidFile && recoveredJsonFile ? ' · ' : null}
                              {recoveredJsonFile ? (
                                <a href={recoveredJsonFile.downloadUrl} target="_blank" rel="noreferrer">
                                  Ver JSON recuperado
                                </a>
                              ) : null}
                            </>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </details>

                <div className="validation-links">
                  {claimsFile ? (
                    <a href={claimsFile.downloadUrl} target="_blank" rel="noreferrer">
                      Ver claims
                    </a>
                  ) : null}
                  {evidenceFile ? (
                    <a href={evidenceFile.downloadUrl} target="_blank" rel="noreferrer">
                      Ver evidencia
                    </a>
                  ) : null}
                  {integrityFile ? (
                    <a href={integrityFile.downloadUrl} target="_blank" rel="noreferrer">
                      Ver integridad
                    </a>
                  ) : null}
                  {extractionFile ? (
                    <a href={extractionFile.downloadUrl} target="_blank" rel="noreferrer">
                      Ver extracción
                    </a>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      </details>
    </section>
  );
}
