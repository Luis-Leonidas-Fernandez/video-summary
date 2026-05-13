import { appConfig } from '../config.js'
import { parseGroundedWindowExtraction } from './groundedSummary.js'
import { assessSemanticRichness, classifySemanticRichnessFailure } from './semanticRichnessClassifier.js'
import { enrichSemanticWindowExtraction } from './semanticEnrichmentService.js'
import { repairJsonContract } from './jsonContractRepairService.js'
import { strictReemitWindowExtraction } from './strictReemitWindowExtractionService.js'
import {
  classifyParsedWindowExtractionFailure,
  classifyRawWindowOutputFailure,
} from './windowOutputFailureClassifier.js'
import {
  normalizeDraftToGroundedExtraction,
  parseWindowDraftExtraction,
} from './windowDraftNormalizerService.js'
import {
  persistParseDebugArtifacts,
  type RecoveryStage,
} from './windowRecoveryArtifactService.js'
import type { RobustParseStrategy } from './windowOutputParserService.js'
import type {
  EvidenceWindow,
  GroundedWindowExtraction,
  ProcessingStageObserver,
  RecoveryPathStep,
  ThinReasoningEvalBundle,
  WindowGenerationStatus,
  WindowOutputFailureKind,
  WindowRepairStatus,
} from './groundingTypes.js'
import type { ControlledRewriteTrace, ResolvedChangeSet } from './experimentalRewriteTypes.js'
import type { EvidenceDerivedPromptHints } from './evidenceDerivedPromptHintsService.js'

export interface PreviousUsefulExtraction {
  extraction: GroundedWindowExtraction
  generationStatus: WindowGenerationStatus
  repairStatus?: WindowRepairStatus
  useful: boolean
}

export interface ResolvedWindowExtraction {
  extraction: GroundedWindowExtraction
  generationStatus: WindowGenerationStatus
  repairStatus?: WindowRepairStatus
  parseError?: string
  rawInvalidOutputPath?: string
  recoveredJsonPath?: string
  fallbackExtraction: boolean
  forcedNeedsReview: boolean
  failureKind?: WindowOutputFailureKind
  recoveryPath: RecoveryPathStep[]
  preservedPreviousExtraction?: boolean
  thinReasoningEvals?: ThinReasoningEvalBundle
  experimentalResolvedChangeSet?: ResolvedChangeSet
  experimentalControlledRewriteTrace?: ControlledRewriteTrace
  experimentalEvidenceHints?: EvidenceDerivedPromptHints
}

type StageParseResult =
  | { ok: true; extraction: GroundedWindowExtraction; strategy: RobustParseStrategy; repairedJsonText?: string; schemaMode: 'simple_draft' | 'final_contract' }
  | { ok: false; error: string; rawPreview: string; schemaMode: 'simple_draft' | 'final_contract' }

function buildEditorialFallbackWindowExtraction(window: EvidenceWindow): GroundedWindowExtraction {
  const primaryEvidence = window.evidence.filter((chunk) => chunk.role === 'primary')
  const sourceEvidence = primaryEvidence.length > 0 ? primaryEvidence : window.evidence

  return {
    windowId: window.windowId,
    noteBlocks: sourceEvidence.map((chunk, index) => ({
      heading: index === 0 ? 'Ventana recuperada parcialmente' : 'Fragmento recuperado automáticamente',
      content:
        index === 0
          ? `Esta sección fue recuperada automáticamente porque el modelo no entregó una estructura válida. Fragmento ${chunk.citationId}: ${chunk.text.trim().slice(0, 700)}`
          : `Fragmento ${chunk.citationId}: ${chunk.text.trim().slice(0, 700)}`,
      citations: [chunk.citationId],
      coverageType: 'detail',
    })),
    insufficientEvidenceClaims: [],
  }
}

function usesSimpleDraftSchema(stage: RecoveryStage): boolean {
  return stage === 'generation' && appConfig.generationSchemaMode === 'simple_draft'
}

function isFailureRecoverableByStrictReemit(kind: WindowOutputFailureKind | undefined): boolean {
  return kind === 'alternate_schema' || kind === 'mixed_markdown_json'
}


