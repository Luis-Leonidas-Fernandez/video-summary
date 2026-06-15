# Video Study Tool

App local para Mac que recibe una URL de YouTube, descarga el audio, transcribe localmente con `whisper.cpp`, permite forzar idioma manual, aplica denoise previo con `ffmpeg` y genera material de estudio exhaustivo con Ollama, guardando todos los artefactos en archivos dentro de `/output`.

La validación nueva ya no depende principalmente de “unmatched labels”: ahora el backend genera **claims con citas a chunks** y corre un paso de **grounding** con LlamaIndex para medir qué afirmaciones están realmente respaldadas por la transcripción.

Además, el pipeline ahora arma un **evidence pack cerrado** con aliases `[C1]`, `[C2]`, etc. El modelo nunca ve ids reales de chunks y primero pasa por una validación estricta de integridad de citas antes del grounding semántico.

## Stack

- Frontend: React + Vite + TypeScript
- Backend: Node.js + Express + TypeScript
- Persistencia: archivos locales en `/output`
- Herramientas del sistema:
  - `yt-dlp`
  - `ffmpeg`
  - `whisper.cpp` (`whisper-cli`)
  - `ollama`

## Estructura

```text
video-summary/
  backend/
    grounding_worker/
      grounding_worker.py
      requirements.txt
    src/
      index.ts
      routes/jobs.routes.ts
      routes/modelSelection.routes.ts
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
  output/
  scripts/
    dev.mjs
  README.md
```

## Instalación

### 1) Herramientas del sistema

```bash
brew install yt-dlp ffmpeg ollama
brew install whisper-cpp
bash /Users/luis/whisper.cpp/models/download-ggml-model.sh large-v3
cd /Users/luis/whisper.cpp
cmake -B build-nocoreml -DWHISPER_COREML=OFF
cmake --build build-nocoreml -j 8 --config Release
```

> El backend valida estas dependencias antes de procesar cada trabajo. Si falta alguna, el job falla con un mensaje claro.
> En este proyecto conviene usar un build sin CoreML para `large-v3`, porque así evitás depender del encoder `.mlmodelc`. Si instalaste `whisper.cpp` en otra ruta, ajustá `WHISPER_CPP_BINARY` y `WHISPER_CPP_MODEL_PATH` en `backend/.env`.

### 2) Configuración de Ollama

Este proyecto usa Ollama con un **modelo LLM principal configurable**. El valor inicial sale de `backend/.env`:

- `gemma3:12b`

Variables en `backend/.env`:

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
# Legacy fallback temporal si todavía no migraste:
# OLLAMA_NUM_PREDICT=700
# OLLAMA_NUM_CTX=2048
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

En la UI vas a ver un selector global dentro del panel **Runtime de IA**:

- lista los modelos locales detectados desde `Ollama /api/tags`
- permite cambiar solo el **LLM principal** para jobs futuros
- persiste la selección en `.runtime/model-selection.json`
- no toca el modelo de embeddings ni Whisper
- si hay jobs IA activos, el cambio se bloquea hasta que el runtime quede libre

Si el modelo persistido desaparece de Ollama, el backend intenta volver al `OLLAMA_MODEL` del `.env` y te muestra una advertencia.

### 2.1) Observabilidad con Opik

El backend también está instrumentado con **Opik** para seguir trazas del pipeline y de las llamadas al modelo.

- configuración inicial en `backend/src/index.ts`
- cliente en `backend/src/services/opikTracer.ts`
- trace raíz del pipeline en `backend/src/services/videoProcessor.ts`
- spans/calls del LLM enlazados desde `backend/src/services/ollamaClient.ts`

Eso te permite ver:

- descarga
- transcripción
- resumen / extracción
- llamadas LLM asociadas al trace activo

Importante:

- la instrumentación está en el backend, no en el frontend
- Opik sirve para observabilidad y debugging; no cambia la lógica del pipeline

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

> El worker debe correr dentro de su propio virtualenv. Con el Python del sistema (`/usr/bin/python3`, 3.9) LlamaIndex moderno puede romper por incompatibilidades, y Homebrew Python además está protegido por PEP 668 si intentás instalar globalmente. Si faltan dependencias, el job sigue con fallback legacy **solo si** `GROUNDING_MODE=auto`. Si ponés `GROUNDING_MODE=required`, el grounding pasa a ser obligatorio.

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

## Cómo correr el proyecto

### Opción recomendada: un solo comando

```bash
cd /ruta/a/video-summary
npm run dev
```

Ese comando:

- levanta el backend
- levanta el frontend
- deja Ollama apagado hasta que una tarea de IA realmente lo necesite
- guarda un estado runtime para poder limpiar procesos colgados después
- cuando hacés `Ctrl + C`, además del shutdown normal ejecuta la misma limpieza de `npm run cleanup`

