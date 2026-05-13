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
      services/
        jobQueue.ts
        ollamaClient.ts
        studyArtifacts.ts
        studyExtraction.ts
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
        JobForm.tsx
        JobStatus.tsx
        FileList.tsx
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

Este proyecto quedó configurado para usar Ollama con el modelo local:

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
OLLAMA_MODEL=gemma3:12b
OLLAMA_TIMEOUT_MS=300000
OLLAMA_NUM_PARALLEL=1
OLLAMA_MAX_LOADED_MODELS=1
OLLAMA_KEEP_ALIVE=2m
OLLAMA_IDLE_SHUTDOWN_MS=30000
FULL_NOTES_OLLAMA_NUM_PREDICT=700
FULL_NOTES_OLLAMA_NUM_CTX=2048
GROUNDING_OLLAMA_NUM_PREDICT=700
GROUNDING_OLLAMA_NUM_CTX=4096
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
- procesa con `gemma3:12b`
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
9. Si activás traducción, se crea `translation_es.txt` como placeholder.
10. Si activás resumen, Ollama genera una extracción exhaustiva explicativa por parte (`extraction_part_XXX.txt`) **con citas a chunks** y luego consolida todo en `full_study_notes_es.txt`.
11. El backend extrae claims estructurados por parte (`claims_part_XXX.json`) y genera además un `chunk_manifest.json`.
12. Un worker Python con LlamaIndex valida esos claims contra los chunks fuente y produce `grounding_report.json`.
13. Se mantiene `validation_report.json` como fallback legacy para compatibilidad y debugging.
14. También se generan artefactos de estudio derivados: `outline_es.txt`, `key_concepts_es.txt`, `questions_es.txt` y `glossary_es.txt`.
15. Todos los logs del proceso se escriben también en `logs.txt`.

## Endpoints

### `POST /api/jobs`

Body:

```json
{
  "url": "https://www.youtube.com/watch?v=...",
  "language": "auto",
  "generateTranscription": true,
  "generateTranslation": true,
  "generateSummary": true
}
```

> `generateTranscription` sigue existiendo en la API, aunque el procesamiento base necesita transcribir para habilitar traducción y resumen.
> En `language` podés mandar `auto`, códigos ISO simples (`en`, `es`, `ja`) o nombres comunes como `English`, `Español`, `Japanese`.

### `GET /api/jobs/:id`

Devuelve el estado actual del job:

- `pending`
- `downloading`
- `transcribing`
- `translating`
- `summarizing`
- `completed`
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
    transcription_part_001.txt
    extraction_part_001.txt
    transcription.txt
    chunk_manifest.json
    claims_part_001.json
    full_study_notes_es.txt
    translation_es.txt
    summary_es.txt
    validation_report.json
    grounding_report.json
    outline_es.txt
    key_concepts_es.txt
    questions_es.txt
    glossary_es.txt
    logs.txt
```

## Decisiones técnicas actuales

- **Sin base de datos**: toda la metadata vive en memoria mientras el proceso Node está levantado y además se persiste un snapshot en `job.json`.
- **Cola simple en memoria**: procesa un job por vez para evitar mezclar stdout/stderr y simplificar el flujo local.
- **`spawn` en vez de `execFile`**: permite leer logs en tiempo real desde `stdout` y `stderr`.
- **Transcripción local optimizada para Mac**: se usa `whisper.cpp` con `whisper-cli`, modelo `large-v3`, prompt con glosario y denoise previo en `ffmpeg`.
- **Procesamiento jerárquico**: primero parte el video en bloques de 30 minutos y recién después transcribe cada parte en subchunks más chicos.
- **Extracción exhaustiva local con Ollama**: se generan `extraction_part_XXX.txt` con formato explicativo por temas y luego se consolidan en `full_study_notes_es.txt`.
- **Grounding por claims con citas**: cada extracción parcial genera claims estructurados y se valida contra chunks reales de la transcripción usando LlamaIndex; el resultado principal queda en `grounding_report.json`.
- **Fallback legacy**: el viejo `validation_report.json` sigue existiendo como red de seguridad y compatibilidad temporal.
- **Traducción placeholder**: `translateToSpanish()` sigue siendo un placeholder hasta que decidas integrarla también con Ollama.

## Archivos clave

- `backend/src/services/videoProcessor.ts`
  - `translateToSpanish()`
  - `generateStudyOutputs()`
- `backend/src/services/ollamaClient.ts`
  - `generateSpanishSummary()`
- `backend/src/services/claimExtraction.ts`
  - `extractClaimsFromStudyNotes()`
- `backend/src/services/groundingService.ts`
  - `generateGroundingReport()`
- `backend/grounding_worker/grounding_worker.py`
  - valida claims contra chunks con LlamaIndex
- `backend/src/services/videoPartitioner.ts`
  - `partitionVideoAudio()`
- `backend/src/services/studyExtraction.ts`
  - `generateExtractionForPart()`
  - `consolidateExtractions()`

## Cómo extender luego con Ollama

### Estrategia recomendada

1. Mantener `transcription.txt` como fuente única.
2. Reusar el cliente actual de Ollama para agregar traducción.
3. Guardar la respuesta final en:
   - `translation_es.txt`
   - `summary_es.txt`

### Ejemplo de evolución

```ts
async function translateToSpanish(outputDir: string, transcriptionPath: string): Promise<void> {
  const transcription = await readText(transcriptionPath);
  const translated = await askOllama({
    system: 'Traducí al español rioplatense sin agregar contenido.',
    prompt: transcription,
  });

  await writeText(path.join(outputDir, 'translation_es.txt'), translated);
}
```

## Limitaciones actuales

- Si reiniciás el backend, los jobs en memoria se pierden aunque los archivos ya escritos en `/output` permanecen.
- La cola es secuencial y deliberadamente simple.
- No hay cancelación de jobs todavía.
- La traducción todavía no usa un modelo real y sigue siendo placeholder.
- YouTube puede responder con `HTTP 429` en algunos intentos de `yt-dlp`; cuando pasa, el job falla y conviene reintentar.
- El resumen depende bastante del modelo local configurado y del tiempo de respuesta de Ollama.

## Próximos pasos razonables

1. Integrar también la traducción con Ollama.
2. Agregar cancelación de jobs.
3. Recuperar jobs desde `job.json` al reiniciar.
4. Mejorar streaming de progreso al frontend con SSE o WebSockets.
5. Afinar thresholds de grounding y decisión por claim con casos reales.
