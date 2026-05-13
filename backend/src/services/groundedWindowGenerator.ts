import { appConfig } from '../config.js'
import { completeOllamaResponse } from './ollamaClient.js'
import type { EvidenceWindow, GroundedWindowExtraction } from './groundingTypes.js'
import { parseGroundedWindowExtraction } from './groundedSummary.js'
import { renderEvidenceWindowMarkdown } from './evidenceWindowService.js'
import { buildSpeakerAwarenessPromptGuidance } from './speakerAwarenessService.js'
import { normalizeDraftToGroundedExtraction, parseWindowDraftExtraction } from './windowDraftNormalizerService.js'
import { buildGroundedWindowExtractionJsonSchema, buildWindowDraftExtractionJsonSchema } from './outputSchemas.js'

export async function generateGroundedWindowExtractionResponse({
  window,
}: {
  window: EvidenceWindow
}): Promise<string> {
  const speakerAwareGuidance = buildSpeakerAwarenessPromptGuidance(window)
  const system = [
    'Sos un redactor de apuntes exhaustivos grounded.',
    'Tu tarea es transformar esta ventana en apuntes exhaustivos de estudio.',
    'Solo podés usar la evidencia disponible.',
    'No inventes citas ni ids.',
    'Respondé únicamente con JSON válido.',
  ].join('\n')

  const prompt = appConfig.generationSchemaMode === 'simple_draft'
    ? [
        'Generá apuntes exhaustivos de esta ventana en español.',
        'Respondé ÚNICAMENTE JSON válido.',
        'No uses Markdown.',
        'No uses ```json.',
        'No escribas texto antes ni después.',
        '',
        'Schema obligatorio:',
        '{',
        '  "items": [',
        '    {',
        '      "title": "string",',
        '      "text": "string",',
        '      "citations": ["C1"]',
        '    }',
        '  ],',
        '  "insufficientEvidence": [',
        '    {',
        '      "claim": "string",',
        '      "reason": "string"',
        '    }',
        '  ]',
        '}',
        '',
        'Reglas:',
        '- Usá solo las citas disponibles.',
        '- No inventes citas.',
        '- Cada item debe tener al menos una cita.',
        '- No uses inglés.',
        '- No reduzcas todo a una sola idea.',
        '- Si un chunk tiene fases o subtemas distintos, generá un item por cada uno. Señales de corte dentro de un chunk: el hablante introduce un nuevo test, ejemplo, caso o pregunta; hay una transición temática explícita ("ahora", "para el siguiente", "un nuevo caso"); o hay setup con contenido sustancial seguido de su resultado.',
        '- Cada item cubre contenido único. Si un actor o concepto ya fue desarrollado en otro item, no crees un item nuevo para repetirlo.',
        '- Conservá explicaciones, ejemplos, matices, objeciones y respuestas importantes.',
        '- Cada item.text debe tener entre 5 y 8 oraciones cuando la evidencia lo permita. No comprimas a menos de 5 oraciones un concepto que la evidencia desarrolla con más detalle.',
        '- Si el hablante dedica varios fragmentos a explicar algo, el item correspondiente debe reflejar ese nivel de profundidad, no comprimirlo a 1-3 oraciones.',
        '- Priorizá los chunks con rol primary.',
        '- Usá overlap_context solo para continuidad.',
        ...speakerAwareGuidance.map((item) => `- ${item}`),
        '- Si no hay evidencia suficiente para algo, ponelo en insufficientEvidence.',
        '- No incluyas saludos, despedidas, agradecimientos, emails ni promesas de continuidad salvo que sean doctrinalmente relevantes.',
        '',
        'Ejemplo bueno de salida:',
        '{',
        '  "items": [',
        '    {',
        '      "title": "[subtema principal]",',
        '      "text": "Se explica [afirmación principal]. También se hace explícito [límite, objeción, contraste o consecuencia] cuando la evidencia lo sostiene, sin introducir conceptos externos al contenido de la ventana.",',
        '      "citations": ["C1", "C2"]',
        '    }',
        '  ],',
        '  "insufficientEvidence": [',
        '    {',
        '      "claim": "Un detalle adicional no sostenido por la ventana",',
        '      "reason": "La evidencia disponible no alcanza para afirmarlo con precisión"',
        '    }',
        '  ]',
        '}',
        '',
        renderEvidenceWindowMarkdown(window),
      ].join('\n')
    : [
        'Generá una extracción exhaustiva local de esta ventana.',
        'Contrato de salida JSON exacto:',
        '{',
        '  "noteBlocks": [',
        '    {',
        '      "heading": "string",',
        '      "content": "string",',
        '      "citations": ["C1", "C2"],',
        '      "coverageType": "definition|explanation|example|argument|sequence|detail"',
        '    }',
        '  ],',
        '  "insufficientEvidenceClaims": [',
        '    { "claim": "string", "section": "string opcional" }',
        '  ]',
        '}',
        '',
        'Reglas obligatorias:',
        '- No hagas un resumen breve.',
        '- No reduzcas la ventana a ideas principales.',
        '- Cubrí casi todo lo dicho en la ventana, en orden cronológico.',
        '- Conservá explicaciones, ejemplos, aclaraciones, objeciones, respuestas, matices y relaciones entre ideas.',
        '- Si el hablante desarrolla una idea en varios pasos, reproducí esos pasos de forma ordenada.',
        '- Si aparece un ejemplo, incluilo.',
        '- Si aparece una comparación, incluila.',
        '- Si aparece una objeción o contrapunto, incluilo.',
        '- La salida debe sentirse como apuntes completos, no como síntesis ejecutiva.',
        '- Cada bloque debe desarrollarse en al menos 3 oraciones cuando la evidencia lo permita. No reduzcas un concepto a 1-2 oraciones si la evidencia lo explica con más detalle.',
        '- Si el hablante dedica varios fragmentos a explicar algo, el bloque correspondiente debe reflejar ese nivel de profundidad, no comprimirlo a una sola idea.',
        '- Generá bloques suficientemente ricos, con explicación y matices cuando existan.',
        '- Priorizá los chunks con rol primary.',
        '- Usá overlap_context solo para continuidad.',
        ...speakerAwareGuidance.map((item) => `- ${item}`),
        '- Solo eliminá muletillas, repeticiones vacías y ruido de transcripción.',
        '- No inventes emails, correos, links, promesas de continuidad ni invitaciones futuras si no aparecen explícitamente en la evidencia.',
        '- Cada noteBlock debe terminar respaldado por una o más citas válidas.',
        '- Solo son válidas las citas [C1] y [C1, C2] según el set permitido de esta ventana.',
        '- Si algo no puede sostenerse, movelo a insufficientEvidenceClaims.',
        '- No agregues texto fuera del JSON.',
        '',
        renderEvidenceWindowMarkdown(window),
      ].join('\n')

  return completeOllamaResponse({
    system,
    prompt,
    maxContinuations: 3,
    responseFormat: appConfig.generationSchemaMode === 'simple_draft'
      ? buildWindowDraftExtractionJsonSchema(window.evidence.map((item) => item.citationId))
      : buildGroundedWindowExtractionJsonSchema(window.evidence.map((item) => item.citationId)),
    profile: {
      numCtx: appConfig.fullNotesOllamaNumCtx,
      numPredict: appConfig.fullNotesOllamaNumPredict,
        keepAlive: appConfig.ollamaKeepAlive,
      },
  })
}

export async function generateGroundedWindowExtraction({
  window,
}: {
  window: EvidenceWindow
}): Promise<GroundedWindowExtraction> {
  const raw = await generateGroundedWindowExtractionResponse({ window })
  if (appConfig.generationSchemaMode === 'simple_draft') {
    const parsedDraft = parseWindowDraftExtraction(raw, window.windowId, window.evidence.map((item) => item.citationId))
    if (!parsedDraft.ok) {
      throw new Error(parsedDraft.error)
    }

    return normalizeDraftToGroundedExtraction({ draft: parsedDraft.value, windowId: window.windowId })
  }

  const parsed = parseGroundedWindowExtraction(raw, window.windowId)
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }

  return parsed.value
}
