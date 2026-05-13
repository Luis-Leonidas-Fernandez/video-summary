import type {
  GroundedWindowExtraction,
  ReasoningSignal,
  RewriteEval,
  ThinReasoningEvalCheck,
  ThinReasoningEvalResult,
} from './groundingTypes.js'
import { validateCitationIntegrity } from './citationIntegrityService.js'
import { assessSemanticRichness, type SemanticRichnessAssessment } from './semanticRichnessClassifier.js'
import { hasMaterialSemanticImprovement } from './semanticEnrichmentEvaluator.js'
import type { SemanticCritique } from './semanticCritiqueService.js'
import type { ReasoningPlan } from './reasoningPlanAgentService.js'

function buildResult(stage: ThinReasoningEvalResult['stage'], checks: ThinReasoningEvalCheck[], rewriteEval?: RewriteEval): ThinReasoningEvalResult {
  const passedChecks = checks.filter((check) => check.passed).length
  const score = checks.length === 0 ? 0 : Number((passedChecks / checks.length).toFixed(2))
  const passed = checks.every((check) => check.passed)
  const summary = passed
    ? `${stage} ok (${passedChecks}/${checks.length})`
    : `${stage} con brechas (${passedChecks}/${checks.length})`

  return {
    stage,
    passed,
    score,
    checks,
    summary,
    ...(rewriteEval ? { rewriteEval } : {}),
  }
}

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}+/gu, '')
    .toLowerCase()
}

function overlapsLoosely(a: string, b: string): boolean {
  const left = new Set(normalize(a).split(/[^a-z0-9]+/).filter((token) => token.length >= 4))
  const right = new Set(normalize(b).split(/[^a-z0-9]+/).filter((token) => token.length >= 4))
  let matches = 0
  for (const token of left) {
    if (right.has(token)) {
      matches += 1
    }
  }

  return matches >= 1
}

function classifyPrioritySignals(priority: string): ReasoningSignal[] {
  const normalized = normalize(priority)
  const signals: ReasoningSignal[] = []

  if (/contraste|compar|oposicion/.test(normalized)) {
    signals.push('contrast')
  }
  if (/objecion|critica|pregunta/.test(normalized)) {
    signals.push('objection')
  }
  if (/respuesta|resolver|responde/.test(normalized)) {
    signals.push('response')
  }
  if (/ejemplo|analogia/.test(normalized)) {
    signals.push('example')
  }
  if (/historic|tradicion|concilio|siglo/.test(normalized)) {
    signals.push('historical_context')
  }
  if (/causal|porque|importa|aclara|explicitar/.test(normalized)) {
    signals.push('causal')
  }

  return Array.from(new Set(signals))
}

function hasSignalResolved(signal: ReasoningSignal, original: SemanticRichnessAssessment, enriched: SemanticRichnessAssessment): boolean {
  switch (signal) {
    case 'contrast':
      return enriched.signalCounts.contrastBlocks > original.signalCounts.contrastBlocks || enriched.extractionSignals.contrast
    case 'objection':
      return enriched.signalCounts.objectionBlocks > original.signalCounts.objectionBlocks || enriched.extractionSignals.objection
    case 'response':
      return enriched.signalCounts.objectionBlocks > original.signalCounts.objectionBlocks || enriched.reasoningRichBlocks > original.reasoningRichBlocks
    case 'example':
      return enriched.signalCounts.exampleBlocks > original.signalCounts.exampleBlocks || enriched.extractionSignals.example
    case 'historical_context':
      return enriched.signalCounts.historicalBlocks > original.signalCounts.historicalBlocks || enriched.extractionSignals.historical
    case 'causal':
      return enriched.signalCounts.causalBlocks > original.signalCounts.causalBlocks || enriched.reasoningRichBlocks > original.reasoningRichBlocks
    default:
      return false
  }
}

function detectLostSignals(original: SemanticRichnessAssessment, enriched: SemanticRichnessAssessment): ReasoningSignal[] {
  const lost: ReasoningSignal[] = []

  if (enriched.signalCounts.contrastBlocks < original.signalCounts.contrastBlocks) {
    lost.push('contrast')
  }
  if (enriched.signalCounts.objectionBlocks < original.signalCounts.objectionBlocks) {
    lost.push('objection')
  }
  if (enriched.signalCounts.exampleBlocks < original.signalCounts.exampleBlocks) {
    lost.push('example')
  }
  if (enriched.signalCounts.historicalBlocks < original.signalCounts.historicalBlocks) {
    lost.push('historical_context')
  }
  if (enriched.signalCounts.causalBlocks < original.signalCounts.causalBlocks) {
    lost.push('causal')
  }

  return Array.from(new Set(lost))
}

