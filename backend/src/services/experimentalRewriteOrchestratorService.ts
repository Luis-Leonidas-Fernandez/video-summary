import { evaluateThinReasoningRewrite } from './thinReasoningEvalService.js'
import { runControlledRewriteAgent } from './controlledRewriteAgentService.js'
import { runReasoningResolveAgent } from './reasoningResolveAgentService.js'
import { verifySignalPreservation } from './signalPreservationVerifierService.js'
import type { EvidenceDerivedPromptHints } from './evidenceDerivedPromptHintsService.js'
import type {
  ControlledAppliedChange,
  ControlledAppliedChangeMarker,
  ExperimentalRewriteExecutionMetadata,
  ExperimentalRewriteResult,
  MinimalEvidenceQuote,
  ResolvedChange,
  ResolvedChangeSet,
} from './experimentalRewriteTypes.js'
import type { EvidenceWindow, GroundedWindowExtraction } from './groundingTypes.js'
import type { ReasoningPlan } from './reasoningPlanAgentService.js'
import type { SemanticCritique } from './semanticCritiqueService.js'
import type { SemanticRichnessAssessment } from './semanticRichnessClassifier.js'

export interface ExperimentalRewriteOrchestratorInput {
  window: EvidenceWindow
  originalExtraction: GroundedWindowExtraction
  allowedCitationIds: string[]
  plan: ReasoningPlan
  critique: SemanticCritique
  assessment: SemanticRichnessAssessment
  evidenceHints: EvidenceDerivedPromptHints
}

function buildExecution({
  resolveRan,
  rewriteControlledRan,
  resolvedChangeCount,
  appliedChangeCount,
  effectiveAppliedChangeCount,
  effectiveTargetSignalRestoreCount,
  rejectedChangeCount,
  experimentalRewriteAccepted,
}: {
  resolveRan: boolean
  rewriteControlledRan: boolean
  resolvedChangeCount: number
  appliedChangeCount: number
  effectiveAppliedChangeCount: number
  effectiveTargetSignalRestoreCount: number
  rejectedChangeCount: number
  experimentalRewriteAccepted: boolean
}): ExperimentalRewriteExecutionMetadata {
  return {
    resolveRan,
    rewriteControlledRan,
    resolvedChangeCount,
    appliedChangeCount,
    effectiveAppliedChangeCount,
    effectiveTargetSignalRestoreCount,
    rejectedChangeCount,
    experimentalRewriteAccepted,
  }
}

function buildMinimalEvidenceQuotes(window: EvidenceWindow): MinimalEvidenceQuote[] {
  const evidence = window.evidence.filter((chunk) => chunk.role === 'primary')
  const source = evidence.length > 0 ? evidence : window.evidence
  return source.map((chunk, index) => ({
    evidenceQuoteId: `Q${index + 1}`,
    citationId: chunk.citationId,
    text: chunk.text,
    chunkId: chunk.sourceChunkId,
  }))
}

type NormalizedReasoningSignal = 'contrast' | 'objection' | 'response' | 'example'

