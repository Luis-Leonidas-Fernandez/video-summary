const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const isDev = !app.isPackaged;
const rendererUrl = process.env.ELECTRON_RENDERER_URL || 'http://127.0.0.1:3000';
const backendPort = Number(process.env.VST_BACKEND_PORT || (isDev ? 3001 : 39091));
const backendOrigin = `http://127.0.0.1:${backendPort}`;
const ollamaOrigin = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const ollamaTagsUrl = `${ollamaOrigin.replace(/\/$/, '')}/api/tags`;
const startupTimeoutMs = 20_000;
const ollamaStartupTimeoutMs = 15_000;
const pollIntervalMs = 400;

let mainWindow = null;
let splashWindow = null;
let backendProcess = null;
let backendOwnedByDesktop = false;
let ollamaProcess = null;
let ollamaOwnedByDesktop = false;
let shuttingDown = false;

const userDataRoot = app.getPath('userData');
const logsDir = path.join(userDataRoot, 'logs');
const desktopLogPath = path.join(logsDir, 'desktop-main.log');
const knownDesktopPathEntries = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function appendDesktopLog(message) {
  ensureDir(logsDir);
  fs.appendFileSync(desktopLogPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
}

function projectRootDev() {
  return path.resolve(__dirname, '..');
}

function backendCwd() {
  return isDev
    ? path.join(projectRootDev(), 'backend')
    : path.join(process.resourcesPath, 'backend');
}

function frontendIndexPath() {
  return path.join(process.resourcesPath, 'frontend-dist', 'index.html');
}

function preloadPath() {
  return path.join(__dirname, 'preload.cjs');
}

function splashPath() {
  return path.join(__dirname, 'splash.html');
}

function backendEnv() {
  const currentPathEntries = String(process.env.PATH || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const mergedPathEntries = [...knownDesktopPathEntries, ...currentPathEntries]
    .filter((entry, index, all) => all.indexOf(entry) === index);

  return {
    ...process.env,
    PATH: mergedPathEntries.join(path.delimiter),
    VIDEO_STUDY_DESKTOP: 'true',
    PORT: String(backendPort),
    VIDEO_STUDY_OUTPUT_ROOT: path.join(userDataRoot, 'output'),
    VIDEO_STUDY_RUNTIME_DIR: path.join(userDataRoot, '.runtime'),
    VIDEO_STUDY_PROJECT_ROOT: userDataRoot,
  };
}

function resolvedDesktopPath() {
  return backendEnv().PATH || '';
}

function splitPathEntries(value) {
  return String(value || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveExecutablePath(configuredCommand, fallbackBinaryName) {
  const command = configuredCommand || fallbackBinaryName;

  if (command.includes('/')) {
    return fs.existsSync(command) ? command : null;
  }

  const pathEntries = splitPathEntries(resolvedDesktopPath());
  for (const directory of pathEntries) {
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }

  return null;
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 460,
    height: 320,
    frame: false,
    resizable: false,
    movable: true,
    fullscreenable: false,
    show: false,
    backgroundColor: '#08111f',
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
    },
  });

  splashWindow.once('ready-to-show', () => splashWindow && splashWindow.show());
  splashWindow.loadFile(splashPath());
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 1120,
    minHeight: 760,
    show: false,
    backgroundColor: '#08111f',
    title: 'Video Study Tool',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
      splashWindow = null;
    }
    mainWindow.show();
  });

  if (isDev) {
    mainWindow.loadURL(rendererUrl);
    return;
  }

  mainWindow.loadFile(frontendIndexPath());
}

