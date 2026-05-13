import { appConfig } from '../config.js'
import { completeOllamaResponse } from './ollamaClient.js'
import { renderEvidenceWindowMarkdown } from './evidenceWindowService.js'
import { buildWindowDraftExtractionJsonSchema } from './outputSchemas.js'
import { buildSpeakerAwarenessPromptGuidance } from './speakerAwarenessService.js'
import type { EvidenceDerivedPromptHints } from './evidenceDerivedPromptHintsService.js'
import { normalizeDraftToGroundedExtraction, parseWindowDraftExtraction } from './windowDraftNormalizerService.js'
import type { SemanticCritique } from './semanticCritiqueService.js'
import type { ReasoningPlan } from './reasoningPlanAgentService.js'
import type { EvidenceWindow, GroundedWindowExtraction } from './groundingTypes.js'

export interface ReasoningRewriteAgentInput {
  window: EvidenceWindow
  originalExtraction: GroundedWindowExtraction
  allowedCitationIds: string[]
  plan: ReasoningPlan
  critique: SemanticCritique
  evidenceHints?: EvidenceDerivedPromptHints
}

function buildPriorityChecklist(plan: ReasoningPlan, critique: SemanticCritique): string[] {
  const signalPriorityMap = new Map<string, string>([
    ['contrast', 'Agregar contraste explícito donde la evidencia lo sostenga.'],
    ['objection', 'Agregar objeción explícita cuando aparezca en la evidencia.'],
    ['response', 'Agregar respuesta o resolución de la objeción cuando aparezca en la evidencia.'],
    ['example', 'Recuperar el ejemplo o analogía presente en la evidencia.'],
    ['historical_context', 'Incorporar el contexto histórico o tradicional presente en la evidencia.'],
    ['causal', 'Explicitar la relación causal entre elementos SOLO si la evidencia la describe textualmente. No inferir importancia.'],
  ])

  const checklist = [...critique.rewritePriorities]
  for (const item of plan.items) {
    for (const signal of item.requiredSignals) {
      const priority = signalPriorityMap.get(signal)
      if (priority && !checklist.includes(priority)) {
        checklist.push(priority)
      }
    }
  }

  return checklist
}

function buildRequiredSignalsByItem(plan: ReasoningPlan): Array<{ title: string; requiredSignals: ReasoningPlan['items'][number]['requiredSignals']; unresolvedSignals: ReasoningPlan['items'][number]['missingRequiredSignals'] }> {
  return plan.items.map((item) => ({
    title: item.title,
    requiredSignals: item.requiredSignals,
    unresolvedSignals: item.missingRequiredSignals ?? [],
  }))
}

function detectSignalsInExtraction(extraction: GroundedWindowExtraction): string[] {
  const text = extraction.noteBlocks.map(b => `${b.heading} ${b.content}`).join(' ')
  const detected: string[] = []
  if (/\bsin embargo|en cambio|aunque|pero\b|mientras que|ahora bien|a pesar de|no obstante|por el contrario/i.test(text)) detected.push('contrast')
  if (/\bobjeci[oó]n|cr[ií]tica|te dir[aá]n|podr[ií]a decirse/i.test(text)) detected.push('objection')
  if (/\brespuesta|responde|contestaci[oó]n|se aclara|se responde/i.test(text)) detected.push('response')
  if (/\bejemplo|por ejemplo|analog[ií]a|imagina|igual que|viene a ser/i.test(text)) detected.push('example')
  if (/\bpor eso|porque|ya que|debido a|causó|ocasionó|llev[oó] a|de modo que/i.test(text)) detected.push('causal')
  if (/\bhistóric|histor|antecedente|contexto|tradici[oó]n|desde \d{4}|en el siglo/i.test(text)) detected.push('historical_context')
  return detected
}