Backend disponible en: [http://localhost:3001](http://localhost:3001)
Frontend disponible en: [http://localhost:5173](http://localhost:5173)

En el frontend también se visualiza el contenido de `full_study_notes_es.txt` con una presentación estructurada, además de dejar el archivo disponible para abrir o descargar.

Cuando iniciás un job que usa IA:

- el backend levanta Ollama on-demand
- procesa con el modelo LLM activo configurado en la UI (o con el default del `.env` si nunca cambiaste la selección)
- usa contexto separado para `full notes` y grounding
- intenta reparar JSON localmente y con un contract repair antes de degradar una ventana
- si no quedan jobs activos, el runtime entra en `idle`
- al terminar un job IA, se fuerza descarga del modelo para liberar RAM
- tras `OLLAMA_IDLE_SHUTDOWN_MS`, se apaga el runtime como respaldo si sigue siendo propiedad de esta sesión

### Limpieza de procesos

Si te queda la máquina pesada después de pruebas manuales, grounding o un backend temporal:

```bash
cd /ruta/a/video-summary
npm run cleanup
```

Ese script:

- mata workers de grounding del proyecto
- mata backends locales escuchando en `3001` y `3002`
- apaga Ollama **solo si** esta sesión de `npm run dev` lo había levantado automáticamente

Si querés forzar además el apagado de Ollama aunque no haya quedado marcado como iniciado por `npm run dev`:

```bash
npm run cleanup:all
```

Tradeoff:

- `cleanup` es más seguro si usás Ollama para otras cosas
- `cleanup:all` libera más memoria, pero te baja todo el runtime local de Ollama

### Comandos individuales

```bash
cd /ruta/a/video-summary
npm run dev:backend
npm run dev:frontend
```

## Flujo actual

1. Pegás una URL válida de YouTube.
2. El backend crea un job en memoria y una carpeta local dentro de `output/job_<timestamp>`.
3. `yt-dlp` descarga y extrae el audio a `audio.mp3`.
4. `ffmpeg` genera `audio_denoised.wav` con reducción de ruido, mono y 16 kHz.
5. `ffmpeg` divide `audio_denoised.wav` en partes de 30 minutos dentro de `video_parts/`.
6. Cada parte se vuelve a segmentar en subchunks más chicos para Whisper.
7. `whisper.cpp` transcribe subchunk por subchunk, usando el idioma manual si lo cargás y un prompt con glosario.
8. El backend fusiona los subchunks en `transcription_part_XXX.txt` y luego consolida todas las partes en `transcription.txt`.
9. Si activás traducción y el video no está en español, el backend traduce la transcripción por chunks y consolida `translation_es.txt`; si ya está en español, reutiliza la transcripción como artifact final en español.
10. Si activás resumen, Ollama genera una extracción exhaustiva por parte (`extraction_part_XXX.txt`) y luego consolida todo en `full_study_notes_es.txt`.
11. El backend arma un `chunk_manifest.json`, un evidence pack con aliases de citas (`[C1]`, `[C2]`, etc.) y extrae claims estructurados por parte (`claims_part_XXX.json`).
12. Un worker Python con LlamaIndex valida esos claims contra los chunks fuente y produce `grounding_report.json`.
13. Si una ventana queda demasiado comprimida o con reasoning débil, entra el pipeline de recuperación semántica / thin reasoning para intentar reparar extracción, señales y grounding antes de degradar el resultado final.
14. `validation_report.json` se mantiene como capa legacy de compatibilidad y debugging, pero ya no es la única fuente de validación del sistema.
15. También se generan artefactos de estudio derivados: `outline_es.txt`, `key_concepts_es.txt`, `questions_es.txt` y `glossary_es.txt`.
16. Todos los logs del proceso se escriben también en `logs.txt`.

## Endpoints

### `POST /api/jobs`

Body:

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

> `generateTranscription` sigue existiendo en la API, aunque el procesamiento base necesita transcribir para habilitar traducción y resumen.
> `language` queda como alias legacy. Lo recomendado es usar `transcriptionLanguage` para el idioma del audio (`auto`, `en`, `es`, `ja`, `English`, `Español`, etc.) y `outputLanguage` para el idioma final consumible.

### `GET /api/jobs/:id`

Devuelve el estado actual del job:

- `pending`
- `cancelling`
- `cancelled`
- `downloading`
- `transcribing`
- `translating`
- `summarizing`
- `completed`
- `completed_with_warnings`
- `failed`

Además incluye:

- estado del job
- archivos detectados
- `logs` truncados a las últimas líneas
- `logCount`
- `logsTruncated`
- error si aplica

Para inspección adicional de logs existe también:

- `GET /api/jobs/:id/logs?tail=200`

### `POST /api/jobs/:id/cancel`

Solicita la cancelación del job.

Comportamiento actual:

- si el job todavía está en `pending`, se saca de la cola y pasa a `cancelled`
- si el job ya está corriendo, pasa a `cancelling`, se abortan requests activos y se fuerza apagado/unload del runtime IA cuando corresponde
- si ya terminó, devuelve el job en su estado final sin hacer nada extra

### `GET /api/health`

Devuelve el estado del runtime local de IA, por ejemplo:

- `aiRuntime`
- `ownedByCurrentSession`
- `activeJobsCount`
- `ollamaModel`
- `idleShutdownMs`
- timestamps de actividad/apagado programado cuando aplican

### `GET /api/models`

Lista los modelos locales detectados en Ollama a través de `/api/tags`.

Notas:

- el endpoint puede devolver también embeddings
- los embeddings salen marcados como `selectable=false`
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

Reglas actuales:

- persiste la selección en `.runtime/model-selection.json`
- valida que el modelo exista en Ollama local
- no deja cambiarlo mientras haya jobs IA activos (`409`)
- no toca el modelo de embeddings ni Whisper

### `GET /api/jobs/:id/files`

Lista los archivos generados para ese trabajo.

### `GET /api/jobs/:id/files/:filename`

Entrega el archivo para verlo o descargarlo.

## Estructura de salida

Ejemplo:

```text
output/
  job_1714200000000/
    job.json
    audio.mp3
    audio_denoised.wav
    translation_chunk_001_001.txt
    translation_chunk_001_002.txt
    translation_part_001.txt
    transcription_part_001.txt
    extraction_part_001.txt
    transcription.txt
    chunk_manifest.json
    claims_part_001.json
    evidence_part_001.json
    evidence_pack_part_001.md
    citation_integrity_part_001.json
    full_study_notes_es.txt
    translation_es.txt
    summary_es.txt
    validation_report.json
    grounding_report.json
    grounding_worker_report.json
    outline_es.txt
    key_concepts_es.txt
    questions_es.txt
    glossary_es.txt
    resource_stages.jsonl
    logs.txt
```

Además, cuando entran ventanas con recuperación semántica/thin reasoning, pueden aparecer artifacts por ventana como:

- `thin_reasoning_eval_W*.json`
- `reasoning_resolved_changes_W*.json`
- `controlled_rewrite_W*.json`
- `evidence_hints_W*.json`

## Decisiones técnicas actuales

- **Sin base de datos**: toda la metadata principal vive en archivos locales (`output/job_xxx/job.json`, `logs.txt`, reports JSON/TXT) y el proceso también mantiene un mapa en memoria para servir la UI.
- **Recuperación al reiniciar**: al boot, el backend relee `job.json` desde `/output`; si encuentra jobs que quedaron a mitad de ejecución, los marca como `failed` por reinicio del servidor en lugar de “olvidarlos”.
- **Cola simple en memoria**: procesa un job por vez para evitar mezclar stdout/stderr y simplificar el flujo local.
- **Cancelación cooperativa**: la cancelación usa `AbortController`, corta requests activos y fuerza stop/unload del runtime cuando corresponde.
- **`spawn` en vez de `execFile`**: permite leer logs en tiempo real desde `stdout` y `stderr`.
- **Transcripción local optimizada para Mac**: se usa `whisper.cpp` con `whisper-cli`, modelo `large-v3`, prompt con glosario y denoise previo en `ffmpeg`.
- **Procesamiento jerárquico**: primero parte el video en bloques de 30 minutos y recién después transcribe cada parte en subchunks más chicos.
- **Extracción exhaustiva local con Ollama**: se generan `extraction_part_XXX.txt` con formato explicativo por temas y luego se consolidan en `full_study_notes_es.txt`.
- **Grounding por claims con citas**: cada extracción parcial genera claims estructurados y se valida contra chunks reales de la transcripción usando LlamaIndex; el resultado principal queda en `grounding_report.json`.
- **Recovery por ventanas**: si una ventana sale con schema roto, drift, low content o thin reasoning, el backend puede intentar contract repair, strict re-emit, semantic enrichment, preserve previous extraction y fallback controlado.
- **Thin reasoning chain**: el pipeline puede correr planner → critique → resolve → controlled rewrite con hints derivados de evidencia para intentar rescatar ventanas comprimidas sin inventar contenido.
- **Fallback legacy**: `validation_report.json` sigue existiendo como red de seguridad y compatibilidad temporal, pero hoy convive con `grounding_report.json` y artifacts de recuperación más ricos.
- **Runtime IA on-demand**: Ollama no se levanta al abrir la app; se inicia solo cuando un job con `generateSummary=true` lo necesita, queda en `idle` al terminar y puede apagarse solo para liberar RAM.
- **Selector global de modelo**: el LLM principal se elige desde la UI, se persiste en `.runtime/model-selection.json` y se congela en `job.modelMetadata` al inicio de cada job para que el histórico siga siendo comparable.
- **Traducción chunked al español**: si el video no está en español, `translateToSpanish()` reutiliza los `transcription_chunk_*`, traduce cada fragmento con Ollama, consolida `translation_part_*` y finalmente genera `translation_es.txt` con escritura atómica y reanudación segura.

## Archivos clave

- `backend/src/index.ts`
  - arranque del backend
  - health
  - routers
  - inicialización de selección de modelo
- `backend/src/services/jobQueue.ts`
  - cola secuencial
  - persistencia de `job.json`
  - restauración al reiniciar
  - cancelación
- `backend/src/services/aiRuntimeManager.ts`
  - boot/shutdown de Ollama on-demand
  - idle shutdown
  - unload del modelo
- `backend/src/services/modelSelectionService.ts`
  - selector global del modelo LLM principal
  - persistencia en `.runtime/model-selection.json`
  - validación contra `/api/tags`
- `backend/src/services/videoProcessor.ts`
  - download + denoise + transcripción + resumen
  - opik trace raíz
  - monitoreo de recursos
- `backend/src/services/ollamaClient.ts`
  - llamadas a Ollama
  - continuations
  - spans LLM
- `backend/src/services/studyGroundingPipeline.ts`
  - chunk manifest
  - claims
  - grounding report
  - consolidation por parte
- `backend/src/services/claimExtraction.ts`
  - extracción de claims estructurados desde ventanas
- `backend/src/services/groundingService.ts`
  - `generateGroundingReport()`
- `backend/src/services/windowRecoveryService.ts`
  - resolución de ventanas rotas o comprimidas
- `backend/src/services/semanticEnrichmentService.ts`
  - intento de enriquecimiento semántico cuando una ventana queda floja
- `backend/src/services/thinReasoningChainService.ts`
  - planner / critique / resolve / controlled rewrite
- `backend/src/services/evidenceDerivedPromptHintsService.ts`
  - hints evidence-driven para planner/resolve
- `backend/grounding_worker/grounding_worker.py`
  - valida claims contra chunks con LlamaIndex
- `backend/src/services/videoPartitioner.ts`
  - `partitionVideoAudio()`
- `backend/src/services/studyExtraction.ts`
  - `generateExtractionForPart()`
  - `consolidateExtractions()`
- `frontend/src/App.tsx`
  - polling
  - carga de reports
  - wiring general de la UI
- `frontend/src/components/AiRuntimeBanner.tsx`
  - estado del runtime
  - selector global de modelo
- `frontend/src/components/GroundingSummary.tsx`
  - lectura del grounding moderno
- `frontend/src/components/ValidationSummary.tsx`
  - lectura del reporte legacy
- `frontend/src/components/JobResourceUsagePanel.tsx`
  - RAM/CPU/procesos del job

## Limitaciones actuales

- La cola es secuencial y deliberadamente simple.
- La cancelación existe, pero el modelo de ejecución sigue siendo local y no distribuido.
- La traducción larga depende del modelo local activo y, al hacerse por chunks, puede tener pequeñas variaciones terminológicas entre fragmentos.
- La selección actual del modelo LLM principal es global; no existe todavía selección per-job ni perfiles tipo `fast/balanced/quality`.
- El modelo de embeddings para grounding sigue separado y no se selecciona desde la UI.
- YouTube puede responder con `HTTP 429` en algunos intentos de `yt-dlp`; cuando pasa, el job falla y conviene reintentar.
- El pipeline de recovery semántico/thin reasoning mejora observabilidad y rescate de ventanas, pero todavía puede dejar partes en `completed_with_warnings` o `needs_review` según el caso.
- El resumen depende bastante del modelo local configurado, del tiempo de respuesta de Ollama y de la memoria disponible de la máquina.

## Próximos pasos razonables

1. Mejorar streaming de progreso al frontend con SSE o WebSockets.
2. Afinar thresholds de grounding y decisión por claim con casos reales.
3. Seguir endureciendo el pipeline de thin reasoning / recovery para reducir `completed_with_warnings`.
4. Si más adelante lo necesitás, separar la selección de LLM principal, embeddings y perfiles de inferencia sin mezclar responsabilidades en una sola UI.
5. Si aparecen inconsistencias terminológicas entre chunks traducidos, agregar una pasada liviana de normalización post-traducción.