function isSemanticFailureKind(kind: WindowOutputFailureKind | undefined): kind is Extract<WindowOutputFailureKind, 'low_content' | 'thin_reasoning' | 'closure_pollution' | 'single_idea_collapse'> {
  return kind === 'low_content' || kind === 'thin_reasoning' || kind === 'closure_pollution' || kind === 'single_idea_collapse'
}

function buildFailedParseMessage({
  stage,
  windowId,
  kind,
}: {
  stage: RecoveryStage
  windowId: string
  kind?: WindowOutputFailureKind
}): string {
  switch (kind) {
    case 'empty_blocks':
      return `La ventana ${windowId} devolvió noteBlocks vacíos durante ${stage}.`
    case 'language_drift':
      return `La ventana ${windowId} mostró deriva de idioma durante ${stage}.`
    case 'low_content':
      return `La ventana ${windowId} devolvió contenido demasiado pobre durante ${stage}.`
    case 'thin_reasoning':
      return `La ventana ${windowId} quedó con razonamiento demasiado superficial durante ${stage}.`
    case 'closure_pollution':
      return `La ventana ${windowId} mezcló cierre conversacional con contenido durante ${stage}.`
    case 'single_idea_collapse':
      return `La ventana ${windowId} colapsó demasiados subtemas en una sola idea durante ${stage}.`
    case 'technical_fallback_like_output':
      return `La ventana ${windowId} devolvió una salida demasiado parecida a fallback técnico durante ${stage}.`
    case 'alternate_schema':
      return `La ventana ${windowId} devolvió un schema alternativo durante ${stage}.`
    case 'mixed_markdown_json':
      return `La ventana ${windowId} mezcló Markdown y JSON durante ${stage}.`
    default:
      return `La ventana ${windowId} no sostuvo un contrato JSON/editorial válido durante ${stage}.`
  }
}

function getParseRecoveryStep(stage: RecoveryStage, strategy: RobustParseStrategy): RecoveryPathStep | null {
  if (strategy === 'plain_json') {
    return usesSimpleDraftSchema(stage) ? 'simple_draft_parse' : null
  }
  if (strategy === 'substring_json') {
    return usesSimpleDraftSchema(stage) ? 'simple_draft_parse' : 'local_parse'
  }
  return 'jsonrepair'
}

function buildSuccessfulResolution({
  extraction,
  stage,
  strategy,
  generationStatusWhenOk,
  repairStatusWhenOk,
  parseError,
  rawInvalidOutputPath,
  recoveredJsonPath,
  recoveryPath,
  failureKind,
  forcedNeedsReview = false,
}: {
  extraction: GroundedWindowExtraction
  stage: RecoveryStage
  strategy: RobustParseStrategy
  generationStatusWhenOk: WindowGenerationStatus
  repairStatusWhenOk?: WindowRepairStatus
  parseError?: string
  rawInvalidOutputPath?: string
  recoveredJsonPath?: string
  recoveryPath: RecoveryPathStep[]
  failureKind?: WindowOutputFailureKind
  forcedNeedsReview?: boolean
}): ResolvedWindowExtraction {
  return {
    extraction,
    generationStatus: stage === 'generation' && strategy !== 'plain_json' ? 'repaired' : generationStatusWhenOk,
    repairStatus: repairStatusWhenOk,
    parseError,
    rawInvalidOutputPath,
    recoveredJsonPath,
    fallbackExtraction: false,
    forcedNeedsReview,
    failureKind,
    recoveryPath,
    preservedPreviousExtraction: false,
  }
}

function parseStageOutput({
  rawOutput,
  stage,
  windowId,
  allowedCitationIds,
}: {
  rawOutput: string
  stage: RecoveryStage
  windowId: string
  allowedCitationIds: string[]
}): StageParseResult {
  if (usesSimpleDraftSchema(stage)) {
    const parsedDraft = parseWindowDraftExtraction(rawOutput, windowId, allowedCitationIds)
    if (!parsedDraft.ok) {
      return {
        ok: false,
        error: parsedDraft.error,
        rawPreview: parsedDraft.rawPreview,
        schemaMode: 'simple_draft',
      }
    }

    return {
      ok: true,
      extraction: normalizeDraftToGroundedExtraction({ draft: parsedDraft.value, windowId }),
      strategy: parsedDraft.strategy,
      repairedJsonText: parsedDraft.repairedJsonText,
      schemaMode: 'simple_draft',
    }
  }

  const parsed = parseGroundedWindowExtraction(rawOutput, windowId)
  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.error,
      rawPreview: parsed.rawPreview,
      schemaMode: 'final_contract',
    }
  }

  return {
    ok: true,
    extraction: parsed.value,
    strategy: parsed.strategy,
    repairedJsonText: parsed.repairedJsonText,
    schemaMode: 'final_contract',
  }
}

