import { appConfig } from '../config.js'
import { completeOllamaResponse } from './ollamaClient.js'
import { renderEvidenceWindowMarkdown } from './evidenceWindowService.js'
import type { EvidenceDerivedPromptHints } from './evidenceDerivedPromptHintsService.js'
import type { JsonSchemaObject } from './outputSchemas.js'
import { buildSpeakerAwarenessPromptGuidance } from './speakerAwarenessService.js'
import type { EvidenceWindow, GroundedWindowExtraction, ReasoningSignal } from './groundingTypes.js'
import type { SemanticRichnessAssessment } from './semanticRichnessClassifier.js'

export interface ReasoningPlanItem {
  title: string
  coreClaim: string
  whyItMatters: string
  supportingPoints: string[]
  requiredSignals: ReasoningSignal[]
  missingRequiredSignals?: ReasoningSignal[]
  confidence?: 'high' | 'medium' | 'low'
  citations: string[]
}

export interface ReasoningPlan {
  items: ReasoningPlanItem[]
}

export interface ReasoningPlanAgentInput {
  window: EvidenceWindow
  originalExtraction: GroundedWindowExtraction
  allowedCitationIds: string[]
  assessment: SemanticRichnessAssessment
  evidenceHints?: EvidenceDerivedPromptHints
}

function buildReasoningPlanSchema(allowedCitationIds: string[]): JsonSchemaObject {
  const uniqueCitationIds = Array.from(new Set(allowedCitationIds.map((item) => item.trim()).filter(Boolean)))
  const signalEnum: ReasoningSignal[] = ['contrast', 'objection', 'response', 'example', 'historical_context', 'causal']

  return {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'coreClaim', 'whyItMatters', 'supportingPoints', 'requiredSignals', 'citations'],
          properties: {
            title: { type: 'string' },
            coreClaim: { type: 'string' },
            whyItMatters: { type: 'string' },
            supportingPoints: {
              type: 'array',
              minItems: 1,
              items: { type: 'string' },
            },
            requiredSignals: {
              type: 'array',
              items: { type: 'string', enum: signalEnum },
            },
            missingRequiredSignals: {
              type: 'array',
              items: { type: 'string', enum: signalEnum },
            },
            confidence: {
              type: 'string',
              enum: ['high', 'medium', 'low'],
            },
            citations: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'string',
                ...(uniqueCitationIds.length > 0 ? { enum: uniqueCitationIds } : {}),
              },
            },
          },
        },
      },
    },
  }
}

function normalizeSignals(values: unknown): ReasoningSignal[] {
  const allowed: ReasoningSignal[] = ['contrast', 'objection', 'response', 'example', 'historical_context', 'causal']
  if (!Array.isArray(values)) {
    return []
  }

  return values
    .filter((value): value is ReasoningSignal => typeof value === 'string' && allowed.includes(value as ReasoningSignal))
}

function parseReasoningPlan(rawOutput: string): { ok: true; value: ReasoningPlan } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(rawOutput) as Partial<ReasoningPlan>
    if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
      return { ok: false, error: 'El plan argumental no devolvió items válidos.' }
    }

    const items = parsed.items
      .filter((item) =>
        item
        && typeof item.title === 'string'
        && typeof item.coreClaim === 'string'
        && typeof item.whyItMatters === 'string'
        && Array.isArray(item.supportingPoints)
        && Array.isArray(item.requiredSignals)
        && Array.isArray(item.citations),
      )
      .map((item) => ({
        title: item.title,
        coreClaim: item.coreClaim,
        whyItMatters: item.whyItMatters,
        supportingPoints: item.supportingPoints.filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
        requiredSignals: normalizeSignals(item.requiredSignals),
        missingRequiredSignals: normalizeSignals(item.missingRequiredSignals),
        confidence: item.confidence === 'high' || item.confidence === 'medium' || item.confidence === 'low'
          ? item.confidence
          : undefined,
        citations: item.citations.filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
      }))
      .filter((item) => item.supportingPoints.length > 0 && item.citations.length > 0)

    if (items.length === 0) {
      return { ok: false, error: 'El plan argumental no devolvió items utilizables.' }
    }

    return { ok: true, value: { items } }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'No se pudo parsear el plan argumental.',
    }
  }
}

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}+/gu, '')
    .toLowerCase()
}

function overlapsHint(text: string, values: string[]): boolean {
  const normalizedText = normalize(text)
  return values.some((value) => {
    const tokens = normalize(value).split(/[^a-z0-9]+/).filter((token) => token.length >= 5)
    return tokens.some((token) => normalizedText.includes(token))
  })
}

