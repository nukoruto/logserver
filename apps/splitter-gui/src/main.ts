import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  algoVersion,
  splitSessions,
  estimateThresholdsByUser,
  SessionSplitOptions,
  AugmentedRow
} from '@logserver/session-splitter';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function createWindow(): Promise<void> {
  const mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });

  await mainWindow.loadFile(path.join(__dirname, '../static/index.html'));
}

app.whenReady().then(() => {
  registerIpcHandlers();
  void createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

function registerIpcHandlers(): void {
  ipcMain.handle('session-splitter:select-file', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'CSV Files', extensions: ['csv'] }]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle(
    'session-splitter:split-file',
    async (_event, filePath: string, rawOptions: Partial<SessionSplitOptions> = {}) => {
      if (!filePath) {
        throw new Error('File path must be provided');
      }
      const rows: AugmentedRow[] = [];
      for await (const row of splitSessions(filePath, rawOptions)) {
        rows.push(row);
      }
      const thresholds = estimateThresholdsByUser(rows);
      return {
        algo_ver: algoVersion,
        rows,
        thresholds: Object.fromEntries(thresholds)
      };
    }
  );
}
