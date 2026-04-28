import { spawn } from 'node:child_process';

const OLLAMA_URL = 'http://127.0.0.1:11434/api/tags';
const children = [];

function log(message) {
  console.log(`[video-study-tool] ${message}`);
}

async function isOllamaRunning() {
  try {
    const response = await fetch(OLLAMA_URL);
    return response.ok;
  } catch {
    return false;
  }
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

  setTimeout(() => process.exit(exitCode), 250);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function main() {
  const ollamaRunning = await isOllamaRunning();

  if (ollamaRunning) {
    log('Ollama ya está corriendo en http://127.0.0.1:11434.');
  } else {
    log('Ollama no estaba corriendo. Levantando `ollama serve`...');
    spawnManagedProcess('ollama', 'ollama', ['serve']);
  }

  log('Levantando backend...');
  spawnManagedProcess('backend', 'npm', ['--prefix', 'backend', 'run', 'dev']);

  log('Levantando frontend...');
  spawnManagedProcess('frontend', 'npm', ['--prefix', 'frontend', 'run', 'dev']);
}

await main();
