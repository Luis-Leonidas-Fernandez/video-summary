import { appConfig } from '../config.js'
import { jobLog } from '../utils/jobContext.js'
import { aiRuntimeManager } from './aiRuntimeManager.js'
import { getActiveTrace } from './opikTracer.js'
import type { JsonSchemaObject } from './outputSchemas.js'

interface OllamaChatResponse {
  message?: {
    content?: string
    thinking?: string
  }
  done_reason?: string
  eval_count?: number
  prompt_eval_count?: number
  error?: string
}

export interface OllamaGenerationProfile {
  numCtx: number
  numPredict: number
  keepAlive?: string
}

type OllamaResponseFormat = 'text' | 'json' | JsonSchemaObject

const CONTINUATION_PROMPT = [
  'Continuá exactamente desde donde te cortaste.',
  'No repitas nada de lo que ya escribiste.',
  'No agregues prefacios ni explicaciones.',
  'Empezá directamente con la palabra donde te detuviste.',
].join('\n')

function isOutputComplete(text: string): boolean {
  const lastLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? ''

  return /[.!?)}\]"”»`]$/.test(lastLine)
}

function extractBalancedJsonObject(raw: string): string | null {
  const start = raw.indexOf('{')
  if (start === -1) {
    return null
  }

  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index]

    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }

      if (char === '\\') {
        escaped = true
        continue
      }

      if (char === '"') {
        inString = false
      }

      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === '{') {
      depth += 1
      continue
    }

    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return raw.slice(start, index + 1).trim()
      }
    }
  }

  return null
}

function extractJsonCandidate(raw: string): string | null {
  const fencedStart = raw.match(/```(?:json)?\s*/i)
  if (fencedStart) {
    const afterFence = raw.slice(fencedStart.index! + fencedStart[0].length)
    const balancedInsideFence = extractBalancedJsonObject(afterFence)
    if (balancedInsideFence) {
      return balancedInsideFence
    }
  }

  return extractBalancedJsonObject(raw)
}

function isJsonOutputComplete(text: string): boolean {
  const candidate = extractJsonCandidate(text)
  if (!candidate) {
    return false
  }

  try {
    JSON.parse(candidate)
    return true
  } catch {
    return false
  }
}

function supportsThinkingToggle(model: string): boolean {
  return /qwen|deepseek|gpt-oss/i.test(model)
}

export async function completeOllamaResponse({
  system,
  prompt,
  maxContinuations = 1,
  profile,
  responseFormat = 'text',
  debugLabel,
}: {
  system: string
  prompt: string
  maxContinuations?: number
  profile?: OllamaGenerationProfile
  responseFormat?: OllamaResponseFormat
  debugLabel?: string
}): Promise<string> {
  let fullText = await runOllamaChat({ system, prompt, profile, responseFormat, debugLabel, iteration: 0 })

  for (let index = 0; index < maxContinuations; index += 1) {
    const outputIsComplete = responseFormat !== 'text'
      ? isJsonOutputComplete(fullText)
      : isOutputComplete(fullText)

    if (outputIsComplete) {
      break
    }

    const continuation = await runOllamaChat({
      system,
      prompt,
      priorAssistantContent: fullText,
      profile,
      responseFormat,
      debugLabel,
      iteration: index + 1,
    })
    const trimmedContinuation = continuation.trimStart()
    const separator = trimmedContinuation.startsWith('{') || trimmedContinuation.startsWith('[') ? '' : '\n'
    fullText = `${fullText.trimEnd()}${separator}${trimmedContinuation}`
  }

  return fullText.trim()
}

async function runOllamaChat({
  system,
  prompt,
  priorAssistantContent,
  profile,
  responseFormat,
  debugLabel,
  iteration,
}: {
  system: string
  prompt: string
  priorAssistantContent?: string
  profile?: OllamaGenerationProfile
  responseFormat?: OllamaResponseFormat
  debugLabel?: string
  iteration?: number
}): Promise<string> {
    await aiRuntimeManager.ensureReady()
    aiRuntimeManager.markActivity()

    const controller = aiRuntimeManager.createRequestController()
    const timeout = setTimeout(() => controller.abort(), appConfig.ollamaTimeoutMs)

    const messages: Array<{ role: string; content: string }> = priorAssistantContent
      ? [
          { role: 'system', content: system },
          { role: 'user', content: 'Continuá la tarea anterior respetando exactamente el mismo contrato de salida.' },
          { role: 'assistant', content: priorAssistantContent },
          { role: 'user', content: CONTINUATION_PROMPT },
        ]
      : [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ]

    const requestBody: Record<string, unknown> = {
      model: appConfig.ollamaModel,
      stream: false,
      keep_alive: profile?.keepAlive ?? appConfig.ollamaKeepAlive,
      messages,
      options: {
        temperature: responseFormat === 'text' ? 0.1 : 0,
        top_p: 0.9,
        repeat_penalty: 1.05,
        num_ctx: profile?.numCtx ?? appConfig.fullNotesOllamaNumCtx,
        num_predict: profile?.numPredict ?? appConfig.fullNotesOllamaNumPredict,
      },
    }

    if (responseFormat === 'json') {
      requestBody.format = 'json'
    } else if (responseFormat && responseFormat !== 'text') {
      requestBody.format = responseFormat
    }

    if (supportsThinkingToggle(appConfig.ollamaModel)) {
      requestBody.think = false
    }

    const activeTrace = getActiveTrace()
    const llmSpan = activeTrace?.span({
      name: 'ollama.completion',
      type: 'llm',
      model: appConfig.ollamaModel,
      provider: 'ollama',
      input: {
        system,
        prompt,
        responseFormat: typeof responseFormat === 'string' ? responseFormat : 'json_schema',
        numCtx: profile?.numCtx ?? appConfig.fullNotesOllamaNumCtx,
        numPredict: profile?.numPredict ?? appConfig.fullNotesOllamaNumPredict,
      },
    })

    let llmOutput: string | undefined
    let llmError: string | undefined
    try {
      const response = await fetch(`${appConfig.ollamaBaseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`Ollama respondió con HTTP ${response.status}.`)
      }

      const data = (await response.json()) as OllamaChatResponse
      if (data.error) {
        throw new Error(data.error)
      }

      const text = data.message?.content?.trim() ?? ''
      if (!text) {
        throw new Error('Ollama no devolvió contenido.')
      }

      if (debugLabel) {
        const numCtx = profile?.numCtx ?? appConfig.fullNotesOllamaNumCtx
        const numPredict = profile?.numPredict ?? appConfig.fullNotesOllamaNumPredict
        jobLog(`[ollama-debug:${debugLabel}] iter=${iteration ?? 0} done_reason=${data.done_reason ?? 'unknown'} prompt_tokens=${data.prompt_eval_count ?? 'n/a'} output_tokens=${data.eval_count ?? 'n/a'} num_ctx=${numCtx} num_predict=${numPredict} output_chars=${text.length}`)
      }

      llmOutput = text
      aiRuntimeManager.markActivity()
      return text
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        llmError = 'timeout'
        throw new Error('Ollama agotó el tiempo de espera durante la generación.')
      }
      llmError = error instanceof Error ? error.message : 'unknown'
      throw error
    } finally {
      if (llmOutput !== undefined) {
        llmSpan?.update({ output: { text: llmOutput } })
      } else if (llmError !== undefined) {
        llmSpan?.update({ output: { error: llmError } })
      }
      llmSpan?.end()
      clearTimeout(timeout)
      aiRuntimeManager.releaseRequestController(controller)
    }
}