async function persistLowQualityArtifacts({
  observer,
  stage,
  window,
  rawOutput,
  parseError,
  allowedCitationIds,
  recoveryPath,
  failureKind,
}: {
  observer?: ProcessingStageObserver
  stage: RecoveryStage
  window: EvidenceWindow
  rawOutput: string
  parseError: string
  allowedCitationIds: string[]
  recoveryPath: RecoveryPathStep[]
  failureKind?: WindowOutputFailureKind
}) {
  return persistParseDebugArtifacts({
    observer,
    stage,
    window,
    rawOutput,
    parseError,
    allowedCitationIds,
    recoveryAttempted: true,
    recoveryStatus: 'failed',
    failureKind,
    recoveryPath,
  })
}

async function persistThinReasoningEvalArtifacts({
  observer,
  windowId,
  evals,
}: {
  observer?: ProcessingStageObserver
  windowId: string
  evals?: ThinReasoningEvalBundle
}): Promise<void> {
  if (!observer?.writeArtifact || !evals) {
    return
  }

  await observer.writeArtifact(
    `thin_reasoning_eval_${windowId}.json`,
    JSON.stringify(evals, null, 2),
  )
  const rewriteDecision = evals.rewrite?.rewriteEval?.decision
  const rewriteSummary = evals.rewrite?.rewriteEval
    ? ` materialImprovement=${evals.rewrite.rewriteEval.materialImprovement}, resolvedCriticalPriorities=${evals.rewrite.rewriteEval.resolvedCriticalPrioritiesCount}, lostSignals=${evals.rewrite.rewriteEval.lostSignals.join('|') || 'none'}, addedUnsupportedClaims=${evals.rewrite.rewriteEval.addedUnsupportedClaims}, citationIntegrityOk=${evals.rewrite.rewriteEval.citationIntegrityOk}`
    : ''
  const execution = evals.execution
  await observer.log(
    `[window:${windowId}] thin reasoning evals => plan=${evals.plan.summary}; critique=${evals.critique.summary}${evals.rewrite ? `; rewrite=${evals.rewrite.summary}` : ''}${rewriteDecision ? `; decision=${rewriteDecision};${rewriteSummary}` : ''}${execution ? `; execution=plannerRan:${execution.plannerRan},plannerRepaired:${execution.plannerRepaired},critiqueRan:${execution.critiqueRan},rewriteRan:${execution.rewriteRan},rewriteRejected:${execution.rewriteRejected}${execution.resolveRan != null ? `,resolveRan:${execution.resolveRan}` : ''}${execution.rewriteControlledRan != null ? `,rewriteControlledRan:${execution.rewriteControlledRan}` : ''}${execution.resolvedChangeCount != null ? `,resolvedChangeCount:${execution.resolvedChangeCount}` : ''}${execution.appliedChangeCount != null ? `,appliedChangeCount:${execution.appliedChangeCount}` : ''}${execution.effectiveAppliedChangeCount != null ? `,effectiveAppliedChangeCount:${execution.effectiveAppliedChangeCount}` : ''}${execution.effectiveTargetSignalRestoreCount != null ? `,effectiveTargetSignalRestoreCount:${execution.effectiveTargetSignalRestoreCount}` : ''}${execution.rejectedChangeCount != null ? `,rejectedChangeCount:${execution.rejectedChangeCount}` : ''}${execution.experimentalRewriteAccepted != null ? `,experimentalRewriteAccepted:${execution.experimentalRewriteAccepted}` : ''}` : ''}`,
  )
}

