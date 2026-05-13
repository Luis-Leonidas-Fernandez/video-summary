import type { GroundedWindowExtraction, NoteBlock } from './groundingTypes.js'
import { renderGroundedExtractionsMarkdown } from './groundedSummary.js'

function dedupeNoteBlocks(windows: GroundedWindowExtraction[]): GroundedWindowExtraction[] {
  const seen = new Set<string>()

  return windows.map((window) => ({
    ...window,
    noteBlocks: window.noteBlocks.filter((block) => {
      const key = `${block.heading}::${block.content}`.trim().toLowerCase()
      if (!key || seen.has(key)) {
        return false
      }
      seen.add(key)
      return true
    }),
  }))
}

function inferTitle(partNumber: number, windows: GroundedWindowExtraction[]): string {
  const firstBlock = windows.flatMap((window) => window.noteBlocks)[0]
  if (firstBlock?.heading) {
    return `${firstBlock.heading} — Parte ${String(partNumber).padStart(3, '0')}`
  }

  return `Parte ${String(partNumber).padStart(3, '0')}`
}

export function consolidateWindowExtractions({
  partNumber,
  windows,
}: {
  partNumber: number
  windows: GroundedWindowExtraction[]
}): { title: string; extraction: string; noteBlocks: NoteBlock[] } {
  const ordered = dedupeNoteBlocks(windows)
  const title = inferTitle(partNumber, ordered)
  const extraction = renderGroundedExtractionsMarkdown({
    partNumber,
    title,
    windows: ordered,
  })

  return {
    title,
    extraction,
    noteBlocks: ordered.flatMap((window) => window.noteBlocks),
  }
}

export function generateShortSummaryFromExtraction({
  title,
  noteBlocks,
}: {
  title: string
  noteBlocks: NoteBlock[]
}): string {
  const lines: string[] = ['## Resumen breve', `- ${title}`, '']

  for (const block of noteBlocks.slice(0, 4)) {
    lines.push(`- ${block.heading}: ${block.content}`)
  }

  return `${lines.join('\n').trim()}\n`
}