function applyEvidenceHintsToPlan(plan: ReasoningPlan, evidenceHints?: EvidenceDerivedPromptHints): ReasoningPlan {
  if (!evidenceHints) {
    return plan
  }

  const candidateContrastTexts = evidenceHints.candidateContrasts.flatMap((item) => [item.left, item.right, item.contrastRelation])
  const candidateExampleTexts = evidenceHints.candidateExamples.flatMap((item) => [item.example, item.illustrates])
  const candidateObjectionTexts = evidenceHints.candidateObjections.flatMap((item) => [item.claim, item.limit, item.reason])
  const candidateConsequenceTexts = evidenceHints.candidateConsequences.flatMap((item) => [item.causeOrInput, item.consequence, item.whyItMatters])

  const items = plan.items.map((item) => {
    const itemContext = [item.title, item.coreClaim, item.whyItMatters, ...item.supportingPoints].join(' ')
    const requiredSignals = new Set(item.requiredSignals)

    if (candidateContrastTexts.length > 0 && overlapsHint(itemContext, candidateContrastTexts)) {
      requiredSignals.add('contrast')
    }

    if (candidateExampleTexts.length > 0 && overlapsHint(itemContext, candidateExampleTexts)) {
      requiredSignals.add('example')
    }

    if (candidateObjectionTexts.length > 0 && overlapsHint(itemContext, candidateObjectionTexts)) {
      requiredSignals.add('objection')
    }

    if (candidateConsequenceTexts.length > 0 && overlapsHint(itemContext, candidateConsequenceTexts)) {
      requiredSignals.add('causal')
    }

    return {
      ...item,
      requiredSignals: Array.from(requiredSignals),
    }
  })

  if (candidateContrastTexts.length > 0 && !items.some((item) => item.requiredSignals.includes('contrast')) && items[0]) {
    items[0] = {
      ...items[0],
      requiredSignals: Array.from(new Set([...items[0].requiredSignals, 'contrast'])),
    }
  }

  if (candidateExampleTexts.length > 0 && !items.some((item) => item.requiredSignals.includes('example')) && items[0]) {
    items[0] = {
      ...items[0],
      requiredSignals: Array.from(new Set([...items[0].requiredSignals, 'example'])),
    }
  }

  if (candidateConsequenceTexts.length > 0 && !items.some((item) => item.requiredSignals.includes('causal')) && items[0]) {
    items[0] = {
      ...items[0],
      requiredSignals: Array.from(new Set([...items[0].requiredSignals, 'causal'])),
    }
  }

  return { items }
}

export async function runReasoningPlanAgent(
  input: ReasoningPlanAgentInput,
): Promise<{ ok: true; value: ReasoningPlan; rawOutput: string } | { ok: false; error: string; rawOutput?: string }> {
  const speakerAwareGuidance = buildSpeakerAwarenessPromptGuidance(input.window)

  const system = [
    'Sos el subagente planner argumental grounded.',
    'No escribas la respuesta final.',
    'Tu tarea es extraer un plan estructural mínimo, no redactar la explicación completa.',
    'Solo marcá señales argumentales que realmente existan en la evidencia.',
    'Respondé únicamente con JSON válido.',
  ].join('\n')

  const prompt = [
    '<title>Planner argumental mínimo</title>',
    '<problem>',
    'La extracción actual quedó con thin_reasoning: tiene contenido pero no captura bien la estructura argumental.',
    '</problem>',
    '<rules>',
    'No redactes los apuntes finales.',
    'Para cada item devolvé: title, coreClaim, whyItMatters, supportingPoints, requiredSignals y citations.',
    'requiredSignals solo puede contener: contrast, objection, response, example, historical_context, causal.',
    'Si la evidencia muestra contraste, objeción o ejemplo, debés marcarlo en requiredSignals.',
    'Si no pudiste capturar una señal que el assessment dice que existe, agregala a missingRequiredSignals.',
    'No uses ejemplos de dominio fijo. Si necesitás ilustrar estructura, pensá en placeholders abstractos: [afirmación principal], [límite], [evidencia], [consecuencia].',
    'Si necesitás vocabulario concreto, tomalo solo de current_extraction, evidence o evidence_derived_prompt_hints.',
    ...speakerAwareGuidance,
    '</rules>',
    '<correction_examples>',
    'Ejemplo estructural 1 - claim con objeción y contraste => planner correcto',
    'Antes: "[afirmación principal redactada de forma superficial]."',
    'Después (plan): {"title":"[título del subtema]","coreClaim":"[afirmación principal]","whyItMatters":"[por qué importa o qué limita]","supportingPoints":["[fundamento 1]","[fundamento 2]"],"requiredSignals":["contrast","objection"],"citations":["C1","C2"]}',
    'Ejemplo estructural 2 - caso concreto => planner correcto',
    'Antes: "[se menciona un caso o ejemplo sin desarrollarlo]."',
    'Después (plan): {"title":"[título del caso]","coreClaim":"[qué ilustra el caso]","whyItMatters":"[por qué ese caso aclara la idea]","supportingPoints":["[detalle concreto del caso]"],"requiredSignals":["example"],"citations":["C3"]}',
    '</correction_examples>',
    '<current_extraction>',
    JSON.stringify(input.originalExtraction, null, 2),
    '</current_extraction>',
    '<assessment>',
    JSON.stringify({
      failureKind: input.assessment.failureKind,
      evidenceSignals: input.assessment.evidenceSignals,
      extractionSignals: input.assessment.extractionSignals,
      guidance: input.assessment.guidance,
      missingSignals: input.assessment.missingSignals,
    }, null, 2),
    '</assessment>',
    '<evidence_derived_prompt_hints>',
    JSON.stringify(input.evidenceHints ?? {
      domainVocabulary: [],
      allowedSystemTerms: [],
      candidateClaims: [],
      candidateContrasts: [],
      candidateObjections: [],
      candidateExamples: [],
      candidateConsequences: [],
    }, null, 2),
    'Los hints son sugerencias derivadas automáticamente. Si un hint no está respaldado por la evidencia, ignoralo.',
    '</evidence_derived_prompt_hints>',
    '<evidence>',
    renderEvidenceWindowMarkdown(input.window),
    '</evidence>',
  ].join('\n')

  const rawOutput = await completeOllamaResponse({
    system,
    prompt,
    maxContinuations: appConfig.maxChainSemanticEnrichmentAttempts,
    responseFormat: buildReasoningPlanSchema(input.allowedCitationIds),
    profile: {
      numCtx: appConfig.fullNotesOllamaNumCtx,
      numPredict: appConfig.fullNotesOllamaNumPredict,
      keepAlive: appConfig.ollamaKeepAlive,
    },
  })

  const parsed = parseReasoningPlan(rawOutput)
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, rawOutput }
  }

  return { ok: true, value: applyEvidenceHintsToPlan(parsed.value, input.evidenceHints), rawOutput }
}
