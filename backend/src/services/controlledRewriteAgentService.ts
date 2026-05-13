import { appConfig } from '../config.js'
import { completeOllamaResponse } from './ollamaClient.js'
import type { JsonSchemaObject } from './outputSchemas.js'
import { buildWindowDraftExtractionJsonSchema } from './outputSchemas.js'
import { normalizeDraftToGroundedExtraction, parseWindowDraftExtraction } from './windowDraftNormalizerService.js'
import type { GroundedWindowExtraction } from './groundingTypes.js'
import type { ControlledAppliedChangeMarker, ControlledRewriteResult, MinimalEvidenceQuote, ResolvedChangeSet } from './experimentalRewriteTypes.js'

export interface ControlledRewriteAgentInput {
  currentExtraction: GroundedWindowExtraction
  resolvedChanges: ResolvedChangeSet
  minimalEvidence: MinimalEvidenceQuote[]
  allowedCitationIds: string[]
  passMode?: 'default' | 'density_pass'
}

function normalizeControlledRewriteResult(
  result: ControlledRewriteResult,
  allChangeIds: string[],
): ControlledRewriteResult {
  const normalizedAppliedChanges = result.appliedChanges
    .filter((item, index, array) => array.findIndex((candidate) => candidate.changeId === item.changeId) === index)
  const appliedSet = new Set(normalizedAppliedChanges.map((item) => item.changeId))
  const rejectedChanges = result.rejectedChanges
    .filter((item) => !appliedSet.has(item.changeId))
    .filter((item, index, array) => array.findIndex((candidate) => candidate.changeId === item.changeId) === index)

  const rejectedSet = new Set(rejectedChanges.map((item) => item.changeId))
  for (const changeId of allChangeIds) {
    if (!appliedSet.has(changeId) && !rejectedSet.has(changeId)) {
      rejectedChanges.push({
        changeId,
        reason: 'El controlled rewrite no informó una aplicación segura para este cambio.',
      })
    }
  }

  return {
    rewrittenExtraction: result.rewrittenExtraction,
    appliedChanges: normalizedAppliedChanges,
    rejectedChanges,
  }
}

function buildControlledRewriteSchema(allowedCitationIds: string[], changeIds: string[]): JsonSchemaObject {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['rewrittenExtraction', 'appliedChanges', 'rejectedChanges'],
    properties: {
      rewrittenExtraction: buildWindowDraftExtractionJsonSchema(allowedCitationIds),
      appliedChanges: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['changeId', 'applied'],
          properties: {
            changeId: {
              type: 'string',
              ...(changeIds.length > 0 ? { enum: changeIds } : {}),
            },
            applied: { type: 'boolean' },
          },
        },
      },
      rejectedChanges: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['changeId', 'reason'],
          properties: {
            changeId: {
              type: 'string',
              ...(changeIds.length > 0 ? { enum: changeIds } : {}),
            },
            reason: { type: 'string' },
          },
        },
      },
    },
  }
}

function parseControlledRewriteResult(rawOutput: string, windowId: string, allowedCitationIds: string[]): { ok: true; value: ControlledRewriteResult } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(rawOutput) as {
      rewrittenExtraction?: unknown
      appliedChanges?: unknown
      rejectedChanges?: unknown
    }

    const extractionRaw = JSON.stringify(parsed.rewrittenExtraction ?? {})
    const extractionParsed = parseWindowDraftExtraction(extractionRaw, windowId, allowedCitationIds)
    if (!extractionParsed.ok) {
      return { ok: false, error: extractionParsed.error }
    }

    const appliedChanges = Array.isArray(parsed.appliedChanges)
      ? parsed.appliedChanges
        .filter((item) =>
          item
          && typeof item.changeId === 'string'
          && typeof item.applied === 'boolean',
        )
        .map((item: {
          changeId: string
          applied: boolean
        }): ControlledAppliedChangeMarker => ({
          changeId: item.changeId,
          applied: item.applied,
        }))
      : []

    const rejectedChanges = Array.isArray(parsed.rejectedChanges)
      ? parsed.rejectedChanges
        .filter((item) => item && typeof item.changeId === 'string' && typeof item.reason === 'string')
        .map((item) => ({
          changeId: item.changeId,
          reason: item.reason,
        }))
      : []

    return {
      ok: true,
      value: {
        rewrittenExtraction: normalizeDraftToGroundedExtraction({
          draft: extractionParsed.value,
          windowId,
        }),
        appliedChanges: appliedChanges.filter((item) => item.applied),
        rejectedChanges,
      },
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'No se pudo parsear el resultado del controlled rewrite.',
    }
  }
}