async function isBackendHealthy() {
  try {
    const response = await fetch(`${backendOrigin}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function isOllamaReachable() {
  try {
    const response = await fetch(ollamaTagsUrl);
    return response.ok;
  } catch {
    return false;
  }
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

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return false;
}

async function waitForBackend() {
  return waitFor(`${backendOrigin}/api/health`, startupTimeoutMs);
}

async function waitForOllama() {
  return waitFor(ollamaTagsUrl, ollamaStartupTimeoutMs);
}

function startOllamaProcess() {
  const ollamaBinary = resolveExecutablePath(process.env.OLLAMA_BINARY || 'ollama', 'ollama');
  if (!ollamaBinary) {
    throw new Error(
      `No se encontró el ejecutable de Ollama para la app desktop. PATH efectivo: ${resolvedDesktopPath() || '(vacío)'}. También podés definir OLLAMA_BINARY.`,
    );
  }

  const env = {
    ...process.env,
    PATH: resolvedDesktopPath(),
  };

  appendDesktopLog(`Levantando Ollama desktop con ${ollamaBinary}.`);
  ollamaProcess = spawn(ollamaBinary, ['serve'], {
    stdio: 'ignore',
    shell: false,
    env,
  });
  ollamaOwnedByDesktop = true;

  ollamaProcess.on('exit', (code, signal) => {
    appendDesktopLog(`ollama terminó (${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`})`);
    ollamaProcess = null;
    ollamaOwnedByDesktop = false;
  });
}

async function ensureOllamaReady() {
  if (await isOllamaReachable()) {
    appendDesktopLog(`Reutilizando Ollama ya disponible en ${ollamaOrigin}.`);
    ollamaOwnedByDesktop = false;
    return;
  }

  startOllamaProcess();
  const ready = await waitForOllama();
  if (!ready) {
    throw new Error(`Ollama no respondió en ${ollamaOrigin} dentro del tiempo esperado.`);
  }

  appendDesktopLog(`Ollama listo en ${ollamaOrigin}.`);
}

function startBackendProcess() {
  const cwd = backendCwd();
  const env = backendEnv();
  appendDesktopLog(`Backend PATH efectivo: ${env.PATH || '(vacío)'}`);

  if (isDev) {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    backendProcess = spawn(npmCommand, ['run', 'dev'], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
  } else {
    const backendEntry = path.join(cwd, 'dist', 'index.js');
    backendProcess = spawn(process.execPath, [backendEntry], {
      cwd,
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
  }

  backendOwnedByDesktop = true;

  backendProcess.stdout.on('data', (chunk) => appendDesktopLog(`[backend:stdout] ${chunk.toString().trimEnd()}`));
  backendProcess.stderr.on('data', (chunk) => appendDesktopLog(`[backend:stderr] ${chunk.toString().trimEnd()}`));
  backendProcess.on('exit', (code, signal) => {
    appendDesktopLog(`backend terminó (${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`})`);
    backendProcess = null;
    if (!shuttingDown) {
      dialog.showErrorBox(
        'Backend detenido',
        'El backend local se cerró antes de tiempo. Mirá los logs de la app para más detalle.',
      );
      app.quit();
    }
  });
}

async function ensureBackendReady() {
  if (await isBackendHealthy()) {
    appendDesktopLog('Reutilizando backend ya disponible.');
    backendOwnedByDesktop = false;
    return;
  }

  appendDesktopLog('Levantando backend local para desktop shell.');
  startBackendProcess();
  const ready = await waitForBackend();
  if (!ready) {
    throw new Error('El backend no respondió a /api/health dentro del tiempo esperado.');
  }
}

async function shutdownOllama() {
  if (!ollamaOwnedByDesktop || !ollamaProcess || ollamaProcess.killed) {
    return;
  }

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        ollamaProcess.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve();
    }, 5_000);

    ollamaProcess.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });

    try {
      ollamaProcess.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function shutdownBackend() {
  if (!backendOwnedByDesktop || !backendProcess || backendProcess.killed) {
    return;
  }

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        backendProcess.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve();
    }, 5_000);

    backendProcess.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });

    try {
      backendProcess.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function bootDesktopShell() {
  createSplashWindow();
  await ensureOllamaReady();
  await ensureBackendReady();
  createMainWindow();
}

app.on('window-all-closed', async () => {
  if (process.platform !== 'darwin') {
    await app.quit();
  }
});

app.on('before-quit', async (event) => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  event.preventDefault();
  await shutdownBackend();
  await shutdownOllama();
  app.exit(0);
});

app.whenReady()
  .then(async () => {
    appendDesktopLog('Inicializando desktop shell.');
    await bootDesktopShell();
  })
  .catch((error) => {
    appendDesktopLog(`Fallo de arranque desktop: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    dialog.showErrorBox(
      'No se pudo abrir Video Study Tool',
      error instanceof Error ? error.message : 'Error desconocido iniciando la app desktop.',
    );
    app.quit();
  });
