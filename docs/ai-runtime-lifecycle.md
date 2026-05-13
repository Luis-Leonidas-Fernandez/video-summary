# Runtime de IA: cuándo se levanta y cuándo se apaga

Este documento resume **en qué momento** y **bajo qué circunstancias** se levanta la IA del proyecto, usando la implementación actual basada en:

- `/Users/luis/Desktop/video-summary/backend/src/services/aiRuntimeManager.ts`
- `/Users/luis/Desktop/video-summary/backend/src/services/aiJobRuntime.ts`
- `/Users/luis/Desktop/video-summary/backend/src/services/ollamaClient.ts`
- `/Users/luis/Desktop/video-summary/backend/src/services/groundingService.ts`

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
    O --> P["estado = busy"]
    P --> Q["requests a Ollama / grounding"]
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

    H --> I["generateSpanishSummary()"]
    H --> J["repairSpanishSummary()"]
    H --> K["generateGroundingReport()"]
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

## 5. Regla de apagado

```mermaid
flowchart TD
    A["endJob()"] --> B["activeJobsCount -= 1"]
    B --> C{"activeJobsCount === 0?"}
    C -- "No" --> D["Sigue busy"]
    C -- "Sí" --> E["estado = idle"]
    E --> F["scheduleIdleShutdown()"]
    F --> G{"¿ownedByCurrentSession?"}
    G -- "No" --> H["NO programa apagado"]
    G -- "Sí" --> I["Programa nextShutdownAt"]
    I --> J{"¿entra otro job antes del timeout?"}
    J -- "Sí" --> K["cancelIdleShutdown()"]
    K --> L["estado = busy"]
    J -- "No" --> M["stopIfOwned()"]
    M --> N["estado = offline"]
```

## 6. Regla especial de `Ctrl + C`

```mermaid
flowchart TD
    A["Ctrl + C"] --> B["Baja frontend/backend"]
    B --> C["cleanupRuntime()"]
    C --> D["mata grounding workers"]
    D --> E{"¿Ollama fue levantado por esta sesión?"}
    E -- "Sí" --> F["lo apaga"]
    E -- "No" --> G["lo deja vivo"]
```

## Resumen ejecutivo

- La IA **no se levanta al boot** del proyecto.
- La IA se levanta **solo** cuando arranca un job que requiere resumen/grounding.
- Mientras haya jobs IA activos, el runtime queda en `busy`.
- Cuando terminan todos los jobs IA, el runtime pasa a `idle`.
- Si el runtime fue levantado por esta sesión y no entra otro job antes del timeout, se apaga solo para liberar memoria.
