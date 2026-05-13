import { appConfig } from '../config.js'
import { completeOllamaResponse } from './ollamaClient.js'
import type { EvidenceWindow, WindowOutputFailureKind } from './groundingTypes.js'
import { renderEvidenceWindowMarkdown } from './evidenceWindowService.js'
import { buildGroundedWindowExtractionJsonSchema, buildWindowDraftExtractionJsonSchema } from './outputSchemas.js'

export async function strictReemitWindowExtraction({
  window,
  failureKind,
  previousError,
  previousRawOutput,
}: {
  window: EvidenceWindow
  failureKind?: WindowOutputFailureKind
  previousError?: string
  previousRawOutput?: string
}): Promise<string> {
  const system = [
    'Sos un reemisor estricto de extracciones JSON.',
    'Tu única tarea es reemitir la misma extracción usando exclusivamente la evidencia de esta ventana.',
    'No agregues información nueva.',
    'No hagas resumen global.',
    'No cambies el idioma.',
    'Respondé únicamente con JSON válido.',
  ].join('\n')

  const prompt = [
    'Reemití la extracción usando exclusivamente la evidencia de esta ventana.',
    'No agregues información nueva.',
    'No hagas resumen global.',
    'No cambies el idioma.',
    'Respondé solo JSON válido.',
    '',
    `Tipo de falla previo: ${failureKind ?? 'unknown'}.`,
    previousError ? `Error anterior: ${previousError}.` : '',
    'La salida anterior estuvo malformada o editorialmente inválida.',
    'No repitas el formato anterior si usó schemas alternativos como topic, sections, references, keywords, description o similares.',
    'No uses headings en inglés si la tarea está en español.',
    'No devuelvas una respuesta tipo ensayo, artículo o resumen narrativo.',
    'Contrato de salida JSON exacto:',
    ...(appConfig.generationSchemaMode === 'simple_draft'
      ? [
          '{',
          '  "items": [',
          '    {',
          '      "title": "string",',
          '      "text": "string",',
          '      "citations": ["C1"]',
          '    }',
          '  ],',
          '  "insufficientEvidence": [',
          '    { "claim": "string", "reason": "string opcional" }',
          '  ]',
          '}',
        ]
      : [
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
        ]),
    '',
    'Reglas obligatorias:',
    '- La primera letra de tu respuesta debe ser {.',
    '- La última letra de tu respuesta debe ser }.',
    '- No uses Markdown.',
    '- No uses ```json.',
    '- No escribas texto fuera del JSON.',
    '- No uses schemas alternativos como topic, sections, references, keywords o description.',
    '- No cambies headings al inglés.',
    '- Si no podés sostener una idea, movela a insufficientEvidenceClaims.',
    '- No incluyas saludos, despedidas, agradecimientos, emails ni promesas de continuidad.',
    previousRawOutput
      ? ['', 'Salida anterior defectuosa (solo para corregir el contrato, no para copiar estructura):', previousRawOutput.slice(0, 1600)].join('\n')
      : '',
    '',
    renderEvidenceWindowMarkdown(window),
  ].filter(Boolean).join('\n')

  return completeOllamaResponse({
    system,
    prompt,
    maxContinuations: 2,
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
