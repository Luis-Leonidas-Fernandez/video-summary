import type { EvidenceChunk, GroundedWindowExtraction, NoteBlock } from './groundingTypes.js'

export interface StudyClaim {
  id: string
  part: string
  section: string
  text: string
  citations: string[]
}

export interface StudyClaimsDocument {
  part: string
  evidence: EvidenceChunk[]
  claims: StudyClaim[]
}

function blockToClaimText(block: NoteBlock): string {
  return `${block.heading}: ${block.content}`.trim()
}

export function extractClaimsFromWindowExtractions({
  partNumber,
  windows,
  evidence,
}: {
  partNumber: number
  windows: GroundedWindowExtraction[]
  evidence: Array<EvidenceChunk & { windowId?: string }>
}): StudyClaimsDocument {
  const part = String(partNumber).padStart(3, '0')
  const claims: StudyClaim[] = []
  let claimCounter = 0

  for (const window of windows) {
    for (const block of window.noteBlocks) {
      claimCounter += 1
      claims.push({
        id: `part_${part}_claim_${String(claimCounter).padStart(3, '0')}`,
        part,
        section: block.heading.trim() || 'General',
        text: blockToClaimText(block),
        citations: block.citations.map((citation) => `${window.windowId}:${citation}`),
      })
    }
  }

  return {
    part,
    evidence: evidence.map((item) => ({
      ...item,
      citationId: item.windowId ? `${item.windowId}:${item.citationId}` : item.citationId,
    })),
    claims,
  }
}
