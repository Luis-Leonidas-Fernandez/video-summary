# Runtime de IA: cuándo se levanta y cuándo se apaga

Este documento resume **en qué momento** y **bajo qué circunstancias** se levanta la IA del proyecto, usando la implementación actual basada en:

- `/Users/luis/Desktop/video-summary/backend/src/services/aiRuntimeManager.ts`
- `/Users/luis/Desktop/video-summary/backend/src/services/aiJobRuntime.ts`
- `/Users/luis/Desktop/video-summary/backend/src/services/jobQueue.ts`
- `/Users/luis/Desktop/video-summary/backend/src/services/ollamaClient.ts`
- `/Users/luis/Desktop/video-summary/backend/src/services/groundingService.ts`
- `/Users/luis/Desktop/video-summary/backend/src/services/modelSelectionService.ts`
- `/Users/luis/Desktop/video-summary/backend/src/routes/modelSelection.routes.ts`
- `/Users/luis/Desktop/video-summary/backend/src/services/videoProcessor.ts`
- `/Users/luis/Desktop/video-summary/backend/src/services/opikTracer.ts`

La idea central sigue siendo la misma:

- Ollama **no se levanta al boot**
- el runtime se activa **solo** cuando un job con `generateSummary=true` lo necesita
- el modelo LLM principal activo puede cambiarse desde la UI, pero **solo aplica a jobs futuros**
- al terminar los jobs IA, primero se intenta **descargar el modelo** para liberar RAM y recién después queda `idle`

## 1. Flujo principal

```mermaid
flowchart TD
    A["npm run dev"] --> B["Frontend + Backend arriba"]
    B --> C{"¿Hay job que use IA?"}
    C -- "No" --> D["Ollama sigue OFFLINE"]
    C -- "Sí" --> E["aiJobRuntime.runWithAiRuntime()"]
    E --> F["AiRuntimeManager.beginJob()"]
    F --> G["cancelIdleShutdown()"]
    G --> H["ensureReady()"]
    H --> I{"¿Ollama ya responde?"}
    I -- "Sí" --> J["No levanta nada nuevo"]
    I -- "No" --> K["spawn: ollama serve"]
    K --> L["estado = starting"]
    L --> M["espera hasta /api/tags OK"]
    M --> N["estado = ready"]
    J --> O["activeJobsCount += 1"]
    N --> O
    O --> P["estado = busy + markActivity()"]
    P --> Q["pipeline real: extracción / grounding / recovery"]
    Q --> R["requests a Ollama + worker Python + spans Opik"]
```

## 2. Cuándo NO se levanta

```mermaid
flowchart TD
    A["Abrís la app"] --> B["GET /api/health"]
    B --> C["Solo informa estado"]
    C --> D["NO levanta Ollama"]

    E["Job solo transcripción"] --> F["jobRequiresAi = false"]
    F --> G["NO beginJob()"]
    G --> H["NO se levanta IA"]
```

## 3. Cuándo SÍ se levanta

```mermaid
flowchart TD
    A["Job con generateSummary = true"] --> B["jobRequiresAi = true"]
    B --> C["beginJob()"]
    C --> D["ensureReady()"]
    D --> E{"¿Ollama ya estaba corriendo?"}
    E -- "Sí" --> F["Usa runtime existente"]
    E -- "No" --> G["Levanta ollama serve on-demand"]
    F --> H["estado = busy"]
    G --> H

    H --> I["studyExtraction / full notes"]
    H --> J["studyGroundingPipeline / groundingService"]
    H --> K["windowRecovery / thin reasoning / semantic enrichment"]
    H --> L["ollamaClient + worker grounding + traces Opik"]
```

## 4. Estados del runtime

```mermaid
stateDiagram-v2
    [*] --> offline
    offline --> starting: primer job IA
    starting --> ready: Ollama responde OK
    ready --> busy: beginJob()
    busy --> busy: markActivity()
    busy --> idle: activeJobsCount = 0
    idle --> busy: entra otro job antes del timeout
    idle --> stopping: vence idleShutdownMs
    stopping --> offline: stopIfOwned()
    busy --> error: runtime cae durante job
    ready --> offline: shutdown externo
```

## 5. Cambio global del modelo activo

