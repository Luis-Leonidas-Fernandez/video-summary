import { appConfig } from '../config.js'
import { critiqueThinReasoningDraft } from './semanticCritiqueService.js'
import { buildEvidenceDerivedPromptHints, type EvidenceDerivedPromptHints } from './evidenceDerivedPromptHintsService.js'
import { hasMaterialSemanticImprovement } from './semanticEnrichmentEvaluator.js'
import { assessSemanticRichness, type SemanticRichnessAssessment } from './semanticRichnessClassifier.js'
import {
  evaluateThinReasoningCritique,
  evaluateThinReasoningPlan,
  evaluateThinReasoningRewrite,
} from './thinReasoningEvalService.js'
import { runReasoningPlanAgent } from './reasoningPlanAgentService.js'
import { repairReasoningPlan } from './reasoningPlanRepairService.js'
import { runReasoningRewriteAgent } from './reasoningRewriteAgentService.js'
import { orchestrateExperimentalRewrite } from './experimentalRewriteOrchestratorService.js'
import type { EvidenceWindow, GroundedWindowExtraction, ThinReasoningEvalBundle } from './groundingTypes.js'
import type { ControlledRewriteTrace, ResolvedChangeSet } from './experimentalRewriteTypes.js'

function buildPlannerFailureEval(detail: string): ThinReasoningEvalBundle {
  return {
    plan: {
      stage: 'plan',
      passed: false,
      score: 0,
      checks: [
        {
          name: 'plan_agent_returned_result',
          passed: false,
          detail,
        },
      ],
      summary: 'plan sin resultado usable',
    },
    critique: {
      stage: 'critique',
      passed: false,
      score: 0,
      checks: [],
      summary: 'critique no ejecutada por falla del planner',
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

function shouldRepairPlan(planEval: ThinReasoningEvalBundle['plan']): boolean {
  return planEval.checks.some((check) =>
    !check.passed && (
      check.name === 'contrast_when_evidence_demands_it'
      || check.name === 'example_when_evidence_demands_it'
      || check.name === 'response_when_evidence_demands_it'
      || check.name === 'missing_required_signals_empty'
    ),
  )
}

export interface ThinReasoningOrchestratorInput {
  window: EvidenceWindow
  originalExtraction: GroundedWindowExtraction
  allowedCitationIds: string[]
  assessment: SemanticRichnessAssessment
}

export type ThinReasoningOrchestratorResult =
  | {
      applied: true
      improved: true
      extraction: GroundedWindowExtraction
      rawOutput?: string
      planRawOutput?: string
      critiqueRawOutput?: string
      thinReasoningEvals?: ThinReasoningEvalBundle
      experimentalResolvedChangeSet?: ResolvedChangeSet
      experimentalControlledRewriteTrace?: ControlledRewriteTrace
      experimentalEvidenceHints?: EvidenceDerivedPromptHints
    }
  | {
      applied: true
      improved: false
      reason: string
      rawOutput?: string
      planRawOutput?: string
      critiqueRawOutput?: string
      parseError?: string
      thinReasoningEvals?: ThinReasoningEvalBundle
      experimentalResolvedChangeSet?: ResolvedChangeSet
      experimentalControlledRewriteTrace?: ControlledRewriteTrace
      experimentalEvidenceHints?: EvidenceDerivedPromptHints
    }
  | {
      applied: false
      reason: string
    }

function buildExperimentalExecutionForLoggedRewrite({
  plannerRepaired,
  rewriteRejected,
  experimental,
  includeExperimentalCounts,
}: {
  plannerRepaired: boolean
  rewriteRejected: boolean
  experimental: Awaited<ReturnType<typeof orchestrateExperimentalRewrite>>
  includeExperimentalCounts: boolean
}): NonNullable<ThinReasoningEvalBundle['execution']> {
  return {
    plannerRan: true,
    plannerRepaired,
    critiqueRan: true,
    rewriteRan: true,
    rewriteRejected,
    resolveRan: experimental.execution.resolveRan,
    rewriteControlledRan: experimental.execution.rewriteControlledRan,
    resolvedChangeCount: includeExperimentalCounts ? experimental.execution.resolvedChangeCount : undefined,
    appliedChangeCount: includeExperimentalCounts ? experimental.execution.appliedChangeCount : undefined,
    effectiveAppliedChangeCount: includeExperimentalCounts ? experimental.execution.effectiveAppliedChangeCount : undefined,
    effectiveTargetSignalRestoreCount: includeExperimentalCounts ? experimental.execution.effectiveTargetSignalRestoreCount : undefined,
    rejectedChangeCount: includeExperimentalCounts ? experimental.execution.rejectedChangeCount : undefined,
    experimentalRewriteAccepted: experimental.execution.experimentalRewriteAccepted,
  }
}

export async function orchestrateThinReasoningAgents(
  input: ThinReasoningOrchestratorInput,
): Promise<ThinReasoningOrchestratorResult> {
  if (!appConfig.enableChainSemanticEnrichment || !appConfig.enableThinReasoningChain) {
    return {
      applied: false,
      reason: 'El chain prompt de thin reasoning está desactivado.',
    }
  }

  const initialEvidenceHints = buildEvidenceDerivedPromptHints({
    currentExtraction: input.originalExtraction,
    minimalEvidence: input.window.evidence.map((chunk, index) => ({
      evidenceQuoteId: `Q${index + 1}`,
      citationId: chunk.citationId,
      text: chunk.text,
      chunkId: chunk.sourceChunkId,
    })),
  })

  const planResult = await runReasoningPlanAgent({
    window: input.window,
    originalExtraction: input.originalExtraction,
    allowedCitationIds: input.allowedCitationIds,
    assessment: input.assessment,
    evidenceHints: initialEvidenceHints,
  })

  if (!planResult.ok) {
    return {
      applied: true,
      improved: false,
      reason: 'El subagente planner no devolvió un plan usable.',
      parseError: planResult.error,
      planRawOutput: planResult.rawOutput,
      thinReasoningEvals: buildPlannerFailureEval(planResult.error),
    }
  }

  const planEval = evaluateThinReasoningPlan({
    plan: planResult.value,
    assessment: input.assessment,
    allowedCitationIds: input.allowedCitationIds,
  })
  let effectivePlan = planResult.value
  let effectivePlanRawOutput = planResult.rawOutput
  let effectivePlanEval = planEval
  let plannerRepaired = false

  if (shouldRepairPlan(planEval)) {
    const repaired = await repairReasoningPlan({
      window: input.window,
      plan: planResult.value,
      allowedCitationIds: input.allowedCitationIds,
      assessment: input.assessment,
    })

    if (repaired.ok) {
      effectivePlan = repaired.value
      effectivePlanRawOutput = `${planResult.rawOutput}\n\n/* repair */\n${repaired.rawOutput}`
      effectivePlanEval = evaluateThinReasoningPlan({
        plan: repaired.value,
        assessment: input.assessment,
        allowedCitationIds: input.allowedCitationIds,
      })
      plannerRepaired = true
    }
  }

  const critiqueResult = await critiqueThinReasoningDraft({
    window: input.window,
    originalExtraction: input.originalExtraction,
    assessment: input.assessment,
    evidenceHints: initialEvidenceHints,
  })

  if (!critiqueResult.ok) {
    return {
      applied: true,
      improved: false,
      reason: 'El subagente critique no devolvió un resultado usable.',
      parseError: critiqueResult.error,
      planRawOutput: effectivePlanRawOutput,
      critiqueRawOutput: critiqueResult.rawOutput,
      thinReasoningEvals: {
        plan: effectivePlanEval,
        critique: {
          stage: 'critique',
          passed: false,
          score: 0,
          checks: [],
          summary: 'critique sin resultado usable',
        },
        execution: {
          plannerRan: true,
          plannerRepaired,
          critiqueRan: false,
          rewriteRan: false,
          rewriteRejected: false,
        },
      },
    }
  }

  const critiqueEval = evaluateThinReasoningCritique({
    critique: critiqueResult.value,
    extraction: input.originalExtraction,
    assessment: input.assessment,
  })

  const evidenceHints = buildEvidenceDerivedPromptHints({
    currentExtraction: input.originalExtraction,
    minimalEvidence: input.window.evidence.map((chunk, index) => ({
      evidenceQuoteId: `Q${index + 1}`,
      citationId: chunk.citationId,
      text: chunk.text,
      chunkId: chunk.sourceChunkId,
    })),
    plan: effectivePlan,
    critique: critiqueResult.value,
  })

  const experimental = await orchestrateExperimentalRewrite({
    window: input.window,
    originalExtraction: input.originalExtraction,
    allowedCitationIds: input.allowedCitationIds,
    plan: effectivePlan,
    critique: critiqueResult.value,
    assessment: input.assessment,
    evidenceHints,
  })

  if (experimental.applied && experimental.improved) {
    return {
      applied: true,
      improved: true,
      extraction: experimental.extraction,
      rawOutput: experimental.rawOutput,
      planRawOutput: effectivePlanRawOutput,
      critiqueRawOutput: critiqueResult.rawOutput,
      thinReasoningEvals: {
        plan: effectivePlanEval,
        critique: critiqueEval,
        rewrite: experimental.rewriteEval,
        execution: buildExperimentalExecutionForLoggedRewrite({
          plannerRepaired,
          rewriteRejected: false,
          experimental,
          includeExperimentalCounts: true,
        }),
      },
      experimentalResolvedChangeSet: experimental.resolvedChangeSet,
      experimentalControlledRewriteTrace: experimental.controlledRewriteTrace,
      experimentalEvidenceHints: experimental.evidenceHints,
    }
  }

  const rewriteResult = await runReasoningRewriteAgent({
    window: input.window,
    originalExtraction: input.originalExtraction,
    allowedCitationIds: input.allowedCitationIds,
    plan: effectivePlan,
    critique: critiqueResult.value,
    evidenceHints,
  })

  if (!rewriteResult.ok) {
    return {
      applied: true,
      improved: false,
      reason: 'El subagente rewrite no cumplió el schema draft.',
      parseError: rewriteResult.error,
      rawOutput: rewriteResult.rawOutput,
      planRawOutput: effectivePlanRawOutput,
      critiqueRawOutput: critiqueResult.rawOutput,
      experimentalResolvedChangeSet: experimental.applied ? experimental.resolvedChangeSet : undefined,
      experimentalControlledRewriteTrace: experimental.applied ? experimental.controlledRewriteTrace : undefined,
      experimentalEvidenceHints: experimental.evidenceHints,
      thinReasoningEvals: {
        plan: effectivePlanEval,
        critique: critiqueEval,
        execution: buildExperimentalExecutionForLoggedRewrite({
          plannerRepaired,
          rewriteRejected: false,
          experimental,
          includeExperimentalCounts: false,
        }),
      },
    }
  }

  const rewriteEval = evaluateThinReasoningRewrite({
    original: input.originalExtraction,
    enriched: rewriteResult.extraction,
    originalAssessment: input.assessment,
    critique: critiqueResult.value,
    allowedCitationIds: input.allowedCitationIds,
  })

  const enrichedAssessment = assessSemanticRichness(rewriteResult.extraction, input.window)
  if (!hasMaterialSemanticImprovement({
    original: input.originalExtraction,
    enriched: rewriteResult.extraction,
    originalAssessment: input.assessment,
    enrichedAssessment,
    targetFailureKind: 'thin_reasoning',
  }) || rewriteEval.rewriteEval?.decision === 'reject') {
    return {
      applied: true,
      improved: false,
      reason: rewriteEval.rewriteEval?.decision === 'reject'
        ? 'El orquestador planner/critique/rewrite rechazó una rewrite sin mejora material suficiente.'
        : 'El orquestador planner/critique/rewrite no mejoró la densidad argumental.',
      rawOutput: rewriteResult.rawOutput,
      planRawOutput: effectivePlanRawOutput,
      critiqueRawOutput: critiqueResult.rawOutput,
      experimentalResolvedChangeSet: experimental.applied ? experimental.resolvedChangeSet : undefined,
      experimentalControlledRewriteTrace: experimental.applied ? experimental.controlledRewriteTrace : undefined,
      experimentalEvidenceHints: experimental.evidenceHints,
      thinReasoningEvals: {
        plan: effectivePlanEval,
        critique: critiqueEval,
        rewrite: rewriteEval,
        execution: buildExperimentalExecutionForLoggedRewrite({
          plannerRepaired,
          rewriteRejected: rewriteEval.rewriteEval?.decision === 'reject',
          experimental,
          includeExperimentalCounts: false,
        }),
      },
    }
  }

  return {
    applied: true,
    improved: true,
    extraction: rewriteResult.extraction,
    rawOutput: rewriteResult.rawOutput,
    planRawOutput: effectivePlanRawOutput,
    critiqueRawOutput: critiqueResult.rawOutput,
    experimentalResolvedChangeSet: experimental.applied ? experimental.resolvedChangeSet : undefined,
    experimentalControlledRewriteTrace: experimental.applied ? experimental.controlledRewriteTrace : undefined,
    experimentalEvidenceHints: experimental.evidenceHints,
    thinReasoningEvals: {
      plan: effectivePlanEval,
      critique: critiqueEval,
      rewrite: rewriteEval,
      execution: buildExperimentalExecutionForLoggedRewrite({
        plannerRepaired,
        rewriteRejected: false,
        experimental,
        includeExperimentalCounts: false,
      }),
    },
  }
}