async function persistExperimentalRewriteArtifacts({
  observer,
  windowId,
  resolvedChangeSet,
  controlledRewriteTrace,
  evidenceHints,
}: {
  observer?: ProcessingStageObserver
  windowId: string
  resolvedChangeSet?: ResolvedChangeSet
  controlledRewriteTrace?: ControlledRewriteTrace
  evidenceHints?: EvidenceDerivedPromptHints
}): Promise<void> {
  if (!observer?.writeArtifact) {
    return
  }

  if (resolvedChangeSet) {
    await observer.writeArtifact(
      `reasoning_resolved_changes_${windowId}.json`,
      JSON.stringify(resolvedChangeSet, null, 2),
    )
  }
  if (controlledRewriteTrace) {
    await observer.writeArtifact(
      `controlled_rewrite_${windowId}.json`,
      JSON.stringify(controlledRewriteTrace, null, 2),
    )
  }
  if (evidenceHints) {
    await observer.writeArtifact(
      `evidence_hints_${windowId}.json`,
      JSON.stringify(evidenceHints, null, 2),
    )
  }
}

function buildSyntheticThinReasoningEvalBundle(detail: string): ThinReasoningEvalBundle {
  return {
    plan: {
      stage: 'plan',
      passed: false,
      score: 0,
      checks: [
        {
          name: 'synthetic_eval_backfill',
          passed: false,
          detail,
        },
      ],
      summary: 'plan sin eval persistido; bundle sintetizado',
    },
    critique: {
      stage: 'critique',
      passed: false,
      score: 0,
      checks: [],
      summary: 'critique sin eval persistido; bundle sintetizado',
    },
    execution: {
      plannerRan: true,
      plannerRepaired: false,
      critiqueRan: false,
      rewriteRan: false,
      rewriteRejected: false,
    },
  }
}

function ensureThinReasoningEvalBundle({
  failureKind,
  evals,
  stage,
  windowId,
}: {
  failureKind?: WindowOutputFailureKind
  evals?: ThinReasoningEvalBundle
  stage: RecoveryStage
  windowId: string
}): ThinReasoningEvalBundle | undefined {
  if (failureKind !== 'thin_reasoning') {
    return evals
  }
  if (evals) {
    return evals
  }
  return buildSyntheticThinReasoningEvalBundle(
    `La ventana ${windowId} terminó como thin_reasoning durante ${stage}, pero no devolvió eval bundle; se sintetiza para no perder observabilidad.`,
  )
}

