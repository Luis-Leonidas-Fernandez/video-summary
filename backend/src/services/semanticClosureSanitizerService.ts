import type { EvidenceChunk, EvidenceWindow } from './groundingTypes.js'

export interface SanitizedEvidenceWindow {
  window: EvidenceWindow
  doctrinalEvidence: EvidenceChunk[]
  excludedConversationalEvidence: EvidenceChunk[]
  hasStrongClosurePollution: boolean
}

const CONVERSATIONAL_PATTERN = /\bgracias(?!\s+a\b)|hasta luego|que est[eé]n muy bien|podemos seguir dialogando|sin ningún problema|mandas un e-?mail|mandame un e-?mail|e-?mail|\bcorreo\b|canal de youtube|abrazo|dios te bendiga|buenas tardes|buenos d[ií]as|hermanazo|querido|gracias por el espacio|bueno, listo|suscrib[ií]rse|suscr[ií]bete|newsletter|bolet[ií]n|dale me gusta|thanks for watching|see you in the next|remember to like|stay tuned|subscribe to my|descripci[oó]n.{0,30}(enlace|link)/i
const DOCTRINAL_PATTERN = /interced|dogma|escritura|cristo|jes[uú]s|mar[ií]a|santo|iglesia|concilio|tradici[oó]n|biblia|sir[aá]cida|macabeos|romanos|evangelio|deutero|can[oó]nico/i

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function isConversationalOnly(sentence: string): boolean {
  return CONVERSATIONAL_PATTERN.test(sentence) && !DOCTRINAL_PATTERN.test(sentence)
}

function sanitizeChunkText(text: string): {
  doctrinalText: string | null
  excludedText: string | null
  chunkKind: 'doctrinal' | 'mixed' | 'conversational_only'
} {
  const sentences = splitSentences(text)
  if (sentences.length === 0) {
    return { doctrinalText: null, excludedText: null, chunkKind: 'conversational_only' }
  }

  const doctrinalSentences = sentences.filter((sentence) => !isConversationalOnly(sentence))
  const excludedSentences = sentences.filter((sentence) => isConversationalOnly(sentence))
  const hasDoctrinalContent = doctrinalSentences.length > 0
  const hasConversationalContent = excludedSentences.length > 0

  if (hasDoctrinalContent && hasConversationalContent) {
    return {
      doctrinalText: text.trim(),
      excludedText: excludedSentences.join(' '),
      chunkKind: 'mixed',
    }
  }

  if (hasDoctrinalContent) {
    return {
      doctrinalText: doctrinalSentences.join(' '),
      excludedText: null,
      chunkKind: 'doctrinal',
    }
  }

  return {
    doctrinalText: null,
    excludedText: excludedSentences.length > 0 ? excludedSentences.join(' ') : null,
    chunkKind: 'conversational_only',
  }
}

export function sanitizeClosurePollutionWindow(window: EvidenceWindow): SanitizedEvidenceWindow {
  const doctrinalEvidence: EvidenceChunk[] = []
  const excludedConversationalEvidence: EvidenceChunk[] = []

  for (const chunk of window.evidence) {
    const sanitized = sanitizeChunkText(chunk.text)
    if (sanitized.doctrinalText) {
      doctrinalEvidence.push({
        ...chunk,
        text: sanitized.doctrinalText,
      })
    }
    if (sanitized.excludedText) {
      excludedConversationalEvidence.push({
        ...chunk,
        text: sanitized.excludedText,
      })
    }
  }

  const finalDoctrinalEvidence = doctrinalEvidence.length > 0 ? doctrinalEvidence : window.evidence

  return {
    window: {
      ...window,
      evidence: finalDoctrinalEvidence,
    },
    doctrinalEvidence: finalDoctrinalEvidence,
    excludedConversationalEvidence,
    hasStrongClosurePollution: excludedConversationalEvidence.length > 0,
  }
}