```mermaid
flowchart TD
    A["UI cambia modelo"] --> B["POST /api/model-selection"]
    B --> C{"¿Hay jobs IA activos?"}
    C -- "Sí" --> D["409: cambio bloqueado"]
    C -- "No" --> E["modelSelectionService.setActiveModel()"]
    E --> F["persistencia en .runtime/model-selection.json"]
    F --> G{"¿runtime ownedByCurrentSession?"}
    G -- "Sí" --> H["intenta unload del modelo previo"]
    G -- "No" --> I["skip unload agresivo"]
    H --> J["el próximo job usará el nuevo modelo"]
    I --> J
```

Reglas reales actuales:

- la selección es **global**
- afecta **solo jobs futuros**
- el modelo se congela al inicio de cada job en `job.modelMetadata`
- si el modelo persistido desaparece de Ollama, el backend intenta fallback al `OLLAMA_MODEL` del `.env`

## 6. Regla de apagado e unload

```mermaid
flowchart TD
    A["endJob()"] --> B["activeJobsCount -= 1"]
    B --> C{"activeJobsCount === 0?"}
    C -- "No" --> D["Sigue busy"]
    C -- "Sí" --> E["intenta unloadModel()"]
    E --> F["estado = idle"]
    F --> G["scheduleIdleShutdown()"]
    G --> H{"¿ownedByCurrentSession?"}
    H -- "No" --> I["NO programa apagado"]
    H -- "Sí" --> J["Programa nextShutdownAt"]
    J --> K{"¿entra otro job antes del timeout?"}
    K -- "Sí" --> L["cancelIdleShutdown()"]
    L --> M["estado = busy"]
    K -- "No" --> N["stopIfOwned()"]
    N --> O["estado = offline"]
```

Punto fino importante:

- **unload del modelo** y **apagado del servidor Ollama** no son la misma cosa
- primero se intenta liberar RAM descargando el modelo
- el apagado completo del runtime queda como respaldo cuando el idle timeout vence y la sesión es dueña del proceso

## 7. Cancelación de jobs

```mermaid
flowchart TD
    A["POST /api/jobs/:id/cancel"] --> B{"¿job pending?"}
    B -- "Sí" --> C["sale de la cola y pasa a cancelled"]
    B -- "No" --> D{"¿job actual en ejecución?"}
    D -- "No" --> E["si ya terminó, no hace nada extra"]
    D -- "Sí" --> F["status = cancelling"]
    F --> G["AbortController.abort()"]
    G --> H["aiRuntimeManager.forceStopAll()"]
    H --> I["aborta requests activos"]
    I --> J["unload/stop runtime si corresponde"]
    J --> K["job termina como cancelled"]
```

La cancelación actual es **cooperativa**:

- aborta requests HTTP activos a Ollama
- intenta descargar el modelo y/o apagar el runtime según ownership
- no convierte la cola local en distribuida ni paralela; sigue siendo un executor secuencial

## 8. Regla especial de `Ctrl + C`

```mermaid
flowchart TD
    A["Ctrl + C"] --> B["Baja frontend/backend"]
    B --> C["cleanupRuntime()"]
    C --> D["mata grounding workers"]
    D --> E{"¿Ollama fue levantado por esta sesión?"}
    E -- "Sí" --> F["lo apaga"]
    E -- "No" --> G["lo deja vivo"]
```

## 9. Observabilidad con Opik

El lifecycle del runtime hoy convive con observabilidad explícita:

- `backend/src/index.ts` configura variables base de Opik
- `backend/src/services/opikTracer.ts` crea el cliente
- `backend/src/services/videoProcessor.ts` abre el trace raíz `video.pipeline`
- `backend/src/services/ollamaClient.ts` cuelga spans LLM del trace activo

O sea:

- el runtime define **cuándo** hay IA viva
- Opik te deja ver **qué hizo** esa IA durante download / transcribe / summarize / recovery

## Resumen ejecutivo

- La IA **no se levanta al boot** del proyecto.
- La IA se levanta **solo** cuando arranca un job que requiere resumen/grounding.
- El modelo LLM principal puede cambiarse desde la UI, pero el cambio se persiste y **solo aplica a jobs futuros**.
- Mientras haya jobs IA activos, el runtime queda en `busy`.
- Cuando terminan todos los jobs IA, primero se intenta **unload del modelo** y recién después el runtime pasa a `idle`.
- Si el runtime fue levantado por esta sesión y no entra otro job antes del timeout, se apaga solo para liberar memoria.
- Si cancelás un job en ejecución, el sistema aborta requests activos y fuerza stop/unload del runtime cuando corresponde.
