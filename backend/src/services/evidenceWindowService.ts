import { appConfig } from '../config.js'
import type { ChunkManifestChunk, EvidenceChunk, EvidencePackDocument, EvidenceWindow } from './groundingTypes.js'
import { summarizeWindowSpeakerAwareness } from './speakerAwarenessService.js'

function clipText(value: string, maxChars: number): string {
  const trimmed = value.trim()
  if (trimmed.length <= maxChars) {
    return trimmed
  }

  return `${trimmed.slice(0, maxChars).trimEnd()}…`
}

function uniqueByChunkId(chunks: ChunkManifestChunk[]): ChunkManifestChunk[] {
  const seen = new Set<string>()
  const ordered: ChunkManifestChunk[] = []

  for (const chunk of chunks) {
    if (seen.has(chunk.chunkId)) continue
    seen.add(chunk.chunkId)
    ordered.push(chunk)
  }

  return ordered
}

export function buildEvidenceWindows({
  part,
  chunks,
}: {
  part: string
  chunks: ChunkManifestChunk[]
}): EvidencePackDocument {
  const windows: EvidenceWindow[] = []
  const size = Math.max(1, appConfig.exhaustiveWindowSizeChunks)
  const overlap = Math.max(0, Math.min(appConfig.exhaustiveWindowOverlapChunks, size - 1))
  const step = Math.max(1, size - overlap)

  for (let start = 0; start < chunks.length; start += step) {
    const primary = chunks.slice(start, start + size)
    if (primary.length === 0) continue

    const overlapContext = overlap > 0 ? chunks.slice(start + size, start + size + overlap) : []
    const evidenceChunks = uniqueByChunkId([...primary, ...overlapContext])

    const evidence: EvidenceChunk[] = []
    let totalChars = 0

    for (const chunk of evidenceChunks) {
      const text = clipText(chunk.text, appConfig.groundingMaxCharsPerChunk)
      if (!text) continue
      if (evidence.length > 0 && totalChars + text.length > appConfig.groundingMaxTotalEvidenceChars) {
        break
      }

      evidence.push({
        citationId: `C${evidence.length + 1}`,
        sourceChunkId: chunk.chunkId,
        text,
        role: primary.some((item) => item.chunkId === chunk.chunkId) ? 'primary' : 'overlap_context',
        source: `Parte ${part} / ${chunk.chunkId}`,
        score: 1,
        overlapDetected: chunk.overlapDetected,
        speakerCountHint: chunk.speakerCountHint,
        transcriptionConfidence: chunk.transcriptionConfidence,
        overlapRiskScore: chunk.overlapRiskScore,
        overlapSignals: chunk.overlapSignals,
      })
      totalChars += text.length
    }

    windows.push(summarizeWindowSpeakerAwareness({
      windowId: `W${windows.length + 1}`,
      part,
      chunkRange: {
        from: primary[0].chunkId,
        to: primary[primary.length - 1].chunkId,
      },
      evidence,
    }))

    if (start + size >= chunks.length) {
      break
    }
  }

  return {
    part,
    windows,
  }
}

export function renderEvidenceWindowMarkdown(window: EvidenceWindow): string {
  const lines: string[] = ['EVIDENCIA DISPONIBLE', `Ventana: ${window.windowId}`]

  if (window.speakerCountHint && window.speakerCountHint > 1) {
    lines.push(`Speaker count hint: ${window.speakerCountHint}`)
  }
  if (window.overlapDetected) {
    lines.push(`Advertencia de solapamiento: sí (${window.overlapChunkCount ?? 0} chunks con riesgo)`)
    lines.push('Tratamiento editorial: si hay frases ambiguas por cruce de voces, priorizá tesis/objeciones explícitas y evitá inferencias fuertes.')
  } else if (window.transcriptionConfidence === 'normal') {
    lines.push('Advertencia de solapamiento: no detectada')
  }
  lines.push('')

  for (const item of window.evidence) {
    lines.push(`[${item.citationId}]`)
    if (item.source) {
      lines.push(`Fuente: ${item.source}`)
    }
    lines.push(`Rol: ${item.role}`)
    if (item.speakerCountHint && item.speakerCountHint > 1) {
      lines.push(`Speaker count hint: ${item.speakerCountHint}`)
    }
    if (item.overlapDetected) {
      lines.push(`Overlap detected: sí`)
      lines.push(`Transcription confidence: ${item.transcriptionConfidence ?? 'lower'}`)
      if (item.overlapSignals && item.overlapSignals.length > 0) {
        lines.push(`Overlap signals: ${item.overlapSignals.join(', ')}`)
      }
    } else if (item.transcriptionConfidence) {
      lines.push(`Transcription confidence: ${item.transcriptionConfidence}`)
    }
    lines.push('Texto:')
    lines.push(item.text)
    lines.push('')
  }

  const allowed = window.evidence.map((item) => `[${item.citationId}]`).join(', ')
  lines.push('REGLA:')
  lines.push(`Solo podés citar ${allowed}.`)
  lines.push('Priorizá el contenido de los chunks con rol primary. Usá overlap_context solo para continuidad y evitar cortes artificiales.')

  return `${lines.join('\n').trim()}\n`
}
