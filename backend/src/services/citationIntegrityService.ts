import type { CitationIntegrityIssueClaim, CitationIntegrityReport, GroundedWindowExtraction } from './groundingTypes.js'

const VALID_CITATION_ID = /^C\d+$/

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b))
}

export function validateCitationIntegrity({
  extraction,
  allowedCitationIds,
}: {
  extraction: GroundedWindowExtraction
  allowedCitationIds: Set<string>
}): CitationIntegrityReport {
  const invalidCitationIds: string[] = []
  const malformedCitations: string[] = []
  const claimsWithoutCitation: CitationIntegrityIssueClaim[] = []

  for (const block of extraction.noteBlocks) {
    if (block.citations.length === 0) {
      claimsWithoutCitation.push({
        claimText: block.content,
        section: block.heading,
      })
      continue
    }

    for (const citation of block.citations) {
      if (!VALID_CITATION_ID.test(citation)) {
        malformedCitations.push(citation)
        continue
      }

      if (!allowedCitationIds.has(citation)) {
        invalidCitationIds.push(citation)
      }
    }
  }

  return {
    ok: invalidCitationIds.length === 0 && malformedCitations.length === 0 && claimsWithoutCitation.length === 0,
    invalidCitationIds: uniqueSorted(invalidCitationIds),
    malformedCitations: uniqueSorted(malformedCitations),
    claimsWithoutCitation,
  }
}
