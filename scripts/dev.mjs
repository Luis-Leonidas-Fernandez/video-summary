import { spawn } from 'node:child_process';
import { cleanupRuntime, persistDevState } from './runtime-control.mjs';

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

async function main() {
  persistDevState({ ollamaStartedByDev: false, ollamaStartedByBackend: false });

  log('Levantando backend...');
  spawnManagedProcess('backend', 'npm', ['--prefix', 'backend', 'run', 'dev']);

  log('Levantando frontend...');
  spawnManagedProcess('frontend', 'npm', ['--prefix', 'frontend', 'run', 'dev']);
}

await main();
