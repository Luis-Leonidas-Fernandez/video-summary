import { spawn } from 'node:child_process';

const FRONTEND_URL = 'http://127.0.0.1:3000';
const FRONTEND_POLL_INTERVAL_MS = 400;
const FRONTEND_STARTUP_TIMEOUT_MS = 20_000;

const children = [];
let shuttingDown = false;

function log(message) {
  console.log(`[video-study-tool:desktop] ${message}`);
}

function spawnManaged(name, command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: false,
    ...options,
  });

  children.push({ name, child });

  child.on('exit', (code, signal) => {
    const reason = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
    log(`${name} terminó (${reason}).`);
    if (name === 'electron' || name === 'frontend') {
      shutdown(code ?? 0);
    }
  });

  child.on('error', (error) => {
    console.error(`[video-study-tool:desktop] Error iniciando ${name}:`, error);
    shutdown(1);
  });

  return child;
}

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return true;
      }
    } catch {
      // not ready yet
    }

    await new Promise((resolve) => setTimeout(resolve, FRONTEND_POLL_INTERVAL_MS));
  }

  return false;
}

function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  for (const { child } of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }

  setTimeout(() => process.exit(exitCode), 250);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function main() {
  log('Levantando Vite renderer para desktop...');
  spawnManaged('frontend', 'npm', ['--prefix', 'frontend', 'run', 'dev']);

  const frontendReady = await waitFor(FRONTEND_URL, FRONTEND_STARTUP_TIMEOUT_MS);
  if (!frontendReady) {
    throw new Error('El renderer Vite no quedó listo a tiempo para abrir Electron.');
  }

  log('Levantando Electron desktop shell...');
  spawnManaged('electron', 'npx', ['electron', '.'], {
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: FRONTEND_URL,
      VIDEO_STUDY_DESKTOP: 'true',
      VST_DESKTOP_MODE: 'development',
      VST_BACKEND_PORT: '3001',
    },
  });
}

await main();
