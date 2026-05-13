import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';

export const projectRoot = realpathSync(process.cwd());
export const runtimeDir = join(projectRoot, '.runtime');
export const stateFile = join(runtimeDir, 'dev-state.json');
const backendPorts = [3001, 3002];

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    throw result.error;
  }

  return {
    status: result.status ?? 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function unique(values) {
  return [...new Set(values)];
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function listProcesses() {
  const { stdout } = run('/bin/ps', ['-axo', 'pid=,command=']);

  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const firstSpace = line.indexOf(' ');

      if (firstSpace === -1) {
        return null;
      }

      const pid = Number(line.slice(0, firstSpace).trim());
      const command = line.slice(firstSpace + 1).trim();

      if (!Number.isFinite(pid) || pid === process.pid) {
        return null;
      }

      return { pid, command };
    })
    .filter(Boolean);
}

function getListeningPids(port) {
  const result = run('/usr/sbin/lsof', ['-ti', `tcp:${port}`]);

  if (result.status !== 0) {
    return [];
  }

  return result.stdout
    .split('\n')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value));
}

function findBackendPids() {
  return unique(backendPorts.flatMap((port) => getListeningPids(port)));
}

function findGroundingWorkerPids(processes) {
  return processes
    .filter(({ command }) =>
      command.includes(`${projectRoot}/backend/grounding_worker/grounding_worker.py validate`),
    )
    .map(({ pid }) => pid);
}

function findOllamaPids(processes) {
  return processes
    .filter(
      ({ command }) =>
        command === 'ollama serve' || command.includes('/ollama runner --ollama-engine'),
    )
    .map(({ pid }) => pid);
}

function killPids(pids, signal = 'SIGTERM') {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // ignore dead or inaccessible processes
    }
  }
}

function getAlivePids(pids) {
  return pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
}

function stopProcesses(pids, label, logger) {
  const uniquePids = unique(pids).filter((pid) => Number.isFinite(pid));

  if (uniquePids.length === 0) {
    logger(`No encontré procesos para ${label}.`);
    return [];
  }

  logger(`Enviando SIGTERM a ${label}: ${uniquePids.join(', ')}`);
  killPids(uniquePids, 'SIGTERM');
  sleep(400);

  const survivors = getAlivePids(uniquePids);

  if (survivors.length === 0) {
    logger(`${label}: procesos detenidos.`);
    return [];
  }

  logger(`${label}: siguen vivos ${survivors.join(', ')}. Enviando SIGKILL.`);
  killPids(survivors, 'SIGKILL');
  sleep(250);

  const stubborn = getAlivePids(survivors);

  if (stubborn.length > 0) {
    logger(`${label}: no pude matar ${stubborn.join(', ')}.`);
  } else {
    logger(`${label}: procesos detenidos tras SIGKILL.`);
  }

  return stubborn;
}

export function persistDevState(state) {
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(
    stateFile,
    JSON.stringify(
      {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        ...state,
      },
      null,
      2,
    ),
  );
}

export function readDevState() {
  if (!existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

function shouldStopOllamaFromState(devState, includeOllama) {
  if (includeOllama) {
    return true;
  }

  return devState?.ollamaStartedByDev === true || devState?.ollamaStartedByBackend === true;
}

export function clearDevState(logger = () => {}) {
  if (!existsSync(stateFile)) {
    return;
  }

  rmSync(stateFile, { force: true });
  logger('Limpié el estado runtime de dev.');
}

export function cleanupRuntime({ includeOllama = false, logger = console.log } = {}) {
  mkdirSync(runtimeDir, { recursive: true });

  const devState = readDevState();
  const processes = listProcesses();
  const backendPids = findBackendPids();
  const groundingPids = findGroundingWorkerPids(processes);

  stopProcesses(groundingPids, 'grounding workers', logger);
  stopProcesses(backendPids, 'backends locales', logger);

  const refreshedProcesses = listProcesses();
  const remainingProjectProcesses =
    findBackendPids().length + findGroundingWorkerPids(refreshedProcesses).length;
  const shouldStopOllama = shouldStopOllamaFromState(devState, includeOllama);

  if (remainingProjectProcesses === 0 && shouldStopOllama) {
    stopProcesses(findOllamaPids(refreshedProcesses), 'runtime de Ollama', logger);
  } else if (remainingProjectProcesses > 0) {
    logger('No apago Ollama porque todavía quedan procesos del proyecto vivos.');
  } else {
    logger('No apago Ollama porque esta sesión no lo había levantado automáticamente.');
  }

  clearDevState(logger);
}
