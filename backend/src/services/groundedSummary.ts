import type { GroundedWindowExtraction, NoteBlock } from './groundingTypes.js'
import {
  parseJsonObjectRobust,
  type RobustParseStrategy,
} from './windowOutputParserService.js'

export type RobustParseResult<T> =
  | { ok: true; value: T; strategy: RobustParseStrategy; repairedJsonText?: string }
  | { ok: false; error: string; rawPreview: string }

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean)
  }

  if (typeof value === 'string' && value.trim()) {
    return [value.trim()]
  }

  return []
}

function normalizeSection(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function normalizeCoverageType(value: unknown): NoteBlock['coverageType'] {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  switch (normalized) {
    case 'definition':
    case 'explanation':
    case 'example':
    case 'argument':
    case 'sequence':
      return normalized
    default:
      return 'detail'
  }
}

function normalizeGroundedWindowExtraction(parsed: Record<string, unknown>, windowId: string): GroundedWindowExtraction {
  const noteBlocks: NoteBlock[] = Array.isArray(parsed.noteBlocks)
    ? parsed.noteBlocks.reduce<NoteBlock[]>((acc, item) => {
        const value = item as Record<string, unknown>
        const heading = typeof value.heading === 'string' ? value.heading.trim() : ''
        const content = typeof value.content === 'string' ? value.content.trim() : ''
        if (!heading || !content) return acc

        acc.push({
          heading,
          content,
          citations: normalizeStringArray(value.citations),
          coverageType: normalizeCoverageType(value.coverageType),
        })
        return acc
      }, [])
    : []

  const insufficientEvidenceClaims = Array.isArray(parsed.insufficientEvidenceClaims)
    ? parsed.insufficientEvidenceClaims.reduce<Array<{ claim: string; section?: string }>>((acc, item) => {
        const value = item as Record<string, unknown>
        const claim = typeof value.claim === 'string' ? value.claim.trim() : ''
        if (!claim) return acc

        acc.push({
          claim,
          section: normalizeSection(value.section),
        })
        return acc
      }, [])
    : []

  return {
    windowId,
    noteBlocks,
    insufficientEvidenceClaims,
  }
}

export function parseGroundedWindowExtraction(raw: string, windowId: string): RobustParseResult<GroundedWindowExtraction> {
  const parsed = parseJsonObjectRobust(raw)
  if (!parsed.ok) {
    return {
      ok: false,
      error: `Ollama devolvió JSON inválido para ${windowId}: ${parsed.error}`,
      rawPreview: parsed.rawPreview,
    }
  }

  return {
    ok: true,
    value: normalizeGroundedWindowExtraction(parsed.value, windowId),
    strategy: parsed.strategy,
    repairedJsonText: parsed.repairedJsonText,
  }
}

function dedupePreserveOrder<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>()
  const ordered: T[] = []

  for (const item of items) {
    const key = keyOf(item).trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    ordered.push(item)
  }

  return ordered
}

export function renderGroundedExtractionsMarkdown({
  partNumber,
  title,
  windows,
}: {
  partNumber: number
  title: string
  windows: GroundedWindowExtraction[]
}): string {
  const noteBlocks = dedupePreserveOrder(
    windows.flatMap((window) => window.noteBlocks),
    (block) => `${block.heading}::${block.content}`,
  )
  const insufficient = dedupePreserveOrder(
    windows.flatMap((window) => window.insufficientEvidenceClaims),
    (claim) => `${claim.section ?? 'general'}::${claim.claim}`,
  )

  const lines: string[] = []
  lines.push(`## Parte ${String(partNumber).padStart(3, '0')}`)
  lines.push('')
  lines.push('## Título probable')
  lines.push(`- ${title}`)
  lines.push('')
  lines.push('## Contenido explicado')

  let currentHeading: string | null = null
  for (const block of noteBlocks) {
    if (currentHeading !== block.heading) {
      currentHeading = block.heading
      lines.push(`### ${block.heading}`)
    }
    lines.push(`- ${block.content} [${block.citations.join(', ')}]`)
  }

  if (insufficient.length > 0) {
    lines.push('')
    lines.push('## Evidencia insuficiente')
    for (const claim of insufficient) {
      if (claim.section) {
        lines.push(`### ${claim.section}`)
      }
      lines.push(`- ${claim.claim}`)
    }
  }

  return `${lines.join('\n').trim()}\n`
}
