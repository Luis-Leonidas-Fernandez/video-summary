import { appConfig } from '../config.js'
import type { CoverageMetrics, EvidenceWindow, GroundedWindowExtraction } from './groundingTypes.js'

function countWords(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length
}

export function buildCoverageMetrics({
  transcript,
  extraction,
  windows,
  groundedWindows,
  allChunkIds,
}: {
  transcript: string
  extraction: string
  windows: EvidenceWindow[]
  groundedWindows: GroundedWindowExtraction[]
  allChunkIds: string[]
}): CoverageMetrics {
  const transcriptWords = countWords(transcript)
  const extractionWords = countWords(extraction)
  const chunkIdsInWindows = new Set(windows.flatMap((window) => window.evidence.map((item) => item.sourceChunkId)))
  const chunkIdsWithClaims = new Set(
    groundedWindows.flatMap((window) =>
      window.noteBlocks.flatMap((block) =>
        block.citations.map((citation) => {
          const evidence = windows
            .find((item) => item.windowId === window.windowId)
            ?.evidence.find((item) => item.citationId === citation)
          return evidence?.sourceChunkId ?? ''
        }),
      ),
    ).filter(Boolean),
  )

  const totalChunksInPart = allChunkIds.length
  const chunkCoverageRatio = totalChunksInPart === 0 ? 0 : Number((chunkIdsWithClaims.size / totalChunksInPart).toFixed(3))

  return {
    transcriptWords,
    extractionWords,
    extractionToTranscriptRatio: transcriptWords === 0 ? 0 : Number((extractionWords / transcriptWords).toFixed(3)),
    totalChunksInPart,
    chunksIncludedInWindows: chunkIdsInWindows.size,
    chunkCoverageRatio,
    chunksWithNoClaims: allChunkIds.filter((chunkId) => !chunkIdsWithClaims.has(chunkId)),
  }
}

export function isTooCompressed(coverage: CoverageMetrics): boolean {
  return coverage.extractionToTranscriptRatio < appConfig.minExhaustiveWordRatio || coverage.chunkCoverageRatio < appConfig.minExhaustiveChunkCoverageRatio
}