export async function resolveWindowExtraction({
  stage,
  rawOutput,
  window,
  allowedCitationIds,
  observer,
  generationStatusWhenOk,
  repairStatusWhenOk,
  previousUsefulExtraction,
}: {
  stage: RecoveryStage
  rawOutput: string
  window: EvidenceWindow
  allowedCitationIds: string[]
  observer?: ProcessingStageObserver
  generationStatusWhenOk: WindowGenerationStatus
  repairStatusWhenOk?: WindowRepairStatus
  previousUsefulExtraction?: PreviousUsefulExtraction
}): Promise<ResolvedWindowExtraction> {
  const recoveryPath: RecoveryPathStep[] = []
  const initialParse = parseStageOutput({ rawOutput, stage, windowId: window.windowId, allowedCitationIds })
  let failureKind: WindowOutputFailureKind | undefined

  if (initialParse.ok) {
    const parseStep = getParseRecoveryStep(stage, initialParse.strategy)
    if (parseStep) {
      recoveryPath.push(parseStep)
    }

    const structuralFailureKind = classifyParsedWindowExtractionFailure(initialParse.extraction)
    const semanticAssessment = structuralFailureKind ? undefined : assessSemanticRichness(initialParse.extraction, window)
    const semanticFailureKind = structuralFailureKind ? undefined : semanticAssessment?.failureKind
    failureKind = structuralFailureKind ?? semanticFailureKind

    if (stage === 'generation' && semanticFailureKind && semanticAssessment && appConfig.enableSemanticEnrichment) {
      await observer?.log(`[window:${window.windowId}] start semantic enrichment`)
      const enrichment = await enrichSemanticWindowExtraction({
        window,
        originalExtraction: initialParse.extraction,
        allowedCitationIds,
        failureKind: semanticFailureKind,
        assessment: semanticAssessment,
      })
      const enrichmentEvals = ensureThinReasoningEvalBundle({
        failureKind: semanticFailureKind,
        evals: 'thinReasoningEvals' in enrichment ? enrichment.thinReasoningEvals : undefined,
        stage,
        windowId: window.windowId,
      })

      if (enrichment.applied) {
        recoveryPath.push('semantic_enrichment')
      }

      if (enrichment.applied && enrichment.improved) {
        const enrichedFailureKind = classifySemanticRichnessFailure(enrichment.extraction, window)
        const enrichedParseError = enrichedFailureKind
          ? buildFailedParseMessage({ stage, windowId: window.windowId, kind: enrichedFailureKind })
          : undefined

        const resolution = buildSuccessfulResolution({
          extraction: enrichment.extraction,
          stage,
          strategy: initialParse.strategy,
          generationStatusWhenOk: 'repaired',
          repairStatusWhenOk,
          parseError: enrichedParseError,
          recoveryPath,
          failureKind: enrichedFailureKind,
        })
        resolution.thinReasoningEvals = enrichmentEvals
        resolution.experimentalResolvedChangeSet = 'experimentalResolvedChangeSet' in enrichment ? enrichment.experimentalResolvedChangeSet : undefined
        resolution.experimentalControlledRewriteTrace = 'experimentalControlledRewriteTrace' in enrichment ? enrichment.experimentalControlledRewriteTrace : undefined
        resolution.experimentalEvidenceHints = 'experimentalEvidenceHints' in enrichment ? enrichment.experimentalEvidenceHints : undefined
        await persistThinReasoningEvalArtifacts({
          observer,
          windowId: window.windowId,
          evals: enrichmentEvals,
        })
        await persistExperimentalRewriteArtifacts({
          observer,
          windowId: window.windowId,
          resolvedChangeSet: resolution.experimentalResolvedChangeSet,
          controlledRewriteTrace: resolution.experimentalControlledRewriteTrace,
          evidenceHints: resolution.experimentalEvidenceHints,
        })
        return resolution
      }

      if (enrichment.applied && !enrichment.improved && enrichment.parseError && enrichment.rawOutput) {
        const debugPaths = await persistParseDebugArtifacts({
          observer,
          stage,
          window,
          rawOutput: enrichment.rawOutput,
          parseError: enrichment.parseError,
          allowedCitationIds,
          recoveryAttempted: true,
          recoveryStatus: 'failed',
          failureKind: semanticFailureKind,
          recoveryPath,
        })

        const resolution = buildSuccessfulResolution({
          extraction: initialParse.extraction,
          stage,
          strategy: initialParse.strategy,
          generationStatusWhenOk,
          repairStatusWhenOk,
          parseError: buildFailedParseMessage({ stage, windowId: window.windowId, kind: semanticFailureKind }),
          rawInvalidOutputPath: debugPaths.rawInvalidOutputPath,
          recoveredJsonPath: debugPaths.recoveredJsonPath,
          recoveryPath,
          failureKind: semanticFailureKind,
        })
        resolution.thinReasoningEvals = enrichmentEvals
        resolution.experimentalResolvedChangeSet = 'experimentalResolvedChangeSet' in enrichment ? enrichment.experimentalResolvedChangeSet : undefined
        resolution.experimentalControlledRewriteTrace = 'experimentalControlledRewriteTrace' in enrichment ? enrichment.experimentalControlledRewriteTrace : undefined
        resolution.experimentalEvidenceHints = 'experimentalEvidenceHints' in enrichment ? enrichment.experimentalEvidenceHints : undefined
        await persistThinReasoningEvalArtifacts({
          observer,
          windowId: window.windowId,
          evals: enrichmentEvals,
        })
        await persistExperimentalRewriteArtifacts({
          observer,
          windowId: window.windowId,
          resolvedChangeSet: resolution.experimentalResolvedChangeSet,
          controlledRewriteTrace: resolution.experimentalControlledRewriteTrace,
          evidenceHints: resolution.experimentalEvidenceHints,
        })
        return resolution
      }

      const resolution = buildSuccessfulResolution({
        extraction: initialParse.extraction,
        stage,
        strategy: initialParse.strategy,
        generationStatusWhenOk,
        repairStatusWhenOk,
        parseError: buildFailedParseMessage({ stage, windowId: window.windowId, kind: semanticFailureKind }),
        recoveryPath,
        failureKind: semanticFailureKind,
      })
      resolution.thinReasoningEvals = enrichmentEvals
      resolution.experimentalResolvedChangeSet = 'experimentalResolvedChangeSet' in enrichment ? enrichment.experimentalResolvedChangeSet : undefined
      resolution.experimentalControlledRewriteTrace = 'experimentalControlledRewriteTrace' in enrichment ? enrichment.experimentalControlledRewriteTrace : undefined
      resolution.experimentalEvidenceHints = 'experimentalEvidenceHints' in enrichment ? enrichment.experimentalEvidenceHints : undefined
      await persistThinReasoningEvalArtifacts({
        observer,
        windowId: window.windowId,
        evals: enrichmentEvals,
      })
      await persistExperimentalRewriteArtifacts({
        observer,
        windowId: window.windowId,
        resolvedChangeSet: resolution.experimentalResolvedChangeSet,
        controlledRewriteTrace: resolution.experimentalControlledRewriteTrace,
        evidenceHints: resolution.experimentalEvidenceHints,
      })
      return resolution
    }

    if (semanticFailureKind) {
      const resolution = buildSuccessfulResolution({
        extraction: initialParse.extraction,
        stage,
        strategy: initialParse.strategy,
        generationStatusWhenOk,
        repairStatusWhenOk,
        parseError: buildFailedParseMessage({ stage, windowId: window.windowId, kind: semanticFailureKind }),
        recoveryPath,
        failureKind: semanticFailureKind,
      })
      resolution.thinReasoningEvals = ensureThinReasoningEvalBundle({
        failureKind: semanticFailureKind,
        evals: resolution.thinReasoningEvals,
        stage,
        windowId: window.windowId,
      })
      await persistThinReasoningEvalArtifacts({
        observer,
        windowId: window.windowId,
        evals: resolution.thinReasoningEvals,
      })
      return resolution
    }

    if (!failureKind) {
      const debugPaths = initialParse.strategy === 'jsonrepair'
        ? await persistParseDebugArtifacts({
            observer,
            stage,
            window,
            rawOutput,
            parseError: `La ventana ${window.windowId} necesitó jsonrepair local durante ${stage}.`,
            allowedCitationIds,
            recoveryAttempted: true,
            recoveryStatus: 'succeeded',
            recoveredJsonText: initialParse.repairedJsonText,
            recoveryPath,
          })
        : {}

      return buildSuccessfulResolution({
        extraction: initialParse.extraction,
        stage,
        strategy: initialParse.strategy,
        generationStatusWhenOk,
        repairStatusWhenOk,
        parseError: initialParse.strategy === 'jsonrepair'
          ? `La ventana ${window.windowId} necesitó jsonrepair local durante ${stage}.`
          : undefined,
        rawInvalidOutputPath: debugPaths.rawInvalidOutputPath,
        recoveredJsonPath: debugPaths.recoveredJsonPath,
        recoveryPath,
      })
    }

    if (
      stage === 'repair'
      && previousUsefulExtraction?.useful
      && (failureKind === 'language_drift' || failureKind === 'technical_fallback_like_output')
    ) {
      const parseError = buildFailedParseMessage({ stage, windowId: window.windowId, kind: failureKind })
      const debugPaths = await persistLowQualityArtifacts({
        observer,
        stage,
        window,
        rawOutput,
        parseError,
        allowedCitationIds,
        recoveryPath,
        failureKind,
      })
      recoveryPath.push('preserve_previous_extraction')
      await observer?.log(`[window:${window.windowId}] repair editorialmente débil; preservando extracción previa útil`)
      return {
        extraction: previousUsefulExtraction.extraction,
        generationStatus: previousUsefulExtraction.generationStatus,
        repairStatus: 'failed',
        parseError,
        rawInvalidOutputPath: debugPaths.rawInvalidOutputPath,
        recoveredJsonPath: debugPaths.recoveredJsonPath,
        fallbackExtraction: false,
        forcedNeedsReview: true,
        failureKind,
        recoveryPath,
        preservedPreviousExtraction: true,
      }
    }
  } else {
    failureKind = classifyRawWindowOutputFailure(rawOutput, initialParse.error)
  }

  let parseError = initialParse.ok
    ? buildFailedParseMessage({ stage, windowId: window.windowId, kind: failureKind })
    : initialParse.error
  let recoveredJsonText: string | undefined

  const shouldAttemptContractRepair = stage === 'generation'
    ? appConfig.enableTwoStepRecoveryForGeneration && appConfig.maxTwoStepRecoveryAttempts > 0
    : appConfig.maxJsonContractRepairAttempts > 0

  if (shouldAttemptContractRepair) {
    await observer?.log(`[window:${window.windowId}] ${parseError}`)
    await observer?.log(`[window:${window.windowId}] start json contract repair (${stage})`)
    await observer?.snapshot('full_notes:window:json_contract_repair:start', {
      windowId: window.windowId,
      stage,
      failureKind,
    })

    const contractRepair = await repairJsonContract({
      rawModelOutput: rawOutput,
      expectedSchemaName: usesSimpleDraftSchema(stage) ? 'WindowDraftExtraction' : 'GroundedWindowExtraction',
      allowedCitationIds,
      windowId: window.windowId,
    })
    recoveryPath.push(usesSimpleDraftSchema(stage) ? 'simple_draft_contract_repair' : 'contract_repair')

    if (contractRepair.ok && contractRepair.repairedJsonText) {
      recoveredJsonText = contractRepair.repairedJsonText
      const repairedParse = parseStageOutput({
        rawOutput: contractRepair.repairedJsonText,
        stage,
        windowId: window.windowId,
        allowedCitationIds,
      })

      if (repairedParse.ok) {
        const repairedFailureKind = classifyParsedWindowExtractionFailure(repairedParse.extraction)
        if (!repairedFailureKind || repairedFailureKind === 'low_content') {
          const debugPaths = await persistParseDebugArtifacts({
            observer,
            stage,
            window,
            rawOutput,
            parseError,
            allowedCitationIds,
            recoveryAttempted: true,
            recoveryStatus: 'succeeded',
            recoveredJsonText,
            recoveryPath,
            failureKind: repairedFailureKind,
          })
          await observer?.snapshot('full_notes:window:json_contract_repair:end', {
            windowId: window.windowId,
            stage,
            recoveryStatus: 'succeeded',
          })
          await observer?.log(`[window:${window.windowId}] json contract repair done (${stage})`)

          return {
            extraction: repairedParse.extraction,
            generationStatus: stage === 'generation' ? 'repaired' : generationStatusWhenOk,
            repairStatus: stage === 'repair' ? 'json_repaired' : repairStatusWhenOk,
            parseError: repairedFailureKind === 'low_content'
              ? buildFailedParseMessage({ stage, windowId: window.windowId, kind: repairedFailureKind })
              : parseError,
            rawInvalidOutputPath: debugPaths.rawInvalidOutputPath,
            recoveredJsonPath: debugPaths.recoveredJsonPath,
            fallbackExtraction: false,
            forcedNeedsReview: false,
            failureKind: repairedFailureKind,
            recoveryPath,
            preservedPreviousExtraction: false,
          }
        }

        failureKind = repairedFailureKind
        parseError = buildFailedParseMessage({ stage, windowId: window.windowId, kind: failureKind })
      } else {
        failureKind = classifyRawWindowOutputFailure(contractRepair.repairedJsonText, repairedParse.error)
        parseError = repairedParse.error
      }
    } else {
      parseError = contractRepair.error ?? parseError
    }
  }

  if (
    stage === 'generation'
    && appConfig.maxStrictReemitAttempts > 0
    && isFailureRecoverableByStrictReemit(failureKind)
  ) {
    await observer?.log(`[window:${window.windowId}] start strict reemit`)
    await observer?.snapshot('full_notes:window:strict_reemit:start', {
      windowId: window.windowId,
      failureKind,
    })

    const reemittedRawOutput = await strictReemitWindowExtraction({
      window,
      failureKind,
      previousError: parseError,
      previousRawOutput: rawOutput,
    })
    recoveryPath.push('strict_reemit')
    const reemitParse = parseStageOutput({
      rawOutput: reemittedRawOutput,
      stage,
      windowId: window.windowId,
      allowedCitationIds,
    })
    if (reemitParse.ok) {
      const reemitFailureKind = classifyParsedWindowExtractionFailure(reemitParse.extraction)
      if (!reemitFailureKind || reemitFailureKind === 'low_content') {
        const debugPaths = await persistParseDebugArtifacts({
          observer,
          stage,
          window,
          rawOutput,
          parseError,
          allowedCitationIds,
          recoveryAttempted: true,
          recoveryStatus: 'succeeded',
          recoveredJsonText: reemitParse.repairedJsonText,
          failureKind: reemitFailureKind,
          recoveryPath,
        })
        await observer?.snapshot('full_notes:window:strict_reemit:end', {
          windowId: window.windowId,
          recoveryStatus: 'succeeded',
        })
        await observer?.log(`[window:${window.windowId}] strict reemit done`)

        return {
          extraction: reemitParse.extraction,
          generationStatus: 'repaired',
          repairStatus: repairStatusWhenOk,
          parseError: reemitFailureKind === 'low_content'
            ? buildFailedParseMessage({ stage, windowId: window.windowId, kind: reemitFailureKind })
            : parseError,
          rawInvalidOutputPath: debugPaths.rawInvalidOutputPath,
          recoveredJsonPath: debugPaths.recoveredJsonPath,
          fallbackExtraction: false,
          forcedNeedsReview: false,
          failureKind: reemitFailureKind,
          recoveryPath,
          preservedPreviousExtraction: false,
        }
      }

      failureKind = reemitFailureKind
      parseError = buildFailedParseMessage({ stage, windowId: window.windowId, kind: failureKind })
    } else {
      failureKind = classifyRawWindowOutputFailure(reemittedRawOutput, reemitParse.error)
      parseError = reemitParse.error
    }

    await observer?.snapshot('full_notes:window:strict_reemit:end', {
      windowId: window.windowId,
      recoveryStatus: 'failed',
    })
  }

  const debugPaths = await persistParseDebugArtifacts({
    observer,
    stage,
    window,
    rawOutput,
    parseError,
    allowedCitationIds,
    recoveryAttempted: true,
    recoveryStatus: 'failed',
    recoveredJsonText,
    failureKind,
    recoveryPath,
  })

  await observer?.snapshot('full_notes:window:json_contract_repair:end', {
    windowId: window.windowId,
    stage,
    recoveryStatus: 'failed',
  })

  if (stage === 'repair' && previousUsefulExtraction?.useful) {
    recoveryPath.push('preserve_previous_extraction')
    await observer?.log(`[window:${window.windowId}] repair inválido; preservando extracción previa útil`)
    return {
      extraction: previousUsefulExtraction.extraction,
      generationStatus: previousUsefulExtraction.generationStatus,
      repairStatus: 'failed',
      parseError,
      rawInvalidOutputPath: debugPaths.rawInvalidOutputPath,
      recoveredJsonPath: debugPaths.recoveredJsonPath,
      fallbackExtraction: false,
      forcedNeedsReview: true,
      failureKind,
      recoveryPath,
      preservedPreviousExtraction: true,
    }
  }

  recoveryPath.push(appConfig.fallbackMode === 'editorial' ? 'fallback_editorial' : 'fallback_raw')
  await observer?.log(
    `[window:${window.windowId}] recuperación agotada (${stage}); usando fallback ${appConfig.fallbackMode === 'editorial' ? 'editorial' : 'determinístico'}`,
  )

  return {
    extraction: buildEditorialFallbackWindowExtraction(window),
    generationStatus: stage === 'generation' ? 'failed' : generationStatusWhenOk,
    repairStatus: stage === 'repair' ? 'failed' : repairStatusWhenOk,
    parseError,
    rawInvalidOutputPath: debugPaths.rawInvalidOutputPath,
    recoveredJsonPath: debugPaths.recoveredJsonPath,
    fallbackExtraction: true,
    forcedNeedsReview: true,
    failureKind,
    recoveryPath,
    preservedPreviousExtraction: false,
  }
}
