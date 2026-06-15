# Migración Ollama → oMLX
## Plan de migración incremental — M4 Pro 24GB

> **Corrección crítica v2**: el plan anterior confundía oMLX con `mlx_lm.server`. Son proyectos distintos. Este plan es exclusivamente sobre oMLX (https://github.com/jundot/omlx).

---

## Los 4 backends — distinción clara

| Backend | Quién lo hace | API | SSD KV Cache | Estado |
|---------|--------------|-----|--------------|--------|
| **Ollama** | Ollama Inc | Propia (`/api/chat`) | No | Producción, estable |
| **mlx_lm.server** | Apple MLX team | OpenAI-compatible | No | Estable, básico |
| **oMLX** | jundot (github.com/jundot/omlx) | OpenAI + Anthropic compatible | **Sí — paged SSD KV** | Experimental, nuevo |
| **llama.cpp / llama-server** | ggerganov | OpenAI-compatible | Sí (disk cache) | Maduro, GGUF |

**El diferencial de oMLX** es el paged SSD KV caching: mantiene una capa caliente en RAM y una capa fría en SSD. Los bloques de KV cache se persisten en disco y se restauran cuando aparece un prefijo ya procesado, eliminando el recompute de prefill para contextos repetidos.

> **Nota de riesgo**: oMLX es experimental. No es el reemplazo definitivo de Ollama — es una evaluación. El rollback siempre debe ser inmediato con `LLM_BACKEND=ollama`.

---

## Seam de migración

```
ollamaClient.ts → runOllamaChat() → bloque fetch HTTP
```

El seam es el bloque de fetch HTTP crudo dentro de `runOllamaChat()`, NO `completeOllamaResponse()`.

`completeOllamaResponse()` maneja continuations, `isOutputComplete`, `isJsonOutputComplete`, Opik spans, timeout, y editorial fallback. Toda esa lógica **se queda donde está**. Lo único que sale es la llamada HTTP raw, que se delega al provider activo.

```
completeOllamaResponse()          ← no se toca
  └─ runOllamaChat()              ← no se toca (orquesta continuations, span, timeout)
       └─ rawLLMCall()            ← ÚNICO punto que cambia → delega a OllamaAdapter o OmlxProvider
            messages + params → HTTP → text
```

El provider solo hace esto: `messages + params → HTTP → text`. Nada más.

---

## Arquitectura objetivo

```
┌─────────────────────────────────────────────────────────────────┐
│                      Node.js Backend                            │
│                                                                  │
│  JobQueue → videoProcessor → [N agentes] → completeResponse()  │
│                                                  │               │
│                            ┌─────────────────────▼───────────┐  │
│                            │         LLMClient interface       │  │
│                            │  complete(req): Promise<LLMRes>   │  │
│                            │  health(): Promise<bool>          │  │
│                            │  provider: string                 │  │
│                            └──┬──────────────┬────────────────┘  │
│                               │              │                    │
│               ┌───────────────▼──┐  ┌────────▼──────────────┐   │
│               │ OllamaAdapter    │  │ OpenAICompatibleClient │   │
│               │ (existente)      │  │ (genérico, nuevo)      │   │
│               └───────────────┬──┘  └────────┬──────────────┘   │
│                               │              │                    │
│                               │     ┌────────▼──────────────┐   │
│                               │     │ OmlxProvider           │   │
│                               │     │ config concreta de     │   │
│                               │     │ OpenAICompatibleClient │   │
│                               │     └────────┬──────────────┘   │
└───────────────────────────────│──────────────│───────────────────┘
                    HTTP/11434  │              │  HTTP/8000
               ┌────────────────▼──┐  ┌───────▼──────────────────┐
               │   Ollama serve    │  │     oMLX server           │
               │   (existente)     │  │   (ya corriendo,          │
               └───────────────────┘  │    gestionado fuera       │
                                      │    de Node.js)            │
                                      └──────────────────────────┘
                                               │
                                    ┌──────────▼──────────────┐
                                    │  MLX + Apple Silicon GPU │
                                    │  RAM layer (hot KV)      │
                                    │  SSD layer (cold KV)     │
                                    └─────────────────────────┘
```

**Decisión de diseño clave**: Node.js NO levanta el proceso oMLX. oMLX corre como servidor externo gestionado fuera del lifecycle de Node.js. El backend solo se conecta por HTTP.

---

## Variables de entorno

```bash
# .env — agregar
LLM_BACKEND=omlx              # 'ollama' | 'omlx'

OMLX_BASE_URL=http://127.0.0.1:8000/v1
OMLX_MODEL=<modelo MLX compatible, ej: mlx-community/Qwen3-14B-4bit>
OMLX_API_KEY=                 # opcional / vacío para uso local
```

---

## Estado de las fases

| Fase | Tipo | Estado | Prerrequisito |
|------|------|--------|---------------|
| [0 — Benchmark oMLX](#fase-0--benchmark-omlx) | Quick Win | ⬜ Pendiente | ninguno |
| [1 — LLMClient interface](#fase-1--llmclient-interface) | Refactor | ⬜ Pendiente | Fase 0 |
| [2 — OpenAICompatibleClient genérico](#fase-2--openaicompatibleclient-genérico) | Mediana | ⬜ Pendiente | Fase 1 |
| [3 — OmlxProvider](#fase-3--omlxprovider) | Mediana | ⬜ Pendiente | Fase 2 |
| [4 — Observabilidad](#fase-4--observabilidad) | Quick Win | ⬜ Pendiente | Fase 3 |
| [5 — Context Manager](#fase-5--context-manager) | Mediana | ⬜ Pendiente | Fase 3 |
| [6 — Prefix optimization para SSD KV](#fase-6--prefix-optimization-para-ssd-kv) | Mediana | ⬜ Pendiente | Fase 4 |
| [7 — Hybrid Model Routing](#fase-7--hybrid-model-routing) | Avanzada | ⬜ Pendiente | Fase 4 |
| [8 — OpenTelemetry layer](#fase-8--opentelemetry-layer) | Experimental | ⬜ Pendiente | Fase 4 |

---

## Fase 0 — Benchmark oMLX

**Objetivo**: verificar que oMLX funciona en el hardware específico y que el SSD KV cache opera como se espera. No se toca código de producción.

**Duración estimada**: 0.5–1 día

### Paso previo obligatorio — leer la CLI real

> **No se hardcodean flags hasta leer la documentación real del binario.**
> Correr estos comandos y documentar los flags exactos antes de continuar.

```bash
# 1. Instalar oMLX según https://github.com/jundot/omlx y https://omlx.ai

# 2. Leer la CLI real y documentar los flags:
omlx --help
omlx serve --help

# Registrar en este documento:
# - Flag real para levantar el servidor (¿`serve`? ¿`start`? ¿otro?)
# - Flag real para el modelo
# - Puerto/base URL por defecto
# - Flag real para directorio de SSD KV cache
# - Flag real para tamaño del hot cache en RAM
# - Flag para desactivar SSD KV cache (si existe)
# - Cualquier flag de configuración de concurrencia o context window
```

**Completar esta tabla antes de continuar con Fase 1:**

| Parámetro | Flag real | Valor por defecto | Notas |
|-----------|-----------|-------------------|-------|
| Subcomando para levantar servidor | ❓ | ❓ | ej: `serve`, `start`, `run` |
| Modelo | ❓ | ❓ | |
| Puerto | ❓ | ❓ | |
| Base URL del endpoint | ❓ | ❓ | ej: `/v1`, `/api/v1` |
| Directorio SSD KV cache | ❓ | ❓ | |
| Tamaño hot cache RAM | ❓ | ❓ | |
| Desactivar SSD KV | ❓ | ❓ | |
| Context window / max tokens | ❓ | ❓ | |
| API key requerida en local | ❓ | ❓ | |

### Verificaciones manuales (después de documentar los flags reales)

```bash
# Ajustar los comandos según los flags reales documentados arriba

# 1. Health / models disponibles — verificar el endpoint real:
curl http://localhost:<PORT>/v1/models   # o el path que corresponda

# 2. Completions básico:
curl http://localhost:<PORT>/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<MODELO>",
    "messages": [{"role":"user","content":"Respondé en JSON: {\"ok\":true}"}],
    "max_tokens": 50,
    "temperature": 0
  }'

# 3. Verificar SSD KV cache:
#    - Enviar la misma request dos veces
#    - El TTFT del segundo request debe ser notablemente menor
#    - Los logs de oMLX deben mostrar cache hit o similar
```

### Métricas a capturar

| Métrica | Cómo | Target |
|---------|------|--------|
| TTFT primer request | Timer en la request | baseline |
| TTFT segundo request (mismo prefijo) | Timer en la request | < 50% del primero |
| Archivos SSD KV generados | `ls -lh` en el dir de cache de oMLX | Deben aparecer |
| JSON Schema output | Mismo schema que en prod | Debe ser idéntico a Ollama |
| Swap durante inferencia | `vm_stat` | Debe ser 0 |

### Criterio de avance

- [ ] oMLX responde en `/v1/chat/completions` correctamente
- [ ] El SSD KV cache genera archivos en disco y reduce TTFT en requests repetidos
- [ ] JSON output con schema es structuralmente correcto
- [ ] No hay swap en operación normal con Qwen3 14B

### Rollback

No hay nada que rollbackear — el código de producción no cambió.

---

## Fase 1 — LLMClient interface

**Objetivo**: crear la abstracción que permite cambiar de backend con una variable de entorno. Cero cambio de comportamiento observable.

**Duración estimada**: 1–2 días

### Archivos a crear

```
backend/src/services/
├── llmClient.ts              ← interface pública + tipos compartidos
├── llmClientResolver.ts      ← decide qué implementación usar según LLM_BACKEND
└── ollamaClientAdapter.ts    ← wrappea el código existente sin duplicar lógica
```

### llmClient.ts — contrato público

```typescript
// backend/src/services/llmClient.ts

import type { JsonSchemaObject } from './outputSchemas.js'

export interface LLMRequest {
  system: string
  prompt: string
  priorAssistantContent?: string
  responseFormat?: 'text' | 'json' | JsonSchemaObject
  numCtx?: number
  numPredict?: number
  temperature?: number
  debugLabel?: string
  iteration?: number
}

export interface LLMResponse {
  text: string
  promptTokens?: number
  completionTokens?: number
  finishReason?: 'stop' | 'length' | 'error'
  durationMs?: number
}

export interface LLMClient {
  complete(req: LLMRequest): Promise<LLMResponse>
  health(): Promise<boolean>
  readonly provider: string
}
```

### llmClientResolver.ts

```typescript
// backend/src/services/llmClientResolver.ts

import type { LLMClient } from './llmClient.js'

let _client: LLMClient | null = null

export async function resolveActiveLLMClient(): Promise<LLMClient> {
  const backend = process.env.LLM_BACKEND ?? 'ollama'

  // Reset del cache si cambió el backend (útil en tests)
  if (_client && _client.provider !== backend) {
    _client = null
  }

  if (!_client) {
    _client = await buildClient(backend)
  }
  return _client
}

async function buildClient(backend: string): Promise<LLMClient> {
  switch (backend) {
    case 'omlx': {
      const { OmlxProvider } = await import('./omlxProvider.js')
      return new OmlxProvider()
    }
    case 'ollama':
    default: {
      const { OllamaClientAdapter } = await import('./ollamaClientAdapter.js')
      return new OllamaClientAdapter()
    }
  }
}
```

### Cambio quirúrgico en ollamaClient.ts

Extraer el bloque `try/fetch/catch` de `runOllamaChat()` a una función `rawLLMCall()` privada. Luego reemplazar ese bloque por una llamada al provider activo. **Todo lo demás no se toca**: continuations, `isOutputComplete`, `isJsonOutputComplete`, el Opik span, el timeout, el `AbortController`.

```typescript
// En ollamaClient.ts — extraer solo el fetch HTTP a rawLLMCall():

async function rawLLMCall(req: LLMRequest): Promise<LLMResponse> {
  const client = await resolveActiveLLMClient()
  return client.complete(req)
}

// En runOllamaChat() — reemplazar únicamente el bloque try/fetch/catch por:
const response = await rawLLMCall({
  system,
  prompt,
  priorAssistantContent,
  responseFormat,
  numCtx: profile?.numCtx,
  numPredict: profile?.numPredict,
  debugLabel,
  iteration,
})
const text = response.text
// ... el resto del código (logging, Opik span update, etc.) sigue igual
```

`LLMClient.complete()` en el provider solo hace: `messages + params → HTTP → text`. No maneja continuations, no repara JSON, no tiene Opik span propio.

### Criterio de avance

- [ ] Un job completo corre con `LLM_BACKEND=ollama` y produce el mismo output que antes
- [ ] `OllamaClientAdapter` wrappea sin duplicar lógica
- [ ] `OmlxProvider` aún no existe, pero el resolver lo importa dinámicamente → no rompe nada

### Rollback

Eliminar los 3 archivos nuevos y revertir el cambio quirúrgico en `ollamaClient.ts`. 15 minutos.

---

## Fase 2 — OpenAICompatibleClient genérico

**Objetivo**: implementar un cliente HTTP que habla con cualquier endpoint OpenAI-compatible. Es la base que usa `OmlxProvider` y podría usarse con mlx_lm.server, llama-server, o cualquier otro backend compatible.

**Duración estimada**: 1–2 días

### Por qué genérico y no directo a oMLX

oMLX es experimental. Si mañana aparece una alternativa mejor (mlx_lm.server con SSD cache, llama.cpp, etc.), el cambio es solo una nueva config que apunta al nuevo URL — no hay que reescribir el cliente.

```
backend/src/services/
└── openAICompatibleClient.ts   ← implementación HTTP genérica
```

### openAICompatibleClient.ts

```typescript
// backend/src/services/openAICompatibleClient.ts

import type { LLMClient, LLMRequest, LLMResponse } from './llmClient.js'
import type { JsonSchemaObject } from './outputSchemas.js'
import { appConfig } from '../config.js'

interface OpenAICompatibleConfig {
  baseUrl: string        // ej: 'http://127.0.0.1:8000/v1'
  model: string
  apiKey?: string
  providerName: string   // para logs y spans
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface OpenAIChatRequest {
  model: string
  messages: OpenAIMessage[]
  max_tokens: number
  temperature: number
  stream: boolean
  top_p?: number
  repetition_penalty?: number
  response_format?: { type: string; json_schema?: unknown }
}

interface OpenAIChatResponse {
  choices: Array<{
    message: { content: string }
    finish_reason: 'stop' | 'length' | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    // oMLX puede agregar campos extendidos:
    prompt_eval_duration_ms?: number
    eval_duration_ms?: number
  }
}

const CONTINUATION_PROMPT = [
  'Continuá exactamente desde donde te cortaste.',
  'No repitas nada de lo que ya escribiste.',
  'No agregues prefacios ni explicaciones.',
  'Empezá directamente con la palabra donde te detuviste.',
].join('\n')

function buildMessages(req: LLMRequest): OpenAIMessage[] {
  if (req.priorAssistantContent) {
    return [
      { role: 'system', content: req.system },
      { role: 'user', content: 'Continuá la tarea anterior respetando exactamente el mismo contrato de salida.' },
      { role: 'assistant', content: req.priorAssistantContent },
      { role: 'user', content: CONTINUATION_PROMPT },
    ]
  }
  return [
    { role: 'system', content: req.system },
    { role: 'user', content: req.prompt },
  ]
}

function buildResponseFormat(
  fmt?: 'text' | 'json' | JsonSchemaObject,
): OpenAIChatRequest['response_format'] | undefined {
  if (!fmt || fmt === 'text') return undefined

  // Primera integración: siempre json_object, sin json_schema.
  // json_schema puede no estar soportado o comportarse diferente en oMLX.
  // La validación de estructura la hace Zod en el llamador + jsonContractRepairService como fallback.
  // Activar json_schema solo después de verificar soporte real en Fase 0.
  if (fmt === 'json' || typeof fmt === 'object') return { type: 'json_object' }

  return undefined
}

export class OpenAICompatibleClient implements LLMClient {
  readonly provider: string

  constructor(private readonly config: OpenAICompatibleConfig) {
    this.provider = config.providerName
  }

  async health(): Promise<boolean> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2_000)
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (this.config.apiKey) headers['Authorization'] = `Bearer ${this.config.apiKey}`

      const res = await fetch(`${this.config.baseUrl}/models`, {
        headers,
        signal: controller.signal,
      })
      return res.ok
    } catch {
      return false
    } finally {
      clearTimeout(timeout)
    }
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const started = Date.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), appConfig.ollamaTimeoutMs)

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.config.apiKey) headers['Authorization'] = `Bearer ${this.config.apiKey}`

    const body: OpenAIChatRequest = {
      model: this.config.model,
      messages: buildMessages(req),
      max_tokens: req.numPredict ?? 1500,
      temperature: req.temperature ?? (req.responseFormat === 'text' ? 0.1 : 0),
      stream: false,
      top_p: 0.9,
      repetition_penalty: 1.05,
      response_format: buildResponseFormat(req.responseFormat),
    }

    try {
      const res = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!res.ok) {
        const err = await res.text().catch(() => `HTTP ${res.status}`)
        throw new Error(`[${this.provider}] Error en completions: ${err}`)
      }

      const data = (await res.json()) as OpenAIChatResponse
      const text = data.choices[0]?.message?.content?.trim() ?? ''
      if (!text) throw new Error(`[${this.provider}] No devolvió contenido.`)

      return {
        text,
        promptTokens: data.usage?.prompt_tokens,
        completionTokens: data.usage?.completion_tokens,
        finishReason: data.choices[0]?.finish_reason ?? 'stop',
        durationMs: Date.now() - started,
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`[${this.provider}] Timeout durante la generación.`)
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }
}
```

### Criterio de avance

- [ ] `OpenAICompatibleClient` puede hablar con cualquier endpoint `/v1/chat/completions`
- [ ] Los errores incluyen el nombre del provider para facilitar el debugging
- [ ] La lógica de construcción de mensajes (incluyendo continuations) es idéntica a la de `ollamaClient.ts`

---

## Fase 3 — OmlxProvider

**Objetivo**: configuración concreta de `OpenAICompatibleClient` apuntando a oMLX. Es solo config — no hay lógica nueva.

**Duración estimada**: 0.5 días

### Archivo a crear

```
backend/src/services/
└── omlxProvider.ts    ← config concreta de OpenAICompatibleClient para oMLX
```

### omlxProvider.ts

```typescript
// backend/src/services/omlxProvider.ts

import { OpenAICompatibleClient } from './openAICompatibleClient.js'

export class OmlxProvider extends OpenAICompatibleClient {
  constructor() {
    const baseUrl = process.env.OMLX_BASE_URL ?? 'http://127.0.0.1:8000/v1'
    const model = process.env.OMLX_MODEL
    if (!model) throw new Error('OMLX_MODEL no está definido en el entorno.')

    super({
      baseUrl,
      model,
      apiKey: process.env.OMLX_API_KEY || undefined,
      providerName: 'omlx',
    })
  }
}
```

### Variables de entorno requeridas

```bash
# .env
LLM_BACKEND=omlx
OMLX_BASE_URL=http://127.0.0.1:8000/v1
OMLX_MODEL=mlx-community/Qwen3-14B-4bit
OMLX_API_KEY=                              # dejar vacío para uso local
```

### Criterio de avance

- [ ] Un job completo corre con `LLM_BACKEND=omlx` contra oMLX corriendo localmente
- [ ] El output JSON de todos los stages es structuralmente correcto (`json_object` mode + Zod + repair)
- [ ] `json_schema` estricto NO se activa todavía — queda para después de verificar soporte real en Fase 0
- [ ] El SSD KV cache de oMLX reduce el TTFT en la segunda ventana del mismo job
- [ ] `LLM_BACKEND=ollama` vuelve al comportamiento anterior sin tocar código

### Rollback inmediato

```bash
# En .env — un cambio, un deploy, listo:
LLM_BACKEND=ollama
```

---

## Fase 4 — Observabilidad

**Objetivo**: medir qué está pasando con oMLX antes de confiar en él en producción.

**Duración estimada**: 1–2 días

### Archivos a crear/modificar

```
backend/src/services/
├── llmCallMetrics.ts         ← extracción de métricas del response (genérico)
└── memoryPressureMonitor.ts  ← detección de swap
```

### llmCallMetrics.ts

```typescript
// backend/src/services/llmCallMetrics.ts

export interface LLMCallMetrics {
  provider: string
  model: string
  promptTokens: number
  completionTokens: number
  totalDurationMs: number
  prefillDurationMs?: number
  generationDurationMs?: number
  tokensPerSecond?: number
  prefillTokensPerSecond?: number
  finishReason: string
  // Tokens que vinieron del KV cache (estándar OpenAI en releases recientes):
  cachedTokens?: number
  cacheHit: boolean
  // Campo experimental de oMLX — puede no existir:
  kvCacheSource?: 'ram' | 'ssd' | 'miss'
}

export function extractLLMMetrics(
  data: {
    choices: Array<{ finish_reason: string | null }>
    usage?: Record<string, unknown>
  },
  durationMs: number,
  provider: string,
  model: string,
): LLMCallMetrics {
  const usage = data.usage ?? {}
  const promptTokens = (usage['prompt_tokens'] as number) ?? 0
  const completionTokens = (usage['completion_tokens'] as number) ?? 0
  const prefillMs = usage['prompt_eval_duration_ms'] as number | undefined
  const genMs = usage['eval_duration_ms'] as number | undefined

  // Tokens cacheados — intentar las dos variantes conocidas del campo:
  // prompt_tokens_details.cached_tokens es el estándar OpenAI más probable en oMLX
  // cached_tokens en el root de usage es la variante alternativa
  const cachedTokens =
    (usage['prompt_tokens_details'] as Record<string, unknown> | undefined)?.['cached_tokens'] as number | undefined
    ?? (usage['cached_tokens'] as number | undefined)

  const cacheHit = typeof cachedTokens === 'number' && cachedTokens > 0

  // Campo experimental de oMLX — puede no existir según la versión:
  const kvCacheSource = usage['kv_cache_source'] as 'ram' | 'ssd' | 'miss' | undefined

  return {
    provider,
    model,
    promptTokens,
    completionTokens,
    totalDurationMs: durationMs,
    prefillDurationMs: prefillMs,
    generationDurationMs: genMs,
    tokensPerSecond: genMs && completionTokens ? (completionTokens / genMs) * 1000 : undefined,
    prefillTokensPerSecond: prefillMs && promptTokens ? (promptTokens / prefillMs) * 1000 : undefined,
    finishReason: data.choices[0]?.finish_reason ?? 'unknown',
    cachedTokens,
    cacheHit,
    kvCacheSource,
  }
}
```

### memoryPressureMonitor.ts

```typescript
// backend/src/services/memoryPressureMonitor.ts

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export type PressureLevel = 'ok' | 'warning' | 'critical'

export interface MemoryPressure {
  swapUsedMB: number
  pressureLevel: PressureLevel
}

export async function checkMemoryPressure(): Promise<MemoryPressure> {
  const { stdout } = await exec('vm_stat')
  const lines = stdout.split('\n')
  const pageSize = 16_384  // bytes — Apple Silicon

  const get = (key: string): number => {
    const line = lines.find((l) => l.includes(key))
    const m = line?.match(/(\d+)/)
    return m ? parseInt(m[1]) * pageSize : 0
  }

  const swapUsedMB = Math.max(0, (get('Pages swapped out') - get('Pages swapped in')) / (1024 * 1024))

  return {
    swapUsedMB,
    pressureLevel: swapUsedMB > 2048 ? 'critical' : swapUsedMB > 512 ? 'warning' : 'ok',
  }
}
```

### Integración de métricas en OpenAICompatibleClient

Modificar `complete()` para emitir al Opik tracer existente después de cada request exitosa:

```typescript
// En openAICompatibleClient.ts — al final de complete(), antes del return:
import { extractLLMMetrics } from './llmCallMetrics.js'
import { getActiveTrace } from './opikTracer.js'

const metrics = extractLLMMetrics(data, durationMs, this.provider, this.config.model)

const llmSpan = getActiveTrace()?.span({
  name: `${this.provider}.completion`,
  type: 'llm',
  model: this.config.model,
  provider: this.provider,
  input: { system: req.system, prompt: req.prompt },
})
llmSpan?.update({
  output: { text },
  metadata: {
    ...metrics,
    // El kv_cache_source es la métrica más importante para evaluar oMLX:
    kvCacheSource: metrics.kvCacheSource,
    kvCacheHit: metrics.kvCacheHit,
  },
})
llmSpan?.end()
```

### Criterio de avance

- [ ] Cada request a oMLX aparece en Opik con tokens, latencia y provider='omlx'
- [ ] `prefillDurationMs` y `generationDurationMs` están separados
- [ ] Si oMLX expone `kv_cache_source`, aparece en los spans
- [ ] `checkMemoryPressure()` se llama antes de cada request y loguea si hay warning

---

## Fase 5 — Context Manager

**Objetivo**: formalizar los límites de contexto. Crítico para oMLX porque el SSD KV cache SOLO beneficia si el contexto entra completo en la ventana — no sirve si el prompt se trunca.

**Duración estimada**: 1–2 días

### contextManager.ts

```typescript
// backend/src/services/contextManager.ts

export const CONTEXT_LIMITS = {
  'qwen3-14b': {
    maxContextTokens: 8192,
    maxOutputTokens: 1500,
    safeInputTokens: 6592,
    chunkSize: 2000,
    chunkOverlap: 200,
  },
  'gemma-4e4b': {
    maxContextTokens: 16384,
    maxOutputTokens: 2000,
    safeInputTokens: 14284,
    chunkSize: 4000,
    chunkOverlap: 400,
  },
} as const

export type ModelKey = keyof typeof CONTEXT_LIMITS

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function assertContextBudget(inputText: string, model: ModelKey, label: string): void {
  const estimated = estimateTokens(inputText)
  const limit = CONTEXT_LIMITS[model].safeInputTokens
  if (estimated > limit * 0.95) {
    throw new Error(
      `[${label}] Input estimado (${estimated} tokens) supera el límite seguro (${limit}) para ${model}.`,
    )
  }
}

export function chunkText(text: string, model: ModelKey): string[] {
  const { chunkSize, chunkOverlap } = CONTEXT_LIMITS[model]
  const chunkChars = chunkSize * 4
  const overlapChars = chunkOverlap * 4
  const chunks: string[] = []
  let start = 0

  while (start < text.length) {
    const end = Math.min(start + chunkChars, text.length)
    chunks.push(text.slice(start, end))
    if (end === text.length) break
    start = end - overlapChars
  }
  return chunks
}
```

### Criterio de avance

- [ ] Los guards detectan prompts que exceden el límite antes de que lleguen a oMLX
- [ ] El pipeline no crashea con transcripciones de 2h+
- [ ] Los límites en `CONTEXT_LIMITS` coinciden con los valores actuales de `appConfig`

---

## Fase 6 — Prefix optimization para SSD KV

**Objetivo**: maximizar el beneficio del SSD KV cache de oMLX reorganizando los prompts del pipeline para compartir el máximo prefijo posible entre requests sucesivas.

**Duración estimada**: 1–2 días

**Por qué esto importa con oMLX**: el SSD KV cache de oMLX detecta prefijos repetidos y restaura los bloques desde disco. Si los system prompts varían aunque sea en un espacio o un salto de línea, el cache miss es total. Normalización y prefijo compartido son críticos.

### Principio

```
SIN prefix optimization (cache miss en cada request):
  Agente A: "Sos un extractor de claims académicos.\n\nTu tarea es..."
  Agente B: "Sos un asistente de análisis.\n\nValidá los claims..."
  → Dos prefills completos, 0% de KV cache reutilizado

CON prefix optimization (cache hit en el prefijo compartido):
  Agente A: "[BASE PREFIX]\n\nTu tarea específica: extraer claims."
  Agente B: "[BASE PREFIX]\n\nTu tarea específica: validar claims."
  → BASE PREFIX cacheado en SSD → solo se computa el sufijo variable
```

### sharedPromptPrefix.ts

```typescript
// backend/src/services/sharedPromptPrefix.ts

// IMPORTANTE: este string debe ser IDÉNTICO en todos los agentes que quieran
// compartir KV cache. Cualquier diferencia (incluyendo whitespace) rompe el hit.
export const SHARED_SYSTEM_PREFIX = [
  'Sos un asistente de análisis de contenido académico.',
  'Procesás transcripciones de videos científicos en español.',
  'Respondés siempre con JSON válido según el schema provisto.',
  'No agregues explicaciones fuera del JSON. No inventes información.',
].join('\n')

// Normalizar para garantizar que el prefijo es bit-a-bit idéntico:
export function buildSystemPrompt(taskInstruction: string): string {
  const normalized = taskInstruction.replace(/\s+/g, ' ').trim()
  return `${SHARED_SYSTEM_PREFIX}\n\n${normalized}`
}
```

### Criterio de avance

- [ ] Los logs/spans de oMLX muestran `kv_cache_source: 'ssd'` en requests subsiguientes del mismo job
- [ ] El TTFT de la segunda ventana de un job es measurablemente menor que la primera
- [ ] Todos los agentes principales del pipeline usan `buildSystemPrompt()` para construir su system

---

## Fase 7 — Hybrid Model Routing

**Objetivo**: usar un modelo pequeño (4B) para tasks simples, el modelo principal solo para tasks complejas.

**Duración estimada**: 2–3 días

**Prerrequisito**: Fase 4 con métricas activas para medir el impacto.

> **Nota**: antes de implementar esto, verificar que oMLX soporta múltiples modelos simultáneos o si requiere dos instancias separadas. Consultar documentación de https://omlx.ai.

### Budget de memoria con dos modelos (M4 Pro 24GB)

```
Qwen3 14B 4bit:    8.5 GB
Gemma 4 E4B 4bit:  2.5 GB
KV caches:         0.7 GB
Activations pico:  2.0 GB
macOS + Node:      5.0 GB
────────────────────────
TOTAL:            18.7 GB  ← dentro de los 24 GB
BUFFER:            5.3 GB
```

### modelRouter.ts

```typescript
// backend/src/services/modelRouter.ts

const TASK_PROFILES: Record<string, { useMainModel: boolean }> = {
  'claim-extraction':    { useMainModel: false },  // tarea simple → modelo chico
  'study-validation':    { useMainModel: false },
  'json-repair':         { useMainModel: false },
  'citation-repair':     { useMainModel: false },
  'grounding-check':     { useMainModel: false },
  'semantic-critique':   { useMainModel: true  },  // requiere razonamiento → 14B
  'controlled-rewrite':  { useMainModel: true  },
  'editorial-synthesis': { useMainModel: true  },
}

export function routeTask(taskName: string): 'main' | 'fast' {
  return TASK_PROFILES[taskName]?.useMainModel ?? true ? 'main' : 'fast'
}
```

### Criterio de avance

- [ ] oMLX soporta el modelo dual o se levantan dos instancias sin conflictos
- [ ] El budget de memoria se verifica con `checkMemoryPressure()` antes de cargar el segundo modelo
- [ ] La latencia total del job baja measurablemente en los spans de Opik

---

## Fase 8 — OpenTelemetry layer

**Objetivo**: base técnica para observabilidad completa del pipeline de agentes.

**Duración estimada**: 3–5 días

**Prerrequisito**: Fase 4 estable.

### Qué agrega sobre el Opik tracer existente

```
HOY: un span por llamada LLM

OBJETIVO: árbol de spans por job

job (root span)
├── transcription
├── extraction
│   ├── window.W1
│   │   ├── omlx.completion (prefill: 120ms, gen: 800ms, kv: ssd)
│   │   └── omlx.completion (prefill: 15ms ← KV hit!, gen: 400ms)
│   └── window.W2
│       └── omlx.completion
├── grounding
└── artifacts
```

El `kvCacheSource` en cada span permite calcular la tasa real de SSD KV hits en producción — la métrica más importante para justificar oMLX sobre Ollama.

### Criterio de avance

- [ ] Un job completo produce un trace navegable con el DAG de agentes
- [ ] La tasa de `kv_cache_source: 'ssd'` es visible y crece con el prefix optimization de Fase 6
- [ ] Se puede comparar latencia Ollama vs oMLX en jobs históricos

---

## Referencia técnica

### Distinción de backends (no confundir)

```
Ollama        → /api/chat            → propio formato → NO SSD KV cache
mlx_lm.server → /v1/chat/completions → OpenAI compat  → NO SSD KV cache
oMLX          → /v1/chat/completions → OpenAI compat  → SÍ SSD KV cache (paged)
llama.cpp     → /v1/chat/completions → OpenAI compat  → SÍ disk cache (--cache-type-k disk)
```

### Mapping de parámetros Ollama → OpenAI (oMLX)

| Ollama | OpenAI (oMLX) | Notas |
|--------|--------------|-------|
| `options.temperature` | `temperature` | Idéntico |
| `options.top_p` | `top_p` | Idéntico |
| `options.repeat_penalty` | `repetition_penalty` | Idéntico |
| `options.num_predict` | `max_tokens` | Idéntico |
| `options.num_ctx` | Config del servidor oMLX | **No es por request** |
| `format: "json"` | `response_format: {type:"json_object"}` | Sin schema |
| `format: <JsonSchema>` | `response_format: {type:"json_schema",...}` | Verificar soporte en oMLX |
| `keep_alive` | No aplica | oMLX gestiona lifecycle propio |

### Por qué Node.js NO levanta el proceso oMLX

A diferencia del `aiRuntimeManager.ts` actual que levanta `ollama serve`, oMLX corre como un servidor externo independiente. Razones:

1. oMLX tiene su propio lifecycle de carga de modelo y gestión de SSD cache — no es idempotente levantarlo como proceso hijo
2. oMLX es experimental — si crashea, querés saberlo explícitamente, no que Node.js intente reiniciarlo en loop
3. Separación de concerns: el usuario decide cuándo corre oMLX y con qué configuración de SSD

El health check en `OmlxProvider.health()` detecta si oMLX está corriendo y reporta error claro si no lo está.

### Qué NO paralelizar

```
❌ Dos requests LLM simultáneos al mismo servidor oMLX
❌ Arrancar oMLX desde Node.js como proceso hijo
❌ Cargar dos modelos grandes sin verificar el budget de RAM

✅ Chunks de transcripción Whisper (CPU/ANE, no compite con GPU)
✅ Embedding generation (si existe en el pipeline)
✅ Post-processing de texto puro
```

### Rollback en cualquier momento

```bash
# .env — un cambio:
LLM_BACKEND=ollama

# El código de Ollama no fue modificado. Comportamiento idéntico al original.
```