export async function runReasoningRewriteAgent(
  input: ReasoningRewriteAgentInput,
): Promise<{ ok: true; extraction: GroundedWindowExtraction; rawOutput: string } | { ok: false; error: string; rawOutput: string }> {
  const speakerAwareGuidance = buildSpeakerAwarenessPromptGuidance(input.window)
  const priorityChecklist = buildPriorityChecklist(input.plan, input.critique)
  const requiredSignalsByItem = buildRequiredSignalsByItem(input.plan)
  const signalsInOriginal = detectSignalsInExtraction(input.originalExtraction)

  const system = [
    'Sos el subagente rewrite grounded.',
    'Debés producir un WindowDraftExtraction más rico y más argumental a partir de un plan intermedio y una crítica explícita del draft.',
    'No inventes información nueva.',
    'No cambies el idioma.',
    'No agregues citas fuera del set permitido.',
    'Respondé únicamente con JSON válido.',
  ].join('\n')

  const prompt = [
    '<title>Rewrite argumental</title>',
    '<problem>',
    'Reescribí la ventana corrigiendo thin_reasoning.',
    '</problem>',
    '<rules>',
    'Mantené la misma cantidad de items que current_extraction o más. No fusionés ni elimines items existentes.',
    'Cada item.text puede incluir estos elementos cuando la evidencia lo permita: (1) afirmación principal, (2) contraste/objeción o matiz, (3) fundamento o apoyo, (4) ejemplo/analogía/consecuencia/contexto.',
    'PROHIBICIÓN ABSOLUTA — violación descalifica el item:',
    '  - NO agregues oraciones de la forma "Esto importa porque...", "Esto subraya que...", "Esto indica que...", "Esta característica fomenta...", "Esto demuestra que...".',
    '  - NO uses conectores inferenciales al final: "Por lo tanto", "Por ende", "En consecuencia", "Así que", "De este modo".',
    '  - NO uses frases como "lo que sugiere que", "lo que indica que", "lo que demuestra que" como cierre.',
    '  - NO expliques por qué algo importa a menos que la evidencia lo diga textualmente.',
    '  - La última oración de cada item.text NO puede ser una síntesis editorial ni una conclusión inferida.',
    '  - ANCLA POSITIVA: la última oración debe reportar un hecho, dato o contraste de la evidencia. Si no hay más contenido grounded, terminá en la oración anterior.',
    '  - NUNCA pongas afirmaciones sin respaldo como items. Si algo no tiene evidencia suficiente, va en "insufficientEvidence", nunca en "items".',
    '  - Si la evidencia no explica la importancia de algo, omitir esa parte — nunca inventarla.',
    'No agregues analogías ni contexto histórico que no estén explícitamente sustentados por la evidencia.',
    'Podés explicitar un contraste o una objeción implícita si el plan y la evidencia la sostienen claramente.',
    'No alargues por alargar: aumentá densidad argumental, no solo cantidad de palabras.',
    'No uses ejemplos de dominio fijo. Si necesitás ilustrar una estructura, pensá en [afirmación principal], [límite], [evidencia], [consecuencia].',
    'Si necesitás vocabulario concreto, tomalo solo de current_extraction, plan, critique, evidence o evidence_derived_prompt_hints.',
    ...speakerAwareGuidance,
    '</rules>',
    '<plan>',
    JSON.stringify(input.plan, null, 2),
    '</plan>',
    '<critique>',
    JSON.stringify(input.critique, null, 2),
    '</critique>',
    '<critical_priorities>',
    ...priorityChecklist.map((item, index) => `${index + 1}. ${item}`),
    'Si una prioridad no puede resolverse sin inventar, no la inventes; mantené el contenido grounded.',
    '</critical_priorities>',
    '<required_signals_by_item>',
    JSON.stringify(requiredSignalsByItem, null, 2),
    '</required_signals_by_item>',
    '<unresolved_signals_by_item>',
    JSON.stringify(requiredSignalsByItem.map((item) => ({
      title: item.title,
      unresolvedSignals: item.unresolvedSignals,
    })), null, 2),
    '</unresolved_signals_by_item>',
    ...(signalsInOriginal.length > 0 ? [
      '<signals_present_in_original>',
      'Las siguientes señales argumentales están en current_extraction. NO PUEDEN desaparecer de tu output:',
      ...signalsInOriginal.map(s => `- ${s}`),
      'Si una señal no puede mantenerse con contenido grounded, conservá el texto original de ese item sin modificarlo.',
      '</signals_present_in_original>',
    ] : []),
    '<current_extraction>',
    JSON.stringify(input.originalExtraction, null, 2),
    '</current_extraction>',
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
    '<correction_examples>',
    'Ejemplo 1 - salida superficial',
    JSON.stringify({
      items: [
        {
          title: '[subtema principal]',
          text: '[afirmación principal superficial].',
          citations: ['C1'],
        },
      ],
      insufficientEvidence: [],
    }, null, 2),
    'Ejemplo 1 - salida corregida',
    JSON.stringify({
      items: [
        {
          title: '[subtema principal]',
          text: '[afirmación principal con datos concretos de la evidencia]. La evidencia muestra que [fundamento o apoyo específico]. [Contraste u objeción explícito cuando aparece en la evidencia, sin inferir consecuencias].',
          citations: ['C1', 'C2'],
        },
      ],
      insufficientEvidence: [],
    }, null, 2),
    'Ejemplo 2 - salida superficial',
    JSON.stringify({
      items: [
        {
          title: '[caso o ejemplo mencionado]',
          text: '[se menciona un caso sin desarrollarlo].',
          citations: ['C3'],
        },
      ],
      insufficientEvidence: [],
    }, null, 2),
    'Ejemplo 2 - salida corregida',
    JSON.stringify({
      items: [
        {
          title: '[caso o ejemplo mencionado]',
          text: 'Se desarrolla el caso concreto presente en la evidencia con sus datos específicos. [Si la evidencia describe un contraste o secuencia, se reproduce en orden]. El ejemplo queda grounded sin agregar analogías ajenas.',
          citations: ['C3'],
        },
      ],
      insufficientEvidence: [],
    }, null, 2),
    '</correction_examples>',
    '<evidence>',
    renderEvidenceWindowMarkdown(input.window),
    '</evidence>',
  ].join('\n')

  const rawOutput = await completeOllamaResponse({
    system,
    prompt,
    maxContinuations: appConfig.maxChainSemanticEnrichmentAttempts,
    responseFormat: buildWindowDraftExtractionJsonSchema(input.allowedCitationIds),
    profile: {
      numCtx: appConfig.fullNotesOllamaNumCtx,
      numPredict: appConfig.fullNotesOllamaNumPredict,
      keepAlive: appConfig.ollamaKeepAlive,
    },
  })

  const parsedDraft = parseWindowDraftExtraction(rawOutput, input.window.windowId, input.allowedCitationIds)
  if (!parsedDraft.ok) {
    return {
      ok: false,
      error: parsedDraft.error,
      rawOutput,
    }
  }

  return {
    ok: true,
    extraction: normalizeDraftToGroundedExtraction({
      draft: parsedDraft.value,
      windowId: input.window.windowId,
    }),
    rawOutput,
  }
}
