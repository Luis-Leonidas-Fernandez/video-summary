import { z } from 'zod'
import type { GroundedWindowExtraction, NoteBlock } from './groundingTypes.js'
import { parseJsonObjectRobust, type RobustParseStrategy } from './windowOutputParserService.js'

export const WindowDraftExtractionSchema = z.object({
  items: z.array(z.object({
    title: z.string().trim().min(3),
    text: z.string().trim().min(30),
    citations: z.array(z.string().trim().min(1)).min(1),
  })).min(1),
  insufficientEvidence: z.array(z.object({
    claim: z.string().trim().min(3),
    reason: z.string().trim().optional(),
  })).default([]),
})

export type WindowDraftExtraction = z.infer<typeof WindowDraftExtractionSchema>

export type DraftParseResult<T> =
  | { ok: true; value: T; strategy: RobustParseStrategy; repairedJsonText?: string }
  | { ok: false; error: string; rawPreview: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sanitizeDraftCitations(value: unknown): string[] | null {
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value
  }

  if (
    isRecord(value)
    && Array.isArray(value.items)
    && value.items.every((item) => typeof item === 'string')
  ) {
    return value.items
  }

  return null
}

function sanitizeWindowDraftPayload(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return value
  }

  const sanitizedItems = value.items.flatMap((item) => {
    if (!isRecord(item) || typeof item.title !== 'string' || typeof item.text !== 'string') {
      return []
    }

    const citations = sanitizeDraftCitations(item.citations)
    if (!citations) {
      return []
    }

    return [{
      ...item,
      citations,
    }]
  })

  return {
    ...value,
    items: sanitizedItems,
  }
}

function inferCoverageType(title: string, text: string): NoteBlock['coverageType'] {
  const normalized = `${title} ${text}`.toLowerCase()

  if (/\bejemplo|por ejemplo|caso\b/.test(normalized)) {
    return 'example'
  }
  if (/\bdefin|se entiende por|consiste en\b/.test(normalized)) {
    return 'definition'
  }
  if (/\bobjeci[oó]n|argument|raz[oó]n|defiende|critica\b/.test(normalized)) {
    return 'argument'
  }
  if (/\bpaso\b|\bproceso\b|\bsecuencia\b|\bprimero\b|\bluego\b|\bdespu[eé]s\b/.test(normalized)) {
    return 'sequence'
  }

  return 'explanation'
}

function buildWindowDraftExtractionSchema(allowedCitationIds: string[]) {
  const uniqueCitationIds = Array.from(new Set(allowedCitationIds.map((item) => item.trim()).filter(Boolean)))
  const citationSchema = uniqueCitationIds.length > 0
    ? z.enum(uniqueCitationIds as [string, ...string[]])
    : z.string().trim().min(1)

  return z.object({
    items: z.array(z.object({
      title: z.string().trim().min(3),
      text: z.string().trim().min(30),
      citations: z.array(citationSchema).min(1),
    })).min(1),
    insufficientEvidence: z.array(z.object({
      claim: z.string().trim().min(3),
      reason: z.string().trim().optional(),
    })).default([]),
  })
}

export function parseWindowDraftExtraction(raw: string, windowId: string, allowedCitationIds: string[] = []): DraftParseResult<WindowDraftExtraction> {
  const parsed = parseJsonObjectRobust(raw)
  if (!parsed.ok) {
    return {
      ok: false,
      error: `Ollama devolvió JSON inválido para ${windowId}: ${parsed.error}`,
      rawPreview: parsed.rawPreview,
    }
  }

  const sanitizedPayload = sanitizeWindowDraftPayload(parsed.value)
  const validated = buildWindowDraftExtractionSchema(allowedCitationIds).safeParse(sanitizedPayload)
  if (!validated.success) {
    return {
      ok: false,
      error: `Ollama devolvió un schema draft inválido para ${windowId}: ${validated.error.issues.map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`).join('; ')}`,
      rawPreview: raw.slice(0, 800),
    }
  }

  return {
    ok: true,
    value: validated.data,
    strategy: parsed.strategy,
    repairedJsonText: parsed.repairedJsonText,
  }
}

export function normalizeDraftToGroundedExtraction({
  draft,
  windowId,
}: {
  draft: WindowDraftExtraction
  windowId: string
}): GroundedWindowExtraction {
  return {
    windowId,
    noteBlocks: draft.items.map((item) => ({
      heading: item.title.trim(),
      content: item.text.trim(),
      citations: item.citations.map((citation) => citation.trim()).filter(Boolean),
      coverageType: inferCoverageType(item.title, item.text),
    })),
    insufficientEvidenceClaims: draft.insufficientEvidence.map((item) => ({
      claim: item.claim.trim(),
      section: item.reason?.trim() || undefined,
    })),
  }
}
