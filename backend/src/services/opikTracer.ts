import { Opik } from 'opik'
import type { Span, Trace } from 'opik'

export const opik = new Opik({
  apiUrl: 'http://localhost:5173/api',
  apiKey: 'noop',
  projectName: 'video-summary',
  workspaceName: 'default',
})

let _activeTrace: Trace | null = null
let _activeParentSpan: Span | null = null

export function setActiveTrace(trace: Trace | null): void {
  _activeTrace = trace
}

export function getActiveTrace(): Trace | null {
  return _activeTrace
}

export function setActiveParentSpan(span: Span | null): void {
  _activeParentSpan = span
}

export function getActiveParentSpan(): Span | null {
  return _activeParentSpan
}
