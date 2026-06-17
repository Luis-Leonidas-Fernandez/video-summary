# Video Study Tool

> Pipeline local para **descargar, transcribir, traducir, estudiar y validar videos** con artifacts auditables, grounding por claims y runtime IA controlado en tu Mac.

---

## Índice rápido

- [Qué resuelve](#qué-resuelve)
- [Capacidades principales](#capacidades-principales)
- [Flujo actual](#flujo-actual)
- [Stack](#stack)
- [Estructura del repo](#estructura-del-repo)
- [Instalación](#instalación)
- [Cómo correrlo](#cómo-correrlo)
- [Modo desktop (Electron)](#modo-desktop-electron)
- [API](#api)
- [Outputs y artifacts](#outputs-y-artifacts)
- [Decisiones técnicas](#decisiones-técnicas)
- [Archivos clave](#archivos-clave)
- [Limitaciones actuales](#limitaciones-actuales)
- [Próximos pasos](#próximos-pasos)

---

## Qué resuelve

Este proyecto toma videos de YouTube y produce una salida **estudiable, trazable y auditable**:

- transcripción local
- traducción final al español
- notas de estudio
- grounding por claims con citas
- artifacts de debugging y recuperación semántica

Acepta tres modos de entrada:

- **video único**
- **lista manual de URLs**
- **playlist de YouTube**

Todos los resultados quedan en `output/`.

---

## Capacidades principales

| Capacidad | Qué hace |
| --- | --- |
| **ASR local** | Descarga audio, limpia ruido y transcribe con `whisper.cpp` |
| **Salida final en español** | Reutiliza transcripción si ya está en español o traduce por chunks si no lo está |
| **Extracción de estudio** | Genera notas exhaustivas por parte y consolida `full_study_notes_es.txt` |
| **Grounding moderno** | Extrae claims con citas y valida soporte real contra chunks fuente |
| **Recovery semántico** | Repara ventanas flojas con contract repair, strict re-emit y thin reasoning chain |
| **Runtime IA on-demand** | Levanta Ollama solo cuando hace falta y libera RAM al terminar |
| **Selector global de modelo** | Permite elegir el LLM principal desde la UI para jobs futuros |
| **Soporte batch** | Procesa `urls[]` y playlists con job padre + items aislados |
| **Observabilidad** | Logs, reports, artifacts intermedios y trazas con Opik |

---

## Flujo actual

### Vista ejecutiva

1. elegís `url`, `urls` o `playlistUrl`
2. el backend crea `job_<timestamp>`
3. si es playlist, primero entra en `resolving_sources`
4. descarga y limpia audio
5. particiona el video y luego subchunkea para ASR
6. transcribe con `whisper.cpp`
7. decide si reutiliza español o traduce por chunks
8. genera extracción / notas con Ollama
9. construye claims, citas y evidence packs
10. valida grounding con LlamaIndex
11. si una ventana sale floja, intenta recuperación semántica
12. guarda reports, outputs finales y logs

### Pipeline detallado

1. `yt-dlp` descarga y extrae `audio.mp3`
2. `ffmpeg` genera `audio_denoised.wav` (mono, 16 kHz, con denoise)
3. `ffmpeg` parte el audio en bloques de 30 minutos
4. cada parte se divide en subchunks chicos para Whisper
5. `whisper.cpp` transcribe chunk por chunk con prompt + glosario
6. el backend consolida `transcription_part_XXX.txt` y luego `transcription.txt`
7. si el contenido no está en español, genera:
   - `translation_chunk_*`
   - `translation_part_*`
   - `translation_es.txt`
8. si el contenido ya está en español, reutiliza la transcripción y genera igual `translation_es.txt` como artifact estable
9. Ollama produce `extraction_part_XXX.txt` y consolida `full_study_notes_es.txt`
10. el pipeline arma `chunk_manifest.json`, claims estructurados y evidence packs con aliases `[C1]`, `[C2]`, etc.
11. un worker Python con LlamaIndex produce `grounding_report.json`
12. si una ventana sale comprimida, con schema roto o thin reasoning, entra recovery semántico
13. además se generan derivados de estudio:
   - `outline_es.txt`
   - `key_concepts_es.txt`
   - `questions_es.txt`
   - `glossary_es.txt`

### Qué cambia entre single y batch

| Modo | Comportamiento |
| --- | --- |
| **single URL** | trabaja sobre una sola carpeta de salida |
| **url_list** | crea un job padre y procesa `item_001`, `item_002`, etc. |
| **playlist** | primero resuelve fuentes con `yt-dlp --flat-playlist` |
| **batch** | procesa items en secuencia, no en paralelo |

---

## Stack

### Frontend

- React
- Vite
- TypeScript

### Backend

- Node.js
- Express
- TypeScript

### Persistencia

- archivos locales en `output/`

### Herramientas del sistema

- `yt-dlp`
- `ffmpeg`
- `ollama`
- `whisper.cpp` (`whisper-cli`)

### Worker de grounding

- Python
- LlamaIndex

---

## Estructura del repo

```text
video-summary/
  backend/
    grounding_worker/
      grounding_worker.py
      requirements.txt
    src/
      index.ts
      routes/
        jobs.routes.ts
        modelSelection.routes.ts
      services/
        aiRuntimeManager.ts
        jobQueue.ts
        modelSelectionService.ts
        ollamaClient.ts
        opikTracer.ts
        studyArtifacts.ts
        studyExtraction.ts
        studyGroundingPipeline.ts
        transcriptionPreprocessor.ts
        videoProcessor.ts
        videoPartitioner.ts
      utils/
        shell.ts
        files.ts
      types.ts
  frontend/
    src/
      App.tsx
      api.ts
      components/
        AiRuntimeBanner.tsx
        JobForm.tsx
        JobStatus.tsx
        FileList.tsx
        GroundingSummary.tsx
        JobResourceUsagePanel.tsx
        SummaryPreview.tsx
      main.tsx
      styles.css
  desktop/
    main.cjs
    preload.cjs
    splash.html
    dev.mjs
  output/
  scripts/
    dev.mjs
  README.md
```

---

## Instalación

### Resumen corto

Necesitás:

- `yt-dlp`
- `ffmpeg`
- `ollama`
- `whisper.cpp`
- Node.js / npm
- Python con virtualenv para el worker de grounding

### 1) Herramientas del sistema

```bash
brew install yt-dlp ffmpeg ollama
brew install whisper-cpp
bash /Users/luis/whisper.cpp/models/download-ggml-model.sh large-v3
cd /Users/luis/whisper.cpp
cmake -B build-nocoreml -DWHISPER_COREML=OFF
cmake --build build-nocoreml -j 8 --config Release
```

> El backend valida estas dependencias antes de procesar cada job.
> Si falta alguna, el job falla con un mensaje claro.

> En este proyecto conviene usar un build **sin CoreML** para `large-v3`, así evitás depender del encoder `.mlmodelc`.
> Si instalaste `whisper.cpp` en otra ruta, ajustá `WHISPER_CPP_BINARY` y `WHISPER_CPP_MODEL_PATH` en `backend/.env`.

### 2) Configuración de Ollama

El proyecto usa un **modelo LLM principal configurable**. El valor inicial sale de `backend/.env`.

Variables principales:

```env
PORT=3001
WHISPER_CPP_BINARY=/Users/luis/whisper.cpp/build-nocoreml/bin/whisper-cli
WHISPER_CPP_MODEL_PATH=/Users/luis/whisper.cpp/models/ggml-large-v3.bin
WHISPER_CPP_THREADS=10
VIDEO_PART_DURATION_SECONDS=1800
WHISPER_CHUNK_DURATION_SECONDS=90
WHISPER_CPP_GLOSSARY=Japan, Yusuke, Taro, Kenji, karoshi, futoko, ijime, juku, shukatsu, naitei, ronin, konbini, pachinko, onigiri, Aokigahara
WHISPER_DENOISE_FILTER=afftdn=nr=20:nf=-20:tn=1,highpass=f=120,lowpass=f=7000
OLLAMA_BASE_URL=http://127.0.0.1:11434
# Modelo default inicial. La UI puede persistir otro modelo activo en .runtime/model-selection.json.
OLLAMA_MODEL=gemma3:12b
OLLAMA_TIMEOUT_MS=300000
OLLAMA_NUM_PARALLEL=1
OLLAMA_MAX_LOADED_MODELS=1
OLLAMA_KEEP_ALIVE=2m
OLLAMA_IDLE_SHUTDOWN_MS=30000
FULL_NOTES_OLLAMA_NUM_PREDICT=700
FULL_NOTES_OLLAMA_NUM_CTX=8192
GROUNDING_OLLAMA_NUM_PREDICT=700
GROUNDING_OLLAMA_NUM_CTX=8192
GROUNDING_MODE=auto
GROUNDING_PYTHON_BIN=/Users/luis/Desktop/video-summary/backend/grounding_worker/.venv/bin/python3
GROUNDING_WORKER_PATH=/Users/luis/Desktop/video-summary/backend/grounding_worker/grounding_worker.py
GROUNDING_OLLAMA_EMBED_MODEL=embeddinggemma
GROUNDING_TOP_K=5
GROUNDING_MAX_CHARS_PER_CHUNK=1200
GROUNDING_MAX_TOTAL_EVIDENCE_CHARS=6000
GROUNDING_SUPPORTED_THRESHOLD=0.8
GROUNDING_WEAK_THRESHOLD=0.6
MAX_JSON_CONTRACT_REPAIR_ATTEMPTS=1
MAX_STRICT_REEMIT_ATTEMPTS=1
GENERATION_SCHEMA_MODE=simple_draft
ENABLE_TWO_STEP_RECOVERY_FOR_GENERATION=true
MAX_TWO_STEP_RECOVERY_ATTEMPTS=1
ENABLE_SEMANTIC_ENRICHMENT=false
MAX_SEMANTIC_ENRICHMENT_ATTEMPTS=1
ENABLE_CHAIN_SEMANTIC_ENRICHMENT=true
MAX_CHAIN_SEMANTIC_ENRICHMENT_ATTEMPTS=1
ENABLE_THIN_REASONING_CHAIN=true
ENABLE_CLOSURE_SANITIZER=true
FALLBACK_MODE=editorial
```

Si querés levantar Ollama manualmente:

```bash
ollama serve
```

### Selector global de modelo

En la UI, dentro del panel **Runtime de IA**, podés:

- listar modelos locales detectados desde `Ollama /api/tags`
- cambiar el **LLM principal** para jobs futuros
- persistir la selección en `.runtime/model-selection.json`
- mantener separados Whisper y embeddings
- bloquear el cambio si hay jobs IA activos

Si el modelo persistido desaparece, el backend intenta volver al `OLLAMA_MODEL` del `.env` y expone una advertencia.

### 2.1) Observabilidad con Opik

El backend está instrumentado con **Opik** para trazas del pipeline y llamadas al modelo.

Puntos clave:

- configuración inicial en `backend/src/index.ts`
- cliente en `backend/src/services/opikTracer.ts`
- trace raíz del pipeline en `backend/src/services/videoProcessor.ts`
- spans LLM enlazados desde `backend/src/services/ollamaClient.ts`

Eso te deja inspeccionar:

- descarga
- transcripción
- resumen / extracción
- llamadas LLM asociadas al trace activo

> Opik es observabilidad. No cambia la lógica del pipeline.

### 3) Dependencias del backend

```bash
cd /ruta/a/video-summary/backend
npm install
```

### 4) Dependencias Python para grounding

```bash
cd /ruta/a/video-summary/backend/grounding_worker
/opt/homebrew/bin/python3 -m venv .venv
./.venv/bin/python3 -m pip install -r requirements.txt
```

> El worker debe correr dentro de su propio virtualenv.
> Con el Python del sistema (`/usr/bin/python3`, 3.9) LlamaIndex moderno puede romper por incompatibilidades.
> Si faltan dependencias, el job sigue con fallback legacy **solo si** `GROUNDING_MODE=auto`.
> Si usás `GROUNDING_MODE=required`, el grounding pasa a ser obligatorio.

### 5) Dependencias del frontend

```bash
cd /ruta/a/video-summary/frontend
npm install
```

### 6) Instalación rápida del workspace

```bash
cd /ruta/a/video-summary
npm run install:all
```

---

## Cómo correrlo

### Opción recomendada

```bash
cd /ruta/a/video-summary
npm run dev
```

Ese comando:

- levanta backend + frontend
- deja Ollama apagado hasta que un job IA lo necesite
- guarda estado runtime para limpiar procesos colgados después
- al hacer `Ctrl + C`, ejecuta la misma limpieza que `npm run cleanup`

- Backend: [http://localhost:3001](http://localhost:3001)
- Frontend: [http://localhost:3000](http://localhost:3000)

El frontend también renderiza `full_study_notes_es.txt` con una presentación legible además de permitir abrir o descargar el archivo.

### Runtime IA durante un job

Cuando iniciás un job con IA:

- el backend levanta Ollama on-demand
- usa el modelo LLM activo configurado en la UI (o el default del `.env` si nunca cambiaste la selección)
- separa contexto de `full notes` y grounding
- intenta reparar JSON y ventanas flojas antes de degradar
- si no quedan jobs activos, el runtime entra en `idle`
- al terminar un job IA, fuerza unload del modelo para liberar RAM
- tras `OLLAMA_IDLE_SHUTDOWN_MS`, apaga el runtime como respaldo si la sesión es dueña del proceso

### Limpieza de procesos

```bash
cd /ruta/a/video-summary
npm run cleanup
```

Eso:

- mata workers de grounding del proyecto
- mata backends locales escuchando en `3001` y `3002`
- apaga Ollama **solo si** esta sesión de `npm run dev` lo había levantado automáticamente

Si querés forzar también el apagado de Ollama aunque no haya sido levantado por `npm run dev`:

```bash
npm run cleanup:all
```

**Tradeoff**

- `cleanup`: más seguro si usás Ollama para otras cosas
- `cleanup:all`: libera más memoria, pero te baja todo el runtime local de Ollama

### Comandos individuales

```bash
cd /ruta/a/video-summary
npm run dev:backend
npm run dev:frontend
```

---

## Modo desktop (Electron)

La shell desktop existe para abstraer la terminal en el uso diario. En este primer corte:

- arranca **Electron + backend local** automáticamente
- espera `GET /api/health` antes de abrir la UI
- reutiliza la misma app React adentro de la ventana desktop
- muestra un panel de diagnóstico si falta `ollama`, `ffmpeg`, `yt-dlp`, `whisper.cpp` o Python

### Desarrollo desktop

```bash
cd /ruta/a/video-summary
npm run desktop:dev
```

Eso levanta:

- renderer Vite
- backend local embebido
- shell Electron

### Empaquetado desktop (Mac-first)

```bash
cd /ruta/a/video-summary
npm run desktop:package
```

Los artifacts salen en `desktop-dist/`.

### Importante

- la app desktop **no empaqueta** todavía `ollama`, `ffmpeg`, `yt-dlp`, `whisper.cpp` ni Python
- esas dependencias siguen siendo prerequisitos externos en v1
- la shell desktop sí valida su estado y lo muestra dentro de la UI, sin obligarte a abrir una terminal

---

## API

### `POST /api/jobs`

#### Modo single

```json
{
  "url": "https://www.youtube.com/watch?v=...",
  "transcriptionLanguage": "auto",
  "outputLanguage": "es",
  "generateTranscription": true,
  "generateTranslation": true,
  "generateSummary": true
}
```

#### Lista manual

```json
{
  "urls": [
    "https://www.youtube.com/watch?v=abc123",
    "https://www.youtube.com/watch?v=def456"
  ],
  "transcriptionLanguage": "auto",
  "outputLanguage": "es",
  "generateTranslation": true,
  "generateSummary": true
}
```

#### Playlist

```json
{
  "playlistUrl": "https://www.youtube.com/playlist?list=...",
  "transcriptionLanguage": "auto",
  "outputLanguage": "es",
  "generateTranslation": true,
  "generateSummary": true
}
```

**Notas**

- `generateTranscription` sigue existiendo, aunque el pipeline base necesita transcribir para traducción y resumen.
- `language` queda como alias legacy temporal.
- lo recomendado es usar:
  - `transcriptionLanguage` = idioma del audio (`auto`, `en`, `es`, `ja`, etc.)
  - `outputLanguage` = idioma final consumible (`es` por defecto)
- `reuseFromJobId` solo está soportado para jobs de URL única en esta versión.

### `GET /api/jobs/:id`

Devuelve:

- estado del job
- archivos detectados
- logs truncados a las últimas líneas
- `logCount`
- `logsTruncated`
- error si aplica

#### Estados posibles

- `pending`
- `queued`
- `resolving_sources`
- `processing`
- `cancelling`
- `cancelled`
- `downloading`
- `transcribing`
- `translating`
- `summarizing`
- `completed`
- `completed_with_warnings`
- `failed`

### `GET /api/jobs/:id/logs?tail=200`

Devuelve logs extendidos del job.

### `POST /api/jobs/:id/cancel`

Solicita la cancelación del job.

#### Comportamiento actual

- si está en `pending`, sale de la cola y pasa a `cancelled`
- si está en `queued` o `resolving_sources`, se cancela antes de ejecutar el pipeline
- si ya está corriendo, pasa a `cancelling`, aborta requests activos y fuerza stop/unload del runtime cuando corresponde
- si ya terminó, devuelve el job con su estado final sin hacer nada extra

### `GET /api/health`

Devuelve estado del runtime IA, por ejemplo:

- `aiRuntime`
- `ownedByCurrentSession`
- `activeJobsCount`
- `ollamaModel`
- `idleShutdownMs`
- timestamps de actividad / apagado programado

### `GET /api/system/memory`

Devuelve memoria aproximada del host:

- `totalMb`
- `usedMb`
- `freeMb`
- `usedPercent`

### `GET /api/models`

Lista modelos locales detectados desde `Ollama /api/tags`.

**Notas**

- puede incluir embeddings
- los embeddings salen como `selectable=false`
- el frontend solo deja elegir modelos aptos como LLM principal

### `GET /api/model-selection`

Devuelve la selección global actual del modelo principal:

- `activeModel`
- `defaultModel`
- `source` (`env` o `runtime_state`)
- `activeModelAvailable`
- `availableModels`
- `warning` si hubo fallback o inconsistencia

### `POST /api/model-selection`

Cambia el modelo LLM principal global para **jobs futuros**.

#### Reglas actuales

- persiste la selección en `.runtime/model-selection.json`
- valida que el modelo exista en Ollama local
- devuelve `409` si hay jobs IA activos
- no toca embeddings ni Whisper

### Files

- `GET /api/jobs/:id/files`
- `GET /api/jobs/:id/files/:filename`
- `GET /api/jobs/:id/items/:itemId/files`
- `GET /api/jobs/:id/items/:itemId/files/:filename`

Los endpoints por item evitan colisiones entre archivos repetidos como `summary_es.txt`, `grounding_report.json`, etc.

---

## Outputs y artifacts

### Ejemplo single URL

```text
output/
  job_1714200000000/
    job.json
    audio.mp3
    audio_denoised.wav
    transcription_part_001.txt
    transcription.txt
    translation_chunk_001_001.txt
    translation_chunk_001_002.txt
    translation_part_001.txt
    translation_es.txt
    extraction_part_001.txt
    full_study_notes_es.txt
    chunk_manifest.json
    claims_part_001.json
    evidence_part_001.json
    evidence_pack_part_001.md
    citation_integrity_part_001.json
    grounding_report.json
    grounding_worker_report.json
    validation_report.json
    outline_es.txt
    key_concepts_es.txt
    questions_es.txt
    glossary_es.txt
    resource_stages.jsonl
    logs.txt
```

### Ejemplo batch

```text
output/
  job_1714200000000/
    job.json
    logs.txt
    item_001/
      job.json
      logs.txt
      audio.mp3
      transcription.txt
      translation_chunk_001_001.txt
      translation_part_001.txt
      translation_es.txt
      full_study_notes_es.txt
      grounding_report.json
    item_002/
      job.json
      logs.txt
      audio.mp3
      transcription.txt
      translation_es.txt
      full_study_notes_es.txt
      grounding_report.json
```

### Artifacts de recovery semántico

Cuando entra thin reasoning / recovery por ventanas, pueden aparecer:

- `thin_reasoning_eval_W*.json`
- `reasoning_resolved_changes_W*.json`
- `controlled_rewrite_W*.json`
- `evidence_hints_W*.json`

---

## Decisiones técnicas

### Arquitectura y operación

- **Sin base de datos**: la metadata vive en archivos locales (`job.json`, `logs.txt`, reports JSON/TXT) y además en un mapa en memoria para servir la UI.
- **Recuperación al reiniciar**: al boot, el backend relee `output/job_xxx/job.json` y marca jobs interrumpidos como `failed` por reinicio del servidor.
- **Cola simple en memoria**: procesa un job por vez para simplificar runtime y logs; dentro de un batch, los items corren secuencialmente.
- **Cancelación cooperativa**: usa `AbortController`, corta requests activos y fuerza stop/unload del runtime cuando corresponde.
- **`spawn` en vez de `execFile`**: permite logs en tiempo real desde `stdout` y `stderr`.
- **Transcripción local optimizada para Mac**: `whisper.cpp` + `large-v3` + glosario + denoise previo.
- **Procesamiento jerárquico**: primero divide el video en partes grandes y después en subchunks de ASR.
- **Extracción exhaustiva local con Ollama**: genera `extraction_part_XXX.txt` y consolida `full_study_notes_es.txt`.
- **Grounding por claims con citas**: valida soporte real usando LlamaIndex sobre chunks fuente.
- **Recovery por ventanas**: puede intentar contract repair, strict re-emit, semantic enrichment y fallback controlado.
- **Thin reasoning chain**: planner → critique → resolve → controlled rewrite con hints evidence-driven.
- **Fallback legacy**: `validation_report.json` sigue como red de seguridad y compatibilidad temporal.
- **Runtime IA on-demand**: Ollama no vive siempre arriba; se levanta solo si un job lo necesita.
- **Selector global de modelo**: la UI persiste el modelo activo en `.runtime/model-selection.json` y cada job congela su metadata de modelo al iniciar.
- **Traducción chunked al español**: si el video no está en español, reutiliza `transcription_chunk_*`, traduce cada fragmento con Ollama y consolida `translation_es.txt` con escritura atómica y reanudación segura.

---

## Archivos clave

### Backend

| Archivo | Responsabilidad |
| --- | --- |
| `backend/src/index.ts` | arranque del backend, health, routers, inicialización de selección de modelo |
| `backend/src/services/jobQueue.ts` | cola secuencial, persistencia de `job.json`, restauración al reiniciar, cancelación |
| `backend/src/services/aiRuntimeManager.ts` | boot/shutdown de Ollama on-demand, idle shutdown, unload del modelo |
| `backend/src/services/modelSelectionService.ts` | selector global del LLM principal y persistencia en `.runtime/model-selection.json` |
| `backend/src/services/videoProcessor.ts` | download, denoise, transcripción, traducción, extracción, trazas raíz y monitoreo |
| `backend/src/services/ollamaClient.ts` | llamadas a Ollama, continuations, spans LLM |
| `backend/src/services/studyGroundingPipeline.ts` | chunk manifest, claims, evidence packs y grounding report |
| `backend/src/services/claimExtraction.ts` | extracción de claims estructurados |
| `backend/src/services/groundingService.ts` | `generateGroundingReport()` |
| `backend/src/services/windowRecoveryService.ts` | resolución de ventanas rotas o comprimidas |
| `backend/src/services/semanticEnrichmentService.ts` | enriquecimiento semántico cuando una ventana queda floja |
| `backend/src/services/thinReasoningChainService.ts` | planner / critique / resolve / controlled rewrite |
| `backend/src/services/evidenceDerivedPromptHintsService.ts` | hints evidence-driven para planner y resolve |
| `backend/grounding_worker/grounding_worker.py` | validación de claims contra chunks con LlamaIndex |
| `backend/src/services/videoPartitioner.ts` | `partitionVideoAudio()` |
| `backend/src/services/studyExtraction.ts` | `generateExtractionForPart()` y `consolidateExtractions()` |

### Frontend

| Archivo | Responsabilidad |
| --- | --- |
| `frontend/src/App.tsx` | polling, carga de reports, wiring general |
| `frontend/src/presentation.ts` | health operativo del job y prioridad visual |
| `frontend/src/components/AiRuntimeBanner.tsx` | estado del runtime y selector global de modelo |
| `frontend/src/components/SystemMemoryWidget.tsx` | memoria aproximada del host |
| `frontend/src/components/GroundingSummary.tsx` | lectura del grounding moderno |
| `frontend/src/components/JobStatus.tsx` | resumen operativo del lote, selector de item y metadata técnica |
| `frontend/src/components/ValidationSummary.tsx` | lectura del reporte legacy |
| `frontend/src/components/JobResourceUsagePanel.tsx` | RAM/CPU/procesos del job |

---

## Limitaciones actuales

- La cola es secuencial y deliberadamente simple.
- La cancelación existe, pero el modelo de ejecución sigue siendo local y no distribuido.
- La traducción larga depende del modelo local activo y puede dejar pequeñas variaciones terminológicas entre chunks.
- La selección del LLM principal es global; no existe todavía selección per-job ni perfiles `fast/balanced/quality`.
- El modelo de embeddings para grounding sigue separado y no se elige desde la UI.
- YouTube puede responder con `HTTP 429` en algunos intentos de `yt-dlp`; cuando pasa, conviene reintentar.
- El pipeline de recovery semántico/thin reasoning mejoró mucho, pero todavía puede dejar partes en `completed_with_warnings` o `needs_review`.
- El resultado final depende bastante del modelo local configurado, del tiempo de respuesta de Ollama y de la memoria disponible de la máquina.

---

## Próximos pasos

1. Mejorar streaming de progreso al frontend con SSE o WebSockets.
2. Afinar thresholds de grounding y decisión por claim con más casos reales.
3. Seguir endureciendo thin reasoning / recovery para bajar `completed_with_warnings`.
4. Separar más adelante la selección de LLM principal, embeddings y perfiles de inferencia sin mezclar responsabilidades.
5. Si aparecen inconsistencias terminológicas entre chunks traducidos, agregar una pasada liviana de normalización post-traducción.

---

## Idea central del proyecto

El foco no es solo “resumir un video”.

El foco REAL es construir un pipeline local que produzca texto en español **usable para estudiar**, con evidencia, grounding, trazabilidad y capacidad de auditoría.

Eso implica una decisión de producto bien concreta:

- primero confiabilidad
- después velocidad
- siempre artifacts inspeccionables

Y sí, eso hace al sistema más complejo. Pero también lo hace MUCHO más honesto.
