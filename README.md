# Video Study Tool

App local para Mac que recibe una URL de YouTube, descarga el audio, transcribe localmente con `whisper-ctranslate2` y genera un resumen local con Ollama, guardando todos los artefactos en archivos dentro de `/output`.

## Stack

- Frontend: React + Vite + TypeScript
- Backend: Node.js + Express + TypeScript
- Persistencia: archivos locales en `/output`
- Herramientas del sistema:
  - `yt-dlp`
  - `ffmpeg`
  - `whisper-ctranslate2`
  - `ollama`

## Estructura

```text
video-summary/
  backend/
    src/
      index.ts
      routes/jobs.routes.ts
      services/
        jobQueue.ts
        ollamaClient.ts
        transcriptionPreprocessor.ts
        videoProcessor.ts
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
pip install -U faster-whisper whisper-ctranslate2
```

> El backend valida estas dependencias antes de procesar cada trabajo. Si falta alguna, el job falla con un mensaje claro.

### 2) Configuración de Ollama

Este proyecto quedó configurado para usar Ollama con el modelo local:

- `gemma3:12b`

Variables en `backend/.env`:

```env
PORT=3001
WHISPER_MODEL=large-v3-turbo
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=gemma3:12b
OLLAMA_TIMEOUT_MS=300000
OLLAMA_NUM_PREDICT=500
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

### 4) Dependencias del frontend

```bash
cd /ruta/a/video-summary/frontend
npm install
```

### 5) Instalación rápida del workspace

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

- levanta Ollama si todavía no está corriendo
- levanta el backend
- levanta el frontend

Backend disponible en: [http://localhost:3001](http://localhost:3001)
Frontend disponible en: [http://localhost:5173](http://localhost:5173)

En el frontend también se visualiza el contenido de `summary_es.txt` con una presentación estructurada, además de dejar el archivo disponible para abrir o descargar.

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
4. `whisper-ctranslate2` genera `transcription.txt`.
5. Antes de resumir, la transcripción pasa por un preprocesador que:
   - segmenta en secciones
   - detecta transiciones
   - resalta términos técnicos frecuentes
   - entrega una versión estructurada al modelo de resumen
6. Si activás traducción, se crea `translation_es.txt` como placeholder.
7. Si activás resumen, Ollama genera `summary_es.txt` usando el modelo configurado en `.env`.
   - El prompt está orientado a cobertura alta, fidelidad al texto y preservación de términos técnicos.
   - El backend intenta sanear la salida, continuar respuestas cortadas y reparar formatos defectuosos antes de fallar.
8. Todos los logs del proceso se escriben también en `logs.txt`.

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

### `GET /api/jobs/:id`

Devuelve el estado actual del job:

- `pending`
- `downloading`
- `transcribing`
- `translating`
- `summarizing`
- `completed`
- `failed`

Además incluye logs, archivos detectados y error si aplica.

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
    transcription.txt
    translation_es.txt
    summary_es.txt
    logs.txt
```

## Decisiones técnicas actuales

- **Sin base de datos**: toda la metadata vive en memoria mientras el proceso Node está levantado y además se persiste un snapshot en `job.json`.
- **Cola simple en memoria**: procesa un job por vez para evitar mezclar stdout/stderr y simplificar el flujo local.
- **`spawn` en vez de `execFile`**: permite leer logs en tiempo real desde `stdout` y `stderr`.
- **Transcripción acelerada**: se usa `whisper-ctranslate2` en vez del `whisper` Python CLI original.
- **Preprocesamiento antes del resumen**: la transcripción se estructura por secciones y términos para mejorar cobertura del resumen.
- **Resumen local con Ollama**: el backend usa `OLLAMA_BASE_URL` y `OLLAMA_MODEL` desde `.env`.
- **Traducción placeholder**: `translateToSpanish()` sigue siendo un placeholder hasta que decidas integrarla también con Ollama.

## Archivos clave

- `backend/src/services/videoProcessor.ts`
  - `translateToSpanish()`
  - `summarizeSpanish()`
- `backend/src/services/ollamaClient.ts`
  - `generateSpanishSummary()`
- `backend/src/services/transcriptionPreprocessor.ts`
  - `preprocessTranscription()`

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