function normalizeReasoningSignal(signal: unknown): NormalizedReasoningSignal | null {
  const normalized = String(signal ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')

  switch (normalized) {
    case 'contrast':
    case 'contraste':
      return 'contrast'
    case 'objection':
    case 'objections':
    case 'objecion':
    case 'objeciones':
      return 'objection'
    case 'response':
    case 'respuesta':
    case 'respuestas':
      return 'response'
    case 'example':
    case 'examples':
    case 'ejemplo':
    case 'ejemplos':
      return 'example'
    default:
      return null
  }
}

function normalizeReasoningSignals(signals: unknown[]): NormalizedReasoningSignal[] {
  return Array.from(new Set(
    signals
      .map((signal) => normalizeReasoningSignal(signal))
      .filter((signal): signal is NormalizedReasoningSignal => signal !== null),
  ))
}

function parseLostSignalsFromText(text: unknown): NormalizedReasoningSignal[] {
  const value = String(text ?? '')
  const match = value.match(/lostSignals=([^\n;]+)/i)
  if (!match?.[1]) {
    return []
  }
  return normalizeReasoningSignals(match[1].split(/[|,]/))
}

function buildChangeSetByIds(changeIds: string[], source: ResolvedChangeSet): ResolvedChangeSet {
  const selected = new Set(changeIds)
  return {
    status: source.status,
    changes: source.changes.filter((change) => selected.has(change.changeId)),
  }
}

function extractAppliedChangeIds(appliedChanges: Array<ControlledAppliedChange | ControlledAppliedChangeMarker>): string[] {
  return appliedChanges.map((change) => change.changeId)
}

function getProtectedSignalsFromChanges(
  changes: ResolvedChange[],
): Array<'contrast' | 'objection' | 'response' | 'example'> {
  return Array.from(new Set(changes.flatMap((change) => change.protectedSignals)))
}

function buildMinimalEvidenceForChanges(
  allQuotes: MinimalEvidenceQuote[],
  changeSet: ResolvedChangeSet,
): MinimalEvidenceQuote[] {
  const relevantQuoteIds = new Set(changeSet.changes.flatMap((change) => change.evidenceQuoteIds))
  return allQuotes.filter((quote) => relevantQuoteIds.has(quote.evidenceQuoteId))
}

function shouldAllowDensityPass(
  rewriteEval: NonNullable<ReturnType<typeof evaluateThinReasoningRewrite>['rewriteEval']>,
): boolean {
  return (
    rewriteEval.lostSignals.length === 0
    && !rewriteEval.addedUnsupportedClaims
    && rewriteEval.resolvedCriticalPrioritiesCount > 0
    && !rewriteEval.materialImprovement
  )
}

function buildDensityPassChangeSet(
  source: ResolvedChangeSet,
  appliedChanges: ControlledAppliedChange[],
): ResolvedChangeSet {
  const applied = new Set(appliedChanges.map((change) => change.changeId))
  return {
    status: source.status,
    changes: source.changes.filter((change) =>
      !applied.has(change.changeId)
      && change.changeType !== 'add_example'
      && change.operationScope !== 'item_citations'
    ),
  }
}

function alignAppliedOutcomesWithFinalEval({
  outcomes,
  resolvedChangeSet,
  finalLostSignals,
}: {
  outcomes: ControlledAppliedChange[]
  resolvedChangeSet: ResolvedChangeSet
  finalLostSignals: Array<'contrast' | 'objection' | 'response' | 'example'>
}): ControlledAppliedChange[] {
  const changesById = new Map(resolvedChangeSet.changes.map((change) => [change.changeId, change]))
  const finalLostSet = new Set(normalizeReasoningSignals(finalLostSignals))

  return outcomes.map((outcome) => {
    const change = changesById.get(outcome.changeId)
    if (!change || finalLostSignals.length === 0) {
      return outcome
    }

    const protectedSignals = normalizeReasoningSignals(change.protectedSignals)
    const targetLostSignals = normalizeReasoningSignals(change.targetLostSignals)
    const restoredSignals = normalizeReasoningSignals(outcome.restoredSignals)

    const stillLost = Array.from(finalLostSet).filter((signal) =>
      protectedSignals.includes(signal)
      || targetLostSignals.includes(signal)
      || restoredSignals.includes(signal),
    )

    if (stillLost.length === 0) {
      return outcome
    }

    return {
      ...outcome,
      minimumRequirementSatisfied: false,
      ineffectiveReason: 'final_eval_still_reports_signal_lost',
    }
  })
}

function computeFinalEffectiveCounts(
  outcomes: ControlledAppliedChange[],
  resolvedChangeSet: ResolvedChangeSet,
  finalLostSignals: Array<'contrast' | 'objection' | 'response' | 'example'>,
): {
  effectiveAppliedChangeCount: number
  effectiveTargetSignalRestoreCount: number
} {
  const changesById = new Map(resolvedChangeSet.changes.map((change) => [change.changeId, change]))
  const finalLostSet = new Set(normalizeReasoningSignals(finalLostSignals))

  let effectiveAppliedChangeCount = 0
  let effectiveTargetSignalRestoreCount = 0

  console.warn('[computeFinalEffectiveCounts:input]', {
    finalLostSignals,
    outcomes: outcomes.map((outcome) => ({
      changeId: outcome.changeId,
      applied: outcome.applied,
      minimumRequirementSatisfied: outcome.minimumRequirementSatisfied,
      restoredSignals: outcome.restoredSignals,
    })),
    changes: resolvedChangeSet.changes.map((change) => ({
      changeId: change.changeId,
      protectedSignals: change.protectedSignals,
      targetLostSignals: change.targetLostSignals,
    })),
  })

  outcomes.forEach((outcome) => {
    const change = changesById.get(outcome.changeId)
    if (!change || !outcome.applied || !outcome.minimumRequirementSatisfied) {
      return
    }

    const protectedSignals = normalizeReasoningSignals(change.protectedSignals)
    const targetLostSignals = normalizeReasoningSignals(change.targetLostSignals)
    const restoredSignals = normalizeReasoningSignals(outcome.restoredSignals)
    const protectedStillLost = protectedSignals.some((signal) => finalLostSet.has(signal))
    const targetStillLost = targetLostSignals.some((signal) => finalLostSet.has(signal))

    if (protectedStillLost || targetStillLost) {
      return
    }

    effectiveAppliedChangeCount += 1

    const restoredTargetSignals = targetLostSignals.filter((signal) =>
      restoredSignals.includes(signal),
    )
    const restoredAndAcceptedByFinalEval = restoredTargetSignals.filter((signal) =>
      !finalLostSet.has(signal),
    )

    if (restoredAndAcceptedByFinalEval.length > 0) {
      effectiveTargetSignalRestoreCount += 1
    }
  })

  return {
    effectiveAppliedChangeCount,
    effectiveTargetSignalRestoreCount: Math.min(
      effectiveTargetSignalRestoreCount,
      effectiveAppliedChangeCount,
    ),
  }
}

function extractFinalLostSignals(
  rewriteEval: ReturnType<typeof evaluateThinReasoningRewrite>,
): Array<'contrast' | 'objection' | 'response' | 'example'> {
  const rawSignals = [
    ...(rewriteEval.rewriteEval?.lostSignals ?? []),
    ...(((rewriteEval as unknown as { lostSignals?: unknown[] }).lostSignals) ?? []),
    ...parseLostSignalsFromText(
      rewriteEval.checks.find((check) => check.name === 'argument_signals_not_reduced')?.detail,
    ),
    ...parseLostSignalsFromText(rewriteEval.summary),
  ]

  return normalizeReasoningSignals(rawSignals)
}

function warnIfTargetRestoreContradiction({
  outcomes,
  resolvedChangeSet,
  finalLostSignals,
  effectiveAppliedChangeCount,
  effectiveTargetSignalRestoreCount,
  lostSignalsFromEval,
}: {
  outcomes: ControlledAppliedChange[]
  resolvedChangeSet: ResolvedChangeSet
  finalLostSignals: Array<'contrast' | 'objection' | 'response' | 'example'>
  effectiveAppliedChangeCount: number
  effectiveTargetSignalRestoreCount: number
  lostSignalsFromEval: unknown[]
}): void {
  if (effectiveTargetSignalRestoreCount > effectiveAppliedChangeCount) {
    console.warn('[thin_reasoning] invalid effective counts invariant', {
      effectiveAppliedChangeCount,
      effectiveTargetSignalRestoreCount,
      finalLostSignals,
    })
  }

  if (finalLostSignals.length === 0 || effectiveTargetSignalRestoreCount === 0) {
    return
  }

  console.warn('[target-restore-final-debug]', {
    lostSignalsFromEval,
    finalLostSignals,
    effectiveAppliedChangeCount,
    effectiveTargetSignalRestoreCount,
    outcomes: outcomes.map((outcome) => ({
      changeId: outcome.changeId,
      applied: outcome.applied,
      minimumRequirementSatisfied: outcome.minimumRequirementSatisfied,
      restoredSignals: outcome.restoredSignals,
    })),
    changes: resolvedChangeSet.changes.map((change) => ({
      changeId: change.changeId,
      targetLostSignals: change.targetLostSignals,
      protectedSignals: change.protectedSignals,
    })),
  })
}

export async function orchestrateExperimentalRewrite(
  input: ExperimentalRewriteOrchestratorInput,
): Promise<ExperimentalRewriteResult> {
  const minimalEvidence = buildMinimalEvidenceQuotes(input.window)

  const resolveResult = await runReasoningResolveAgent({
    originalExtraction: input.originalExtraction,
    plan: input.plan,
    critique: input.critique,
    minimalEvidence,
    evidenceHints: input.evidenceHints,
  }, input.allowedCitationIds)

  if (!resolveResult.ok) {
    return {
      applied: false,
      reason: 'El subagente resolve experimental no devolvió un change set usable.',
      execution: buildExecution({
        resolveRan: true,
        rewriteControlledRan: false,
        resolvedChangeCount: 0,
        appliedChangeCount: 0,
        effectiveAppliedChangeCount: 0,
        effectiveTargetSignalRestoreCount: 0,
        rejectedChangeCount: 0,
        experimentalRewriteAccepted: false,
      }),
      evidenceHints: input.evidenceHints,
    }
  }

  const resolvedChangeSet = resolveResult.value
  if (resolvedChangeSet.status === 'no_safe_changes' || resolvedChangeSet.changes.length === 0) {
    return {
      applied: true,
      improved: false,
      reason: 'El resolve experimental no encontró cambios seguros para aplicar.',
      resolvedChangeSet,
      execution: buildExecution({
        resolveRan: true,
        rewriteControlledRan: false,
        resolvedChangeCount: resolvedChangeSet.changes.length,
        appliedChangeCount: 0,
        effectiveAppliedChangeCount: 0,
        effectiveTargetSignalRestoreCount: 0,
        rejectedChangeCount: 0,
        experimentalRewriteAccepted: false,
      }),
      resolveRawOutput: resolveResult.rawOutput,
      evidenceHints: input.evidenceHints,
    }
  }

  const minimalEvidenceForRewrite = buildMinimalEvidenceForChanges(minimalEvidence, resolvedChangeSet)

  const controlledRewriteResult = await runControlledRewriteAgent({
    currentExtraction: input.originalExtraction,
    resolvedChanges: resolvedChangeSet,
    minimalEvidence: minimalEvidenceForRewrite,
    allowedCitationIds: input.allowedCitationIds,
  })

  if (!controlledRewriteResult.ok) {
    return {
      applied: true,
      improved: false,
      reason: 'El subagente controlled rewrite no cumplió el schema draft.',
      resolvedChangeSet,
      rawOutput: controlledRewriteResult.rawOutput,
      resolveRawOutput: resolveResult.rawOutput,
      rewriteControlledRawOutput: controlledRewriteResult.rawOutput,
      execution: buildExecution({
        resolveRan: true,
        rewriteControlledRan: true,
        resolvedChangeCount: resolvedChangeSet.changes.length,
        appliedChangeCount: 0,
        effectiveAppliedChangeCount: 0,
        effectiveTargetSignalRestoreCount: 0,
        rejectedChangeCount: resolvedChangeSet.changes.length,
        experimentalRewriteAccepted: false,
      }),
      evidenceHints: input.evidenceHints,
    }
  }

  const controlledRewriteTrace = {
    appliedChanges: controlledRewriteResult.value.appliedChanges,
    rejectedChanges: controlledRewriteResult.value.rejectedChanges,
  }
  const appliedChangeSet = buildChangeSetByIds(extractAppliedChangeIds(controlledRewriteTrace.appliedChanges), resolvedChangeSet)
  const signalPreservation = verifySignalPreservation({
    originalExtraction: input.originalExtraction,
    rewrittenExtraction: controlledRewriteResult.value.rewrittenExtraction,
    protectedSignals: getProtectedSignalsFromChanges(appliedChangeSet.changes),
    resolvedChanges: appliedChangeSet,
    minimalEvidence: minimalEvidenceForRewrite,
    appliedChanges: controlledRewriteResult.value.appliedChanges,
  })

  if (!signalPreservation.signalIntegrityOk) {
    const safeAppliedOutcomes = signalPreservation.appliedChangeOutcomes.filter(
      (change) => !signalPreservation.unsafeAppliedChanges.includes(change.changeId),
    )
    const earlyEffectiveCounts = computeFinalEffectiveCounts(
      safeAppliedOutcomes,
      resolvedChangeSet,
      [],
    )

    return {
      applied: true,
      improved: false,
      reason: `El controlled rewrite perdió señales protegidas: ${signalPreservation.reason}`,
      resolvedChangeSet,
      controlledRewriteTrace: {
        appliedChanges: safeAppliedOutcomes,
        rejectedChanges: [
          ...controlledRewriteTrace.rejectedChanges,
          ...signalPreservation.unsafeAppliedChanges.map((changeId) => ({
            changeId,
            reason: signalPreservation.reason,
          })),
        ],
      },
      rawOutput: controlledRewriteResult.rawOutput,
      resolveRawOutput: resolveResult.rawOutput,
      rewriteControlledRawOutput: controlledRewriteResult.rawOutput,
      execution: buildExecution({
        resolveRan: true,
        rewriteControlledRan: true,
        resolvedChangeCount: resolvedChangeSet.changes.length,
        appliedChangeCount: controlledRewriteTrace.appliedChanges.length,
        effectiveAppliedChangeCount: earlyEffectiveCounts.effectiveAppliedChangeCount,
        effectiveTargetSignalRestoreCount: earlyEffectiveCounts.effectiveTargetSignalRestoreCount,
        rejectedChangeCount: controlledRewriteTrace.rejectedChanges.length + signalPreservation.unsafeAppliedChanges.length,
        experimentalRewriteAccepted: false,
      }),
      evidenceHints: input.evidenceHints,
    }
  }

  let finalExtraction = controlledRewriteResult.value.rewrittenExtraction
  let finalTrace = {
    appliedChanges: signalPreservation.appliedChangeOutcomes,
    rejectedChanges: controlledRewriteTrace.rejectedChanges,
  }
  let rewriteEval = evaluateThinReasoningRewrite({
    original: input.originalExtraction,
    enriched: finalExtraction,
    originalAssessment: input.assessment,
    critique: input.critique,
    allowedCitationIds: input.allowedCitationIds,
  })
  let finalLostSignals = extractFinalLostSignals(rewriteEval)
  finalTrace = {
    ...finalTrace,
    appliedChanges: alignAppliedOutcomesWithFinalEval({
      outcomes: finalTrace.appliedChanges,
      resolvedChangeSet,
      finalLostSignals,
    }),
  }

  if (
    rewriteEval.rewriteEval
    && shouldAllowDensityPass(rewriteEval.rewriteEval)
  ) {
    const secondPassChangeSet = buildDensityPassChangeSet(resolvedChangeSet, finalTrace.appliedChanges)
    if (secondPassChangeSet.changes.length > 0) {
      const minimalEvidenceForSecondPass = buildMinimalEvidenceForChanges(minimalEvidence, secondPassChangeSet)
      const secondPassResult = await runControlledRewriteAgent({
        currentExtraction: finalExtraction,
        resolvedChanges: secondPassChangeSet,
        minimalEvidence: minimalEvidenceForSecondPass,
        allowedCitationIds: input.allowedCitationIds,
        passMode: 'density_pass',
      })

      if (secondPassResult.ok && secondPassResult.value.appliedChanges.length > 0) {
        const secondPassAppliedChangeSet = buildChangeSetByIds(extractAppliedChangeIds(secondPassResult.value.appliedChanges), secondPassChangeSet)
        const secondPassSignalPreservation = verifySignalPreservation({
          originalExtraction: input.originalExtraction,
          rewrittenExtraction: secondPassResult.value.rewrittenExtraction,
          protectedSignals: getProtectedSignalsFromChanges([
            ...appliedChangeSet.changes,
            ...secondPassAppliedChangeSet.changes,
          ]),
          resolvedChanges: {
            status: 'ok',
            changes: [
              ...appliedChangeSet.changes,
              ...secondPassAppliedChangeSet.changes,
            ],
          },
          minimalEvidence: [
            ...minimalEvidenceForRewrite,
            ...minimalEvidenceForSecondPass,
          ],
          appliedChanges: secondPassResult.value.appliedChanges,
        })

        if (secondPassSignalPreservation.signalIntegrityOk) {
          finalExtraction = secondPassResult.value.rewrittenExtraction
          finalTrace = {
            appliedChanges: [
              ...finalTrace.appliedChanges,
              ...secondPassSignalPreservation.appliedChangeOutcomes,
            ].filter((change, index, array) => array.findIndex((candidate) => candidate.changeId === change.changeId) === index),
            rejectedChanges: [
              ...finalTrace.rejectedChanges,
              ...secondPassResult.value.rejectedChanges,
            ],
          }
          rewriteEval = evaluateThinReasoningRewrite({
            original: input.originalExtraction,
            enriched: finalExtraction,
            originalAssessment: input.assessment,
            critique: input.critique,
            allowedCitationIds: input.allowedCitationIds,
          })
          finalLostSignals = extractFinalLostSignals(rewriteEval)
          finalTrace = {
            ...finalTrace,
            appliedChanges: alignAppliedOutcomesWithFinalEval({
              outcomes: finalTrace.appliedChanges,
              resolvedChangeSet,
              finalLostSignals,
            }),
          }
        }
      }
    }
  }

  const finalEffectiveCounts = computeFinalEffectiveCounts(
    finalTrace.appliedChanges,
    resolvedChangeSet,
    finalLostSignals,
  )
  warnIfTargetRestoreContradiction({
    outcomes: finalTrace.appliedChanges,
    resolvedChangeSet,
    finalLostSignals,
    effectiveAppliedChangeCount: finalEffectiveCounts.effectiveAppliedChangeCount,
    effectiveTargetSignalRestoreCount: finalEffectiveCounts.effectiveTargetSignalRestoreCount,
    lostSignalsFromEval: rewriteEval.rewriteEval?.lostSignals ?? [],
  })

  if (
    finalEffectiveCounts.effectiveAppliedChangeCount === 0
    || rewriteEval.rewriteEval?.decision === 'reject'
  ) {
    return {
      applied: true,
      improved: false,
      reason: finalEffectiveCounts.effectiveAppliedChangeCount === 0
        ? 'El controlled rewrite rechazó todos los cambios resueltos.'
        : 'El controlled rewrite produjo una salida sin mejora material suficiente.',
      resolvedChangeSet,
      controlledRewriteTrace: finalTrace,
      rewriteEval,
      rawOutput: controlledRewriteResult.rawOutput,
      resolveRawOutput: resolveResult.rawOutput,
      rewriteControlledRawOutput: controlledRewriteResult.rawOutput,
      execution: buildExecution({
        resolveRan: true,
        rewriteControlledRan: true,
        resolvedChangeCount: resolvedChangeSet.changes.length,
        appliedChangeCount: finalTrace.appliedChanges.length,
        effectiveAppliedChangeCount: finalEffectiveCounts.effectiveAppliedChangeCount,
        effectiveTargetSignalRestoreCount: finalEffectiveCounts.effectiveTargetSignalRestoreCount,
        rejectedChangeCount: finalTrace.rejectedChanges.length,
        experimentalRewriteAccepted: false,
      }),
      evidenceHints: input.evidenceHints,
    }
  }

  return {
      applied: true,
      improved: true,
    extraction: finalExtraction,
    resolvedChangeSet,
    controlledRewriteTrace: finalTrace,
    rewriteEval,
    rawOutput: controlledRewriteResult.rawOutput,
    resolveRawOutput: resolveResult.rawOutput,
    rewriteControlledRawOutput: controlledRewriteResult.rawOutput,
    execution: buildExecution({
      resolveRan: true,
      rewriteControlledRan: true,
      resolvedChangeCount: resolvedChangeSet.changes.length,
      appliedChangeCount: finalTrace.appliedChanges.length,
      effectiveAppliedChangeCount: finalEffectiveCounts.effectiveAppliedChangeCount,
      effectiveTargetSignalRestoreCount: finalEffectiveCounts.effectiveTargetSignalRestoreCount,
      rejectedChangeCount: finalTrace.rejectedChanges.length,
      experimentalRewriteAccepted: true,
    }),
    evidenceHints: input.evidenceHints,
  }
}
