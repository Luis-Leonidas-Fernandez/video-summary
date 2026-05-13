import { generateGroundedWindowExtraction } from './groundedWindowGenerator.js'
import type { EvidencePackDocument, GroundedWindowExtraction } from './groundingTypes.js'

export async function generateGroundedSummary({
  evidencePack,
}: {
  evidencePack: EvidencePackDocument
}): Promise<GroundedWindowExtraction> {
  const firstWindow = evidencePack.windows[0]
  if (!firstWindow) {
    return {
      windowId: 'W0',
      noteBlocks: [],
      insufficientEvidenceClaims: [],
    }
  }

  return generateGroundedWindowExtraction({ window: firstWindow })
}
