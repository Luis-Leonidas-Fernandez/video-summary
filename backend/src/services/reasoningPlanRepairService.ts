import { appConfig } from '../config.js'
import { completeOllamaResponse } from './ollamaClient.js'
import { renderEvidenceWindowMarkdown } from './evidenceWindowService.js'
import type { JsonSchemaObject } from './outputSchemas.js'
import { buildSpeakerAwarenessPromptGuidance } from './speakerAwarenessService.js'
import type { EvidenceWindow, ReasoningSignal } from './groundingTypes.js'
import type { SemanticRichnessAssessment } from './semanticRichnessClassifier.js'
import type { ReasoningPlan } from './reasoningPlanAgentService.js'

export interface ReasoningPlanRepairInput {
  window: EvidenceWindow
  plan: ReasoningPlan
  allowedCitationIds: string[]
  assessment: SemanticRichnessAssessment
}

function buildRepairSchema(allowedCitationIds: string[]): JsonSchemaObject {
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

  return values.filter((value): value is ReasoningSignal => typeof value === 'string' && allowed.includes(value as ReasoningSignal))
}

function parsePlanRepair(rawOutput: string): { ok: true; value: ReasoningPlan } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(rawOutput) as Partial<ReasoningPlan>
    if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
      return { ok: false, error: 'La reparación del plan no devolvió items válidos.' }
    }

    return {
      ok: true,
      value: {
        items: parsed.items
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
          .filter((item) => item.supportingPoints.length > 0 && item.citations.length > 0),
      },
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'No se pudo parsear la reparación del plan.',
    }
  }
}

export async function repairReasoningPlan(
  input: ReasoningPlanRepairInput,
): Promise<{ ok: true; value: ReasoningPlan; rawOutput: string } | { ok: false; error: string; rawOutput?: string }> {
  const speakerAwareGuidance = buildSpeakerAwarenessPromptGuidance(input.window)

  const system = [
    'Sos el subagente de plan repair.',
    'Tu única tarea es completar señales argumentales faltantes en un plan ya existente.',
    'No redactes la respuesta final y no inventes contenido fuera de la evidencia.',
    'Respondé únicamente con JSON válido.',
  ].join('\n')

  const prompt = [
    '<title>Repair del planner</title>',
    '<problem>',
    'El plan actual omitió señales argumentales que la evidencia sí contiene.',
    '</problem>',
    '<rules>',
    'Conservá title, coreClaim, whyItMatters, supportingPoints y citations salvo que haya un error evidente.',
    'Completá requiredSignals y missingRequiredSignals usando únicamente la evidencia y el assessment.',
    'Si la evidencia muestra contraste, objeción o ejemplo, agregalos a requiredSignals.',
    'Usá missingRequiredSignals solo si, aun después del repair, la señal no puede asignarse con confianza.',
    ...speakerAwareGuidance,
    '</rules>',
    '<assessment>',
    JSON.stringify({
      evidenceSignals: input.assessment.evidenceSignals,
      extractionSignals: input.assessment.extractionSignals,
      missingSignals: input.assessment.missingSignals,
      guidance: input.assessment.guidance,
    }, null, 2),
    '</assessment>',
    '<current_plan>',
    JSON.stringify(input.plan, null, 2),
    '</current_plan>',
    '<evidence>',
    renderEvidenceWindowMarkdown(input.window),
    '</evidence>',
  ].join('\n')

  const rawOutput = await completeOllamaResponse({
    system,
    prompt,
    maxContinuations: appConfig.maxChainSemanticEnrichmentAttempts,
    responseFormat: buildRepairSchema(input.allowedCitationIds),
    profile: {
      numCtx: appConfig.fullNotesOllamaNumCtx,
      numPredict: appConfig.fullNotesOllamaNumPredict,
      keepAlive: appConfig.ollamaKeepAlive,
    },
  })

  const parsed = parsePlanRepair(rawOutput)
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, rawOutput }
  }

  return { ok: true, value: parsed.value, rawOutput }
}
