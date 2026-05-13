import { appConfig } from '../config.js'
import { completeOllamaResponse } from './ollamaClient.js'
import { buildGroundedWindowExtractionJsonSchema, buildWindowDraftExtractionJsonSchema } from './outputSchemas.js'

export interface JsonContractRepairInput {
  rawModelOutput: string
  expectedSchemaName: 'GroundedWindowExtraction' | 'WindowDraftExtraction'
  allowedCitationIds: string[]
  windowId: string
}

export interface JsonContractRepairResult {
  ok: boolean
  repairedJsonText?: string
  error?: string
}

export async function repairJsonContract(
  input: JsonContractRepairInput,
): Promise<JsonContractRepairResult> {
  if (appConfig.maxJsonContractRepairAttempts <= 0) {
    return {
      ok: false,
      error: 'La reparación contractual de JSON está desactivada.',
    }
  }

  const system = [
    'Sos un reparador estricto de contratos JSON.',
    'Tu única tarea es convertir una respuesta malformada al schema pedido.',
    'No agregues información nueva.',
    'No inventes citas.',
    'Respondé únicamente con JSON válido.',
    'No uses Markdown.',
    'No uses bullets.',
    'La primera letra de tu respuesta debe ser {.',
    'La última letra de tu respuesta debe ser }.',
  ].join('\n')

  const schemaLines = input.expectedSchemaName === 'WindowDraftExtraction'
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
        '    {',
        '      "claim": "string",',
        '      "reason": "string opcional"',
        '    }',
        '  ]',
        '}',
      ]
    : [
        '{',
        '  "noteBlocks": [',
        '    {',
        '      "heading": "string",',
        '      "content": "string",',
        '      "citations": ["C1"],',
        '      "coverageType": "definition|explanation|example|argument|sequence|detail"',
        '    }',
        '  ],',
        '  "insufficientEvidenceClaims": [',
        '    {',
        '      "claim": "string",',
        '      "section": "string"',
        '    }',
        '  ]',
        '}',
      ]

  const prompt = [
    'La siguiente respuesta debía ser JSON válido, pero está malformada.',
    `Schema esperado: ${input.expectedSchemaName}.`,
    'Convertí el contenido al siguiente schema.',
    'No agregues información nueva.',
    'No uses Markdown.',
    'No expliques.',
    `Usá solo estas citas permitidas: ${input.allowedCitationIds.join(', ') || 'ninguna'}.`,
    '',
    'SCHEMA:',
    ...schemaLines,
    '',
    'RESPUESTA MALFORMADA:',
    input.rawModelOutput,
  ].join('\n')

  try {
    const repairedJsonText = await completeOllamaResponse({
      system,
      prompt,
      maxContinuations: 1,
      responseFormat: input.expectedSchemaName === 'WindowDraftExtraction'
        ? buildWindowDraftExtractionJsonSchema(input.allowedCitationIds)
        : buildGroundedWindowExtractionJsonSchema(input.allowedCitationIds),
      profile: {
        numCtx: appConfig.fullNotesOllamaNumCtx,
        numPredict: appConfig.fullNotesOllamaNumPredict,
        keepAlive: appConfig.ollamaKeepAlive,
      },
    })

    return {
      ok: true,
      repairedJsonText,
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error
        ? `jsonContractRepair falló para ${input.windowId}: ${error.message}`
        : `jsonContractRepair falló para ${input.windowId}.`,
    }
  }
}
