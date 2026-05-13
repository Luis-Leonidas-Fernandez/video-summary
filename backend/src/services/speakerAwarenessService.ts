import type { ChunkManifestChunk, EvidenceWindow } from './groundingTypes.js'

const INTERRUPTION_MARKERS = /\b(s[ií]|no|claro|aj[aá]|vale|ok|bueno|muy bien|dale|perfecto|exacto|correcto|mm|eh)\b/gi
const ADDRESSING_MARKERS = /\b(diego|santi|hermano|hermanazo|querido|amigo|doctor|maestro)\b/gi

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((item) => item.trim())
    .filter(Boolean)
}

function countWords(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length
}

function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern)
  return matches ? matches.length : 0
}

function buildOverlapSignals(text: string): { score: number; signals: string[] } {
  const sentences = splitSentences(text)
  const shortTurns = sentences.filter((sentence) => countWords(sentence) <= 6).length
  const questions = sentences.filter((sentence) => sentence.includes('?') || sentence.includes('¿')).length
  const interruptions = countMatches(text, INTERRUPTION_MARKERS)
  const addressing = countMatches(text, ADDRESSING_MARKERS)

  let score = 0
  const signals: string[] = []

  if (shortTurns >= 4) {
    score += 2
    signals.push(`short_turns:${shortTurns}`)
  }

  if (questions >= 2) {
    score += 1
    signals.push(`questions:${questions}`)
  }

  if (interruptions >= 4) {
    score += 2
    signals.push(`interruptions:${interruptions}`)
  }

  if (addressing >= 2) {
    score += 1
    signals.push(`addressing:${addressing}`)
  }

  return { score, signals }
}

export function annotateChunkSpeakerAwareness({
  chunk,
  speakerCountHint,
}: {
  chunk: ChunkManifestChunk
  speakerCountHint?: number
}): ChunkManifestChunk {
  const normalizedSpeakerCount = speakerCountHint && speakerCountHint > 0 ? speakerCountHint : undefined
  if (!normalizedSpeakerCount || normalizedSpeakerCount <= 1) {
    return {
      ...chunk,
      overlapDetected: false,
      speakerCountHint: normalizedSpeakerCount,
      transcriptionConfidence: 'normal',
      overlapRiskScore: 0,
      overlapSignals: [],
    }
  }

  const { score, signals } = buildOverlapSignals(chunk.text)
  const overlapDetected = score >= 3

  return {
    ...chunk,
    overlapDetected,
    speakerCountHint: normalizedSpeakerCount,
    transcriptionConfidence: overlapDetected ? 'lower' : 'normal',
    overlapRiskScore: score,
    overlapSignals: signals,
  }
}

export function summarizeWindowSpeakerAwareness(window: EvidenceWindow): EvidenceWindow {
  const overlapChunkCount = window.evidence.filter((chunk) => chunk.overlapDetected).length
  const overlapDetected = overlapChunkCount > 0
  const speakerCountHint = window.evidence.find((chunk) => chunk.speakerCountHint)?.speakerCountHint
  const transcriptionConfidence = overlapDetected ? 'lower' : 'normal'

  return {
    ...window,
    overlapDetected,
    speakerCountHint,
    transcriptionConfidence,
    overlapChunkCount,
  }
}

export function buildSpeakerAwarenessLogLine(chunks: ChunkManifestChunk[]): string | null {
  const overlapChunks = chunks.filter((chunk) => chunk.overlapDetected)
  if (overlapChunks.length === 0) {
    return null
  }

  const hintedSpeakers = overlapChunks[0]?.speakerCountHint
  return `Speaker awareness heurística: ${overlapChunks.length}/${chunks.length} chunks con riesgo de solapamiento${hintedSpeakers ? `, hint de speakers=${hintedSpeakers}` : ''}.`
}

export function buildSpeakerAwarenessPromptGuidance(window: EvidenceWindow): string[] {
  if (!window.overlapDetected) {
    return []
  }

  return [
    'Hay riesgo de voces superpuestas en esta ventana.',
    'No trates esta evidencia como monólogo limpio: priorizá tesis, objeciones y respuestas explícitas.',
    'Si una frase parece ambigua por cruce de voces, evitá inferir demasiado y preferí insufficientEvidence antes que sobreinterpretar.',
  ]
}