export function evaluateThinReasoningPlan({
  plan,
  assessment,
  allowedCitationIds,
}: {
  plan: ReasoningPlan
  assessment: SemanticRichnessAssessment
  allowedCitationIds?: string[]
}): ThinReasoningEvalResult {
  const allowed = new Set((allowedCitationIds ?? []).filter(Boolean))
  const checks: ThinReasoningEvalCheck[] = []
  const totalItems = plan.items.length
  const itemsWithWhy = plan.items.filter((item) => item.whyItMatters.trim().length > 0).length
  const itemsWithSupport = plan.items.filter((item) => item.supportingPoints.length > 0).length
  const itemsWithContrast = plan.items.filter((item) => item.requiredSignals.includes('contrast') || item.requiredSignals.includes('objection')).length
  const itemsWithExamples = plan.items.filter((item) => item.requiredSignals.includes('example')).length
  const itemsWithResponse = plan.items.filter((item) => item.requiredSignals.includes('response')).length
  const unresolvedRequiredSignals = plan.items.flatMap((item) => item.missingRequiredSignals ?? [])
  const allCitationsAllowed = allowed.size === 0 || plan.items.every((item) => item.citations.every((citation) => allowed.has(citation)))

  checks.push({
    name: 'items_present',
    passed: totalItems > 0,
    detail: `items=${totalItems}`,
  })
  checks.push({
    name: 'why_it_matters_present',
    passed: totalItems > 0 && itemsWithWhy === totalItems,
    detail: `items con whyItMatters=${itemsWithWhy}/${totalItems}`,
  })
  checks.push({
    name: 'supporting_points_present',
    passed: totalItems > 0 && itemsWithSupport === totalItems,
    detail: `items con supportingPoints=${itemsWithSupport}/${totalItems}`,
  })
  checks.push({
    name: 'contrast_when_evidence_demands_it',
    passed: !(assessment.evidenceSignals.contrast || assessment.evidenceSignals.objection) || itemsWithContrast > 0,
    detail: `evidence contrast/objection=${assessment.evidenceSignals.contrast || assessment.evidenceSignals.objection}, items con requiredSignals[contrast|objection]=${itemsWithContrast}`,
  })
  checks.push({
    name: 'example_when_evidence_demands_it',
    passed: !assessment.evidenceSignals.example || itemsWithExamples > 0,
    detail: `evidence example=${assessment.evidenceSignals.example}, items con requiredSignals[example]=${itemsWithExamples}`,
  })
  checks.push({
    name: 'response_when_evidence_demands_it',
    passed: !assessment.evidenceSignals.objection || itemsWithResponse > 0,
    detail: `evidence objection=${assessment.evidenceSignals.objection}, items con requiredSignals[response]=${itemsWithResponse}`,
  })
  checks.push({
    name: 'missing_required_signals_empty',
    passed: unresolvedRequiredSignals.length === 0,
    detail: unresolvedRequiredSignals.length === 0
      ? 'sin missingRequiredSignals'
      : `missingRequiredSignals=${unresolvedRequiredSignals.join(', ')}`,
  })
  checks.push({
    name: 'citations_allowed',
    passed: allCitationsAllowed,
    detail: allCitationsAllowed ? 'todas las citas del plan están permitidas' : 'hay citas fuera del set permitido',
  })

  return buildResult('plan', checks)
}

export function evaluateThinReasoningCritique({
  critique,
  extraction,
  assessment,
}: {
  critique: SemanticCritique
  extraction: GroundedWindowExtraction
  assessment: SemanticRichnessAssessment
}): ThinReasoningEvalResult {
  const headings = extraction.noteBlocks.map((block) => block.heading).filter(Boolean)
  const critiqueTouchesKnownBlocks = critique.weakBlocks.length === 0
    ? false
    : critique.weakBlocks.every((block) => headings.some((heading) => overlapsLoosely(heading, block.heading)))
  const critiqueAddressesMissingSignals = assessment.missingSignals.length === 0
    ? critique.missingReasoning.length > 0 || critique.rewritePriorities.length > 0
    : assessment.missingSignals.some((signal) =>
      critique.missingReasoning.some((item) => overlapsLoosely(signal, item))
      || critique.rewritePriorities.some((item) => overlapsLoosely(signal, item)),
    )

  const checks: ThinReasoningEvalCheck[] = [
    {
      name: 'has_missing_reasoning',
      passed: critique.missingReasoning.length > 0,
      detail: `missingReasoning=${critique.missingReasoning.length}`,
    },
    {
      name: 'has_weak_blocks',
      passed: critique.weakBlocks.length > 0,
      detail: `weakBlocks=${critique.weakBlocks.length}`,
    },
    {
      name: 'weak_blocks_point_to_real_sections',
      passed: critiqueTouchesKnownBlocks,
      detail: critiqueTouchesKnownBlocks
        ? 'los weakBlocks apuntan a headings existentes'
        : 'la crítica no referencia con claridad bloques reales del draft',
    },
    {
      name: 'has_rewrite_priorities',
      passed: critique.rewritePriorities.length > 0,
      detail: `rewritePriorities=${critique.rewritePriorities.length}`,
    },
    {
      name: 'addresses_assessment_gaps',
      passed: critiqueAddressesMissingSignals,
      detail: critiqueAddressesMissingSignals
        ? 'la crítica cubre faltantes detectados por el assessment'
        : 'la crítica no está alineada con los faltantes del assessment',
    },
  ]

  return buildResult('critique', checks)
}