export async function runControlledRewriteAgent(
  input: ControlledRewriteAgentInput,
): Promise<{ ok: true; value: ControlledRewriteResult; rawOutput: string } | { ok: false; error: string; rawOutput: string }> {
  const system = [
    'Sos un agente de REESCRITURA CONTROLADA.',
    'Tu única tarea es transformar el texto manteniendo EXACTAMENTE el significado.',
    'NO debes agregar ideas, cambiar el argumento, reinterpretar el plan ni resolver inconsistencias.',
    'Debes mejorar claridad, ordenar mejor la estructura y hacer explícito solo lo que ya está implícito si está en el texto y en la evidencia mínima.',
    'Si una mejora no es segura, NO la hagas.',
    'Devuelve SOLO JSON válido.',
  ].join('\n')

  const prompt = [
    '<problem>',
    'El plan y la critique ya fueron resueltos. Vos NO tomás decisiones nuevas: solo ejecutás cambios resueltos si son seguros.',
    '</problem>',
    '<rules>',
    'Usá únicamente current_extraction, resolved_changes y minimal_evidence.',
    'No inventes texto nuevo que no esté justificado por resolved_changes + minimal_evidence.',
    'Si un cambio no es seguro, rechazalo con una reason explícita.',
    'Preservá títulos, citas y señales argumentales existentes salvo que un cambio resuelto indique una operación segura sobre ese scope.',
    'Si operationScope=section_order, solo podés reordenar secciones; no reescribas su contenido por ese cambio.',
    'Si operationScope=item_citations, solo podés ajustar citas del item; no cambies el argumento del texto.',
    'Antes de aplicar cada cambio, identificá las protectedSignals del item original objetivo.',
    'Después de reescribir, verificá que esas protectedSignals sigan presentes.',
    'Si una protectedSignal desaparece, rechazá ese cambio y explicá por qué.',
    'Usá minimumRewriteRequirement como umbral mínimo para decidir si un cambio fue realmente aplicado.',
    'Un change solo cuenta como applied si de verdad quedó aplicado.',
    'Para restore_existing_signal: la instruction del cambio puede ser genérica, pero los evidenceQuoteIds del cambio apuntan a los quotes de minimal_evidence que contienen el fragmento específico con la señal a restaurar. Buscá esos quotes y reintroducí la oración, dato o analogía que expresa la señal faltante.',
    'Para restore_existing_signal de objection: no alcanza con agregar “pero” o “sin embargo”; tiene que aparecer una oración explícita que limite, cuestione o matice la afirmación principal y aclare el contraargumento.',
    'Para restore_existing_signal de contrast: debe quedar una oposición clara entre dos ideas, enfoques o consecuencias. Buscá en los evidenceQuoteIds del cambio el fragmento que contiene la oposición.',
    'Para restore_existing_signal de example: solo vale si preserva o reintroduce un caso concreto o analogía ya presente en minimal_evidence. Buscá en los evidenceQuoteIds del cambio el ejemplo o analogía concretos.',
    'Para cambios de expansión grounded (expand_why_it_matters, expand_causal_link, expand_consequence, expand_evidence_binding, increase_argument_density): expandí la densidad argumental sin cambiar el significado y apoyándote solo en evidenceQuoteIds provistos.',
    'Un cambio de expansión grounded NO puede contar como applied si solo rephrasing el texto sin agregar why-it-matters, causalidad, consecuencia o binding con evidencia de forma verificable.',
    'NO te autoevalúes: no declares restoredSignals ni minimumRequirementSatisfied.',
    'Para cada appliedChange devolvé solo changeId y applied=true.',
    'Si no podés justificar que el cambio quedó realmente insertado en el texto final, rechazá el change.',
    ...(input.passMode === 'density_pass'
      ? [
          'ESTÁS EN DENSITY PASS: solo podés intentar mejorar densidad argumental en los cambios aún abiertos.',
          'No agregues citas nuevas.',
          'No agregues ejemplos nuevos.',
          'No cambies items fuera del scope explícito de resolved_changes.',
        ]
      : []),
    '</rules>',
    '<current_extraction>',
    JSON.stringify(input.currentExtraction, null, 2),
    '</current_extraction>',
    '<resolved_changes>',
    JSON.stringify(input.resolvedChanges, null, 2),
    '</resolved_changes>',
    '<minimal_evidence>',
    JSON.stringify(input.minimalEvidence, null, 2),
    '</minimal_evidence>',
    '<output_contract>',
    'Debés devolver rewrittenExtraction, appliedChanges y rejectedChanges.',
    'appliedChanges NO es una lista de intentos: es una lista de cambios efectivamente aplicados.',
    '</output_contract>',
    '<examples>',
    JSON.stringify({
      rewrittenExtraction: {
        items: [
          {
            title: '[subtema principal]',
            text: '[afirmación principal]. La objeción es que [límite o contraargumento grounded]. La evidencia muestra que [razón concreta], sin introducir conceptos externos.',
            citations: ['C1', 'C2'],
          },
        ],
        insufficientEvidence: [],
      },
      appliedChanges: [
        {
          changeId: 'chg-1',
          applied: true,
        },
      ],
      rejectedChanges: [],
    }, null, 2),
    JSON.stringify({
      rewrittenExtraction: {
        items: [
          {
            title: '[subtema principal]',
            text: '[afirmación principal]. Esto importa porque [por qué importa o consecuencia grounded]. El texto une mejor la idea con la evidencia sin cambiar el significado.',
            citations: ['C3'],
          },
        ],
        insufficientEvidence: [],
      },
      appliedChanges: [
        {
          changeId: 'exp-1',
          applied: true,
        },
      ],
      rejectedChanges: [],
    }, null, 2),
    JSON.stringify({
      rewrittenExtraction: {
        items: [
          {
            title: 'Analogía',
            text: 'Se menciona una analogía.',
            citations: ['C3'],
          },
        ],
        insufficientEvidence: [],
      },
      appliedChanges: [],
      rejectedChanges: [
        {
          changeId: 'chg-2',
          reason: 'La mejora no era segura porque la evidencia mínima no contenía el ejemplo explícito completo.',
        },
      ],
    }, null, 2),
    '</examples>',
  ].join('\n')

  const rawOutput = await completeOllamaResponse({
    system,
    prompt,
    maxContinuations: appConfig.maxChainSemanticEnrichmentAttempts,
    responseFormat: buildControlledRewriteSchema(
      input.allowedCitationIds,
      input.resolvedChanges.changes.map((change) => change.changeId),
    ),
    profile: {
      numCtx: appConfig.fullNotesOllamaNumCtx,
      numPredict: appConfig.fullNotesOllamaNumPredict,
      keepAlive: appConfig.ollamaKeepAlive,
    },
  })

  const parsed = parseControlledRewriteResult(rawOutput, input.currentExtraction.windowId, input.allowedCitationIds)
  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.error,
      rawOutput,
    }
  }

  const normalized = normalizeControlledRewriteResult(
    parsed.value,
    input.resolvedChanges.changes.map((change) => change.changeId),
  )

  return {
    ok: true,
    value: normalized,
    rawOutput,
  }
}
