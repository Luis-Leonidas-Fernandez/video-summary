import { spawn } from 'node:child_process';
import { cleanupRuntime, persistDevState } from './runtime-control.mjs';

const OLLAMA_URL = 'http://127.0.0.1:11434/api/tags';
const BACKEND_URL = 'http://127.0.0.1:3001/api/health';
const OLLAMA_REACHABILITY_TIMEOUT_MS = 2_000;
const OLLAMA_STARTUP_WAIT_MS = 15_000;
const BACKEND_STARTUP_WAIT_MS = 15_000;
const OLLAMA_POLL_INTERVAL_MS = 400;

const children = [];

function log(message) {
  console.log(`[video-study-tool] ${message}`);
}

function spawnManagedProcess(name, command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: false,
    ...options,
  });

  children.push({ name, child, managed: options.managed ?? true });

  child.on('exit', (code, signal) => {
    const reason = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
    log(`${name} terminó (${reason}).`);

    if (name !== 'frontend' && name !== 'backend') {
      return;
    }

    shutdown(code ?? 0);
  });

  child.on('error', (error) => {
    console.error(`[video-study-tool] Error iniciando ${name}:`, error);
    shutdown(1);
  });

  return child;
}

let shuttingDown = false;

function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const { child, managed } of children) {
    if (!managed || child.killed) {
      continue;
    }

    child.kill('SIGTERM');
  }

  setTimeout(() => {
    cleanupRuntime({
      includeOllama: false,
      logger: (message) => log(`cleanup: ${message}`),
    });
    process.exit(exitCode);
  }, 250);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function isOllamaReachable() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_REACHABILITY_TIMEOUT_MS);

  try {
    const response = await fetch(OLLAMA_URL, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), OLLAMA_REACHABILITY_TIMEOUT_MS);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (response.ok) {
        return true;
      }
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, OLLAMA_POLL_INTERVAL_MS));
  }

  return false;
}

async function waitForOllama() {
  return waitFor(OLLAMA_URL, OLLAMA_STARTUP_WAIT_MS);
}

async function main() {
  const ollamaAlreadyRunning = await isOllamaReachable();

  persistDevState({
    ollamaStartedByDev: !ollamaAlreadyRunning,
    ollamaStartedByBackend: false,
  });

  if (ollamaAlreadyRunning) {
    log('Ollama ya está corriendo. Usando instancia externa.');
  } else {
    log('Levantando Ollama...');
    spawnManagedProcess('ollama', 'ollama', ['serve'], { stdio: 'ignore' });

    const ready = await waitForOllama();
    if (!ready) {
      log('Ollama no quedó disponible a tiempo. Continuando igual...');
    } else {
      log('Ollama listo.');
    }
  }

  log('Levantando backend...');
  spawnManagedProcess('backend', 'npm', ['--prefix', 'backend', 'run', 'dev']);

  const backendReady = await waitFor(BACKEND_URL, BACKEND_STARTUP_WAIT_MS);
  if (!backendReady) {
    log('Backend no quedó disponible a tiempo. Continuando igual...');
  }

  log('Levantando frontend...');
  spawnManagedProcess('frontend', 'npm', ['--prefix', 'frontend', 'run', 'dev']);
}

await main();
