import { appConfig } from '../config.js'
import { completeOllamaResponse } from './ollamaClient.js'
import type { CitationIntegrityIssueClaim, EvidenceWindow, GroundedWindowExtraction } from './groundingTypes.js'
import { parseGroundedWindowExtraction } from './groundedSummary.js'
import { renderEvidenceWindowMarkdown } from './evidenceWindowService.js'
import { buildGroundedWindowExtractionJsonSchema } from './outputSchemas.js'

export interface CitationRepairInput {
  originalExtraction: GroundedWindowExtraction
  invalidCitationIds: string[]
  malformedCitations: string[]
  claimsWithoutCitation: CitationIntegrityIssueClaim[]
  allowedWindow: EvidenceWindow
}

export interface CitationRepairOutput {
  repairedExtraction: GroundedWindowExtraction
  removedClaims: string[]
  unresolvedClaims: string[]
}

export async function repairInvalidCitationsResponse(input: CitationRepairInput): Promise<string> {
  const system = [
    'Sos un reparador estricto de citas y compresión.',
    'Solo corregís bloques de notas usando la misma evidencia.',
    'No agregues información nueva.',
    'Respondé únicamente con JSON válido.',
  ].join('\n')

  const prompt = [
    'Tu tarea es reparar una extracción con problemas de citación o compresión.',
    'Problemas detectados:',
    `- invalidCitationIds: ${input.invalidCitationIds.join(', ') || 'ninguno'}`,
    `- malformedCitations: ${input.malformedCitations.join(', ') || 'ninguna'}`,
    `- claimsWithoutCitation: ${input.claimsWithoutCitation.map((claim) => claim.claimText).join(' | ') || 'ninguno'}`,
    `- allowedCitationIds: ${input.allowedWindow.evidence.map((item) => item.citationId).join(', ') || 'ninguna'}`,
    '',
    'Reglas obligatorias:',
    '- Respondé ÚNICAMENTE JSON válido.',
    '- No uses Markdown.',
    '- No uses bullets.',
    '- No uses numeración fuera de arrays.',
    '- No expliques nada fuera del JSON.',
    '- No escribas encabezados.',
    '- No uses ```json.',
    '- La primera letra de tu respuesta debe ser {.',
    '- La última letra de tu respuesta debe ser }.',
    '- No conviertas claims en claves JSON.',
    '- Cada afirmación debe vivir dentro de noteBlocks[].content o insufficientEvidenceClaims[].claim.',
    '- Reescribí usando solo las citas permitidas.',
    '- No agregues contenido nuevo fuera de la evidencia.',
    '- Si un bloque no puede sostenerse, eliminálo o mové una idea puntual a insufficientEvidenceClaims.',
    '- Mantené una salida suficientemente rica, no ultra resumida.',
    '- No uses formatos de cita distintos de [C1] o [C1, C2] a nivel conceptual; en JSON las citas van como arrays.',
    '',
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
    'Extracción original:',
    JSON.stringify(input.originalExtraction, null, 2),
    '',
    renderEvidenceWindowMarkdown(input.allowedWindow),
  ].join('\n')

  return completeOllamaResponse({
    system,
    prompt,
    maxContinuations: 3,
    responseFormat: buildGroundedWindowExtractionJsonSchema(input.allowedWindow.evidence.map((item) => item.citationId)),
    profile: {
      numCtx: appConfig.fullNotesOllamaNumCtx,
      numPredict: appConfig.fullNotesOllamaNumPredict,
      keepAlive: appConfig.ollamaKeepAlive,
    },
  })
}

export async function repairInvalidCitations(input: CitationRepairInput): Promise<CitationRepairOutput> {
  const parsed = parseGroundedWindowExtraction(
    await repairInvalidCitationsResponse(input),
    input.allowedWindow.windowId,
  )
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  const repairedExtraction = parsed.value

  const originalBlocks = new Set(input.originalExtraction.noteBlocks.map((block) => `${block.heading}::${block.content}`))
  const repairedBlocks = new Set(repairedExtraction.noteBlocks.map((block) => `${block.heading}::${block.content}`))
  const removedClaims = Array.from(originalBlocks).filter((value) => !repairedBlocks.has(value))
  const unresolvedClaims = input.claimsWithoutCitation
    .map((claim) => claim.claimText)
    .filter((claimText) => repairedExtraction.noteBlocks.some((block) => block.content === claimText && block.citations.length === 0))

  return {
    repairedExtraction,
    removedClaims,
    unresolvedClaims,
  }
}
