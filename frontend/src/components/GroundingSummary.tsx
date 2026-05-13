import type { GroundingReport, JobFile } from '../api';

interface GroundingSummaryProps {
  report: GroundingReport | null;
  files: JobFile[];
  isLoading: boolean;
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
  return files.find((file) => file.name === name);
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

export function GroundingSummary({ report, files, isLoading }: GroundingSummaryProps) {
  if (isLoading && !report) {
    return (
      <section className="panel">
        <h2>Estado de respaldo</h2>
        <p>Cargando grounding por claims...</p>
      </section>
    );
  }

  if (!report || report.parts.length === 0) {
    return null;
  }

  return (
    <section className="panel">
      <h2>Estado de respaldo</h2>
      <p className="panel-caption">
        Este reporte separa integridad de citas, cobertura real del contenido y soporte semántico de los bloques/claims.
      </p>

      {report.performanceSummary ? (
        <p className="validation-meta">
          Pico RAM rastreada: {report.performanceSummary.ramPeakTrackedMb} MB
          {report.performanceSummary.ramPeakSystemApproxMb
            ? ` · Pico RAM sistema aprox.: ${report.performanceSummary.ramPeakSystemApproxMb} MB`
            : ''}
          {' · '}Full notes: {Math.round(report.performanceSummary.fullNotesDurationMs / 1000)}s
          {' · '}Grounding: {Math.round(report.performanceSummary.groundingDurationMs / 1000)}s
          {' · '}Unsupported: {report.performanceSummary.unsupportedClaimCount}
          {' · '}Ventanas comprimidas: {report.performanceSummary.windowsTooCompressed}
        </p>
      ) : null}

      <div className="validation-list">
        {report.parts.map((part) => {
          const claimsFile = findFile(files, `claims_part_${part.part}.json`);
          const extractionFile = findFile(files, `extraction_part_${part.part}.txt`);
          const evidenceFile = findFile(files, `evidence_part_${part.part}.json`);
          const integrityFile = findFile(files, `citation_integrity_part_${part.part}.json`);
          const problematicClaims = [...part.claimSupport.unsupported, ...part.claimSupport.partiallySupported];

          return (
            <article key={part.part} className="validation-card">
              <div className="validation-card-header">
                <div>
                  <h3>Parte {part.part}</h3>
                  <p className="validation-meta">{part.decisionReason}</p>
                </div>
                <span className={getStatusClassName(part.finalStatus)}>{getStatusLabel(part.finalStatus)}</span>
              </div>

              <p className="validation-meta">
                Claims totales: {part.metrics.totalClaims} · Con cita: {part.metrics.claimsWithCitation} · Sin cita:{' '}
                {part.metrics.claimsWithoutCitation}
              </p>
              <p className="validation-meta">
                Ratio palabras: {Math.round(part.coverage.extractionToTranscriptRatio * 100)}% · Cobertura chunks:{' '}
                {Math.round(part.coverage.chunkCoverageRatio * 100)}% · Sin soporte: {part.metrics.unsupportedClaimCount}
              </p>
              <p className="validation-meta">
                Cobertura global: {part.coverageGlobalStatus} · Cobertura local: {part.coverageLocalStatus}
              </p>
              <p className="validation-meta">
                Chunks sin claims: {part.coverage.chunksWithNoClaims.length} · Ventanas: {part.windows.length} · Promedio palabras/ventana:{' '}
                {part.avgWordsPerWindow}
              </p>
              <p className="validation-meta">
                Ventanas comprimidas: {part.windowsTooCompressed} · Muy detalladas: {part.windowsVeryDetailed} · Verbosas:{' '}
                {part.windowsTooVerbose}
              </p>
              {part.recoveryMetrics ? (
                <p className="validation-meta">
                  Fallback rate: {Math.round((part.fallbackRate ?? 0) * 100)}% · Recuperadas localmente:{' '}
                  {part.recoveryMetrics.windowsRecoveredLocally} · Contract repair:{' '}
                  {part.recoveryMetrics.windowsRecoveredByContractRepair} · Strict reemit:{' '}
                  {part.recoveryMetrics.windowsRecoveredByStrictReemit} · Extracción previa preservada:{' '}
                  {part.recoveryMetrics.windowsPreservedAfterRepairFailure}
                </p>
              ) : null}
              {part.semanticRecoveryMetrics ? (
                <p className="validation-meta">
                  Enriquecimiento semántico intentado: {part.semanticRecoveryMetrics.windowsEnrichmentAttempted} · Mejoradas:{' '}
                  {part.semanticRecoveryMetrics.windowsEnrichedSemantically} · Siguen comprimidas:{' '}
                  {part.semanticRecoveryMetrics.windowsStillCompressedAfterEnrichment}
                </p>
              ) : null}
              {part.rejectedWindowMetrics ? (
                <p className="validation-meta">
                  Rechazadas por drift: {part.rejectedWindowMetrics.languageDrift} · Low content:{' '}
                  {part.rejectedWindowMetrics.lowContent} · Thin reasoning: {part.rejectedWindowMetrics.thinReasoning} · Cierre conversacional:{' '}
                  {part.rejectedWindowMetrics.closurePollution} · Single idea collapse:{' '}
                  {part.rejectedWindowMetrics.singleIdeaCollapse} · Schema roto: {part.rejectedWindowMetrics.schemaBroken} · Fallback-like:{' '}
                  {part.rejectedWindowMetrics.fallbackLike} · Mixed md/json: {part.rejectedWindowMetrics.mixedMarkdownJson} · Alternate schema:{' '}
                  {part.rejectedWindowMetrics.alternateSchema}
                </p>
              ) : null}

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
                  {part.citationIntegrity.claimsWithoutCitation.length > 0 ? (
                    <ul className="validation-details">
                      {part.citationIntegrity.claimsWithoutCitation.slice(0, 4).map((claim) => (
                        <li key={`${part.part}-${claim.section}-${claim.claimText}`}>
                          <strong>Claim sin cita</strong>: {claim.claimText}
                          {claim.section ? <em> ({claim.section})</em> : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : problematicClaims.length > 0 ? (
                <ul className="validation-details">
                  {problematicClaims.slice(0, 4).map((claim) => (
                    <li key={claim.id}>
                      <strong>{part.claimSupport.unsupported.some((item) => item.id === claim.id) ? 'unsupported' : 'partially_supported'}</strong>:{' '}
                      {claim.text}
                      <br />
                      <span>{claim.reason}</span>
                      {claim.evidence[0] ? (
                        <>
                          <br />
                          <em>
                            Evidencia: {claim.evidence[0].citationId || 'sin alias'} → {claim.evidence[0].chunkId} (score{' '}
                            {claim.evidence[0].score}) — "{claim.evidence[0].quote}"
                          </em>
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="validation-ok">No hay claims problemáticos en esta parte.</p>
              )}

                <ul className="validation-details">
                {part.windows.map((window) => {
                  const rawInvalidFile = window.rawInvalidOutputPath
                    ? findFile(files, window.rawInvalidOutputPath.split('/').slice(-1)[0] ?? '')
                    : undefined;
                  const recoveredJsonFile = window.recoveredJsonPath
                    ? findFile(files, window.recoveredJsonPath.split('/').slice(-1)[0] ?? '')
                    : undefined;

                  return (
                    <li key={`${part.part}-${window.windowId}`}>
                      <strong>{window.windowId}</strong>: {getWindowCoverageLabel(window.coverage.status)} · ratio local{' '}
                      {Math.round(window.coverage.outputToInputRatio * 100)}% · entrada {window.coverage.inputWords} palabras · salida{' '}
                      {window.coverage.outputWords} palabras · bloques {window.noteBlockCount}
                      <br />
                      <span>
                        generación {window.generationStatus} · repair {window.repairStatus ?? 'not_needed'} · final {window.finalStatus}
                        {window.fallbackExtraction ? ' · fallback determinístico' : ''}
                        {window.preservedPreviousExtraction ? ' · preservó extracción previa útil' : ''}
                      </span>
                      <br />
                      <span>{window.decisionReason}</span>
                      {window.failureKind ? (
                        <>
                          <br />
                          <span>failureKind: {window.failureKind}</span>
                        </>
                      ) : null}
                      {window.recoveryPath?.length ? (
                        <>
                          <br />
                          <span>recoveryPath: {window.recoveryPath.join(' → ')}</span>
                        </>
                      ) : null}
                      {window.parseError ? (
                        <>
                          <br />
                          <em>{window.parseError.split('\n')[0]}</em>
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
    </section>
  );
}
