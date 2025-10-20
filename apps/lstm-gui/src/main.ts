import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';

import type {
  CalibrateRequest,
  CommandError,
  FitRequest,
  InferRequest,
  HealthReport,
  OnlineRequest,
  TrainRequest
} from './ipcTypes.js';
import {
  buildCalibrateCommand,
  buildFitCommand,
  buildInferCommand,
  buildOnlineCommand,
  buildTrainCommand
} from './python/cliArgs.js';
import { DtLstmProcessRunner, collectSystemHealth } from './python/runner.js';

let mainWindow: BrowserWindow | null = null;
let runner: DtLstmProcessRunner | null = null;
let repoRootPath: string | null = null;

function isCommandError(error: unknown): error is CommandError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'command' in error &&
    'message' in error &&
    'exitCode' in error
  );
}

function createWindow(distRoot: string, preloadPath: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      preload: preloadPath
    }
  });
  const htmlPath = path.join(distRoot, 'static', 'index.html');
  void window.loadFile(htmlPath);
  return window;
}

async function handleFit(request: FitRequest): Promise<unknown> {
  if (!runner) {
    throw new Error('dt-lstm ランナーが初期化されていません');
  }
  const command = buildFitCommand(request);
  const result = await runner.run(command, request.requestId);
  return result.payload;
}

async function handleTrain(request: TrainRequest): Promise<unknown> {
  if (!runner) {
    throw new Error('dt-lstm ランナーが初期化されていません');
  }
  const command = buildTrainCommand(request);
  const result = await runner.run(command, request.requestId);
  return result.payload;
}

async function handleCalibrate(request: CalibrateRequest): Promise<unknown> {
  if (!runner) {
    throw new Error('dt-lstm ランナーが初期化されていません');
  }
  const command = buildCalibrateCommand(request);
  const result = await runner.run(command, request.requestId);
  return result.payload;
}

async function handleInfer(request: InferRequest): Promise<unknown> {
  if (!runner) {
    throw new Error('dt-lstm ランナーが初期化されていません');
  }
  const command = buildInferCommand(request);
  const result = await runner.run(command, request.requestId);
  return result.payload;
}

async function handleOnline(request: OnlineRequest): Promise<unknown> {
  if (!runner) {
    throw new Error('dt-lstm ランナーが初期化されていません');
  }
  const command = buildOnlineCommand(request);
  const result = await runner.run(command, request.requestId);
  return result.payload;
}

function registerHandlers(repoRoot: string): void {
  const wrap = <T>(channel: string, executor: (request: T) => Promise<unknown>): void => {
    ipcMain.handle(channel, async (_event, payload: T) => {
      try {
        return await executor(payload);
      } catch (error) {
        if (isCommandError(error)) {
          const wrapped = new Error(error.message);
          (wrapped as Error & { detail?: CommandError }).detail = error;
          throw wrapped;
        }
        throw error;
      }
    });
  };

  wrap<FitRequest>('lstm.fit', handleFit);
  wrap<TrainRequest>('lstm.train', handleTrain);
  wrap<CalibrateRequest>('lstm.calibrate', handleCalibrate);
  wrap<InferRequest>('lstm.infer', handleInfer);
  wrap<OnlineRequest>('lstm.online', handleOnline);
  ipcMain.handle('lstm.cancel', () => {
    if (!runner) {
      return false;
    }
    return runner.cancel();
  });
  ipcMain.handle('lstm.health', async () => {
    const report = runner
      ? await runner.checkHealth()
      : await collectSystemHealth(repoRoot);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('lstm.health.result', report);
    }
    return report;
  });
}

app.whenReady().then(() => {
  const appPath = app.getAppPath();
  const projectRoot = path.resolve(appPath);
  const repoRoot = path.resolve(projectRoot, '..', '..');
  repoRootPath = repoRoot;
  const distRoot = path.join(projectRoot, 'dist');
  const preloadPath = path.join(distRoot, 'src', 'preload.js');
  mainWindow = createWindow(distRoot, preloadPath);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  runner = new DtLstmProcessRunner(mainWindow, repoRoot);
  registerHandlers(repoRoot);

  const dispatchHealth = async (): Promise<void> => {
    const targetWindow = mainWindow;
    if (!targetWindow || targetWindow.isDestroyed()) {
      return;
    }
    try {
      const report = runner
        ? await runner.checkHealth()
        : await collectSystemHealth(repoRoot);
      targetWindow.webContents.send('lstm.health.result', report);
    } catch (error) {
      const fallback: HealthReport = {
        timestamp: new Date().toISOString(),
        io: { directories: [] },
        disk: {
          path: repoRoot,
          freeBytes: null,
          totalBytes: null,
          thresholdBytes: 0,
          ok: false,
          message: error instanceof Error ? error.message : 'ヘルスチェックに失敗しました'
        },
        gpu: {
          mode: 'unknown',
          available: false,
          devices: [],
          cudaVisibleDevices: process.env.CUDA_VISIBLE_DEVICES ?? null,
          message: 'ヘルスチェックで例外が発生しました',
          error: error instanceof Error ? error.message : '未知のエラー'
        },
        warnings: [],
        errors: [error instanceof Error ? error.message : 'ヘルスチェックに失敗しました']
      };
      targetWindow.webContents.send('lstm.health.result', fallback);
    }
  };

  mainWindow.webContents.once('did-finish-load', () => {
    void dispatchHealth();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow(distRoot, preloadPath);
      mainWindow.on('closed', () => {
        mainWindow = null;
      });
      if (runner) {
        runner.setWindow(mainWindow);
        void runner
          .checkHealth()
          .then((report) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('lstm.health.result', report);
            }
          })
          .catch((error: unknown) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              const fallback: HealthReport = {
                timestamp: new Date().toISOString(),
                io: { directories: [] },
                disk: {
                  path: repoRootPath ?? process.cwd(),
                  freeBytes: null,
                  totalBytes: null,
                  thresholdBytes: 0,
                  ok: false,
                  message: error instanceof Error ? error.message : 'ヘルスチェックに失敗しました'
                },
                gpu: {
                  mode: 'unknown',
                  available: false,
                  devices: [],
                  cudaVisibleDevices: process.env.CUDA_VISIBLE_DEVICES ?? null,
                  message: 'ヘルスチェックで例外が発生しました',
                  error: error instanceof Error ? error.message : '未知のエラー'
                },
                warnings: [],
                errors: [error instanceof Error ? error.message : 'ヘルスチェックに失敗しました']
              };
              mainWindow.webContents.send('lstm.health.result', fallback);
            }
          });
      } else if (repoRootPath) {
        void collectSystemHealth(repoRootPath).then((report) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('lstm.health.result', report);
          }
        });
      }
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
