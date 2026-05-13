export type JsonSchemaObject = Record<string, unknown>

function buildCitationItemsSchema(allowedCitationIds: string[]) {
  const uniqueCitationIds = Array.from(new Set(allowedCitationIds.map((item) => item.trim()).filter(Boolean)))

  return {
    type: 'string',
    description: uniqueCitationIds.length > 0
      ? `Solo se permite usar uno de estos ids de cita para esta ventana: ${uniqueCitationIds.join(', ')}.`
      : 'Id de cita permitido para esta ventana.',
    ...(uniqueCitationIds.length > 0 ? { enum: uniqueCitationIds } : {}),
  }
}

export function buildWindowDraftExtractionJsonSchema(allowedCitationIds: string[]): JsonSchemaObject {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['items', 'insufficientEvidence'],
    properties: {
      items: {
        type: 'array',
        description: 'Lista de ideas editoriales en español para esta ventana. Cada item debe desarrollar una idea concreta con suficiente detalle.',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'text', 'citations'],
          properties: {
            title: {
              type: 'string',
              description: 'Título breve en español que resuma una idea doctrinal o argumental concreta de la ventana.',
            },
            text: {
              type: 'string',
              description: 'Desarrollo en español con suficiente detalle editorial. No incluir saludos, despedidas, promesas de continuidad, emails ni cierre conversacional.',
            },
            citations: {
              type: 'array',
              description: 'Uno o más ids de cita válidos para respaldar este item.',
              minItems: 1,
              items: buildCitationItemsSchema(allowedCitationIds),
            },
          },
        },
      },
      insufficientEvidence: {
        type: 'array',
        description: 'Afirmaciones o subtemas que no pueden sostenerse correctamente solo con la evidencia de esta ventana.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['claim'],
          properties: {
            claim: {
              type: 'string',
              description: 'Afirmación en español que no pudo sostenerse con evidencia suficiente en esta ventana.',
            },
            reason: {
              type: 'string',
              description: 'Razón breve por la que faltó evidencia suficiente.',
            },
          },
        },
      },
    },
  }
}

export function buildGroundedWindowExtractionJsonSchema(allowedCitationIds: string[]): JsonSchemaObject {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['noteBlocks', 'insufficientEvidenceClaims'],
    properties: {
      noteBlocks: {
        type: 'array',
        description: 'Bloques de notas grounded en español. Cada bloque debe ser editorialmente útil y estar respaldado por citas válidas de la ventana.',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['heading', 'content', 'citations', 'coverageType'],
          properties: {
            heading: {
              type: 'string',
              description: 'Heading breve en español para una idea concreta del bloque.',
            },
            content: {
              type: 'string',
              description: 'Contenido en español suficientemente rico, sin saludos, despedidas, meta conversación ni texto de cierre.',
            },
            citations: {
              type: 'array',
              description: 'Ids de citas permitidos para este bloque.',
              minItems: 1,
              items: buildCitationItemsSchema(allowedCitationIds),
            },
            coverageType: {
              type: 'string',
              description: 'Tipo editorial dominante del bloque.',
              enum: ['definition', 'explanation', 'example', 'argument', 'sequence', 'detail'],
            },
          },
        },
      },
      insufficientEvidenceClaims: {
        type: 'array',
        description: 'Afirmaciones en español que no pudieron sostenerse suficientemente con la evidencia disponible.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['claim'],
          properties: {
            claim: {
              type: 'string',
              description: 'Afirmación concreta que quedó sin evidencia suficiente.',
            },
            section: {
              type: 'string',
              description: 'Sección o contexto breve al que pertenece la afirmación.',
            },
          },
        },
      },
    },
  }
}