export function evaluateThinReasoningRewrite({
  original,
  enriched,
  originalAssessment,
  critique,
  allowedCitationIds,
}: {
  original: GroundedWindowExtraction
  enriched: GroundedWindowExtraction
  originalAssessment: SemanticRichnessAssessment
  critique: SemanticCritique
  allowedCitationIds: string[]
}): ThinReasoningEvalResult {
  const enrichedAssessment = assessSemanticRichness(enriched)
  const improved = hasMaterialSemanticImprovement({
    original,
    enriched,
    originalAssessment,
    enrichedAssessment,
    targetFailureKind: 'thin_reasoning',
  })

  const resolvedCriticalPrioritiesCount = critique.rewritePriorities.filter((priority) =>
    classifyPrioritySignals(priority).some((signal) => hasSignalResolved(signal, originalAssessment, enrichedAssessment)),
  ).length
  const lostSignals = detectLostSignals(originalAssessment, enrichedAssessment)
  const citationIntegrity = validateCitationIntegrity({
    extraction: enriched,
    allowedCitationIds: new Set(allowedCitationIds),
  })
  const citationIntegrityOk = citationIntegrity.ok
  const originalInsufficient = new Set(original.insufficientEvidenceClaims.map((item) => `${item.section ?? ''}:${item.claim}`))
  const addedUnsupportedClaims = enriched.insufficientEvidenceClaims.some((item) => !originalInsufficient.has(`${item.section ?? ''}:${item.claim}`))
  const rewriteEval: RewriteEval = {
    materialImprovement: improved,
    resolvedCriticalPrioritiesCount,
    lostSignals,
    addedUnsupportedClaims,
    citationIntegrityOk,
    decision: (
      improved
      && lostSignals.length === 0
      && !addedUnsupportedClaims
      && citationIntegrityOk
    ) ? 'accept' : 'reject',
  }

  const checks: ThinReasoningEvalCheck[] = [
    {
      name: 'material_improvement',
      passed: improved,
      detail: improved ? 'la rewrite mejoró materialmente' : 'la rewrite no mejoró materialmente',
    },
    {
      name: 'reasoning_rich_blocks_increase',
      passed: enrichedAssessment.reasoningRichBlocks >= originalAssessment.reasoningRichBlocks,
      detail: `reasoningRichBlocks=${originalAssessment.reasoningRichBlocks} -> ${enrichedAssessment.reasoningRichBlocks}`,
    },
    {
      name: 'closure_not_introduced',
      passed: !enrichedAssessment.extractionSignals.closure,
      detail: enrichedAssessment.extractionSignals.closure
        ? 'la rewrite reintrodujo señales conversacionales'
        : 'sin señales conversacionales nuevas',
    },
    {
      name: 'resolved_critical_priorities',
      passed: resolvedCriticalPrioritiesCount > 0 || critique.rewritePriorities.length === 0,
      detail: `resolvedCriticalPriorities=${resolvedCriticalPrioritiesCount}/${critique.rewritePriorities.length}`,
    },
    {
      name: 'argument_signals_not_reduced',
      passed: lostSignals.length === 0,
      detail: lostSignals.length === 0
        ? 'sin pérdida de señales argumentales'
        : `lostSignals=${lostSignals.join(', ')}`,
    },
    {
      name: 'no_added_unsupported_claims',
      passed: !addedUnsupportedClaims,
      detail: addedUnsupportedClaims
        ? 'la rewrite agregó claims sin soporte suficiente'
        : 'sin claims nuevos no soportados',
    },
    {
      name: 'citation_integrity_ok',
      passed: citationIntegrityOk,
      detail: citationIntegrityOk
        ? 'integridad de citas preservada'
        : `invalid=${citationIntegrity.invalidCitationIds.length}, malformed=${citationIntegrity.malformedCitations.length}, withoutCitation=${citationIntegrity.claimsWithoutCitation.length}`,
    },
    {
      name: 'rewrite_decision_accept',
      passed: rewriteEval.decision === 'accept',
      detail: `decision=${rewriteEval.decision}`,
    },
  ]

  return buildResult('rewrite', checks, rewriteEval)
}
