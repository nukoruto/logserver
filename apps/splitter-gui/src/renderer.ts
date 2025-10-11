import type { AugmentedRow } from '@logserver/session-splitter';

interface SplitterResult {
  algo_ver: string;
  rows: AugmentedRow[];
  thresholds: Record<string, number>;
}

declare global {
  interface Window {
    sessionSplitter: {
      algoVersion: string;
      selectFile: () => Promise<string | null>;
      splitFile: (filePath: string, options?: { idleTimeoutSeconds?: number }) => Promise<SplitterResult>;
    };
  }
}

const selectButton = document.getElementById('select-file');
const idleInput = document.getElementById('idle-timeout') as HTMLInputElement | null;
const statusElement = document.getElementById('status');
const algoElement = document.getElementById('algo-version');
const outputElement = document.getElementById('output');

if (algoElement) {
  algoElement.textContent = window.sessionSplitter.algoVersion;
}

if (selectButton) {
  selectButton.addEventListener('click', async () => {
    if (!statusElement || !outputElement) {
      return;
    }
    statusElement.textContent = 'ファイル選択ダイアログを開いています...';
    const filePath = await window.sessionSplitter.selectFile();
    if (!filePath) {
      statusElement.textContent = 'ファイルが選択されませんでした。';
      return;
    }
    statusElement.textContent = `処理中: ${filePath}`;
    const idleTimeout = idleInput?.value ? Number(idleInput.value) : undefined;
    try {
      const result = await window.sessionSplitter.splitFile(filePath, {
        idleTimeoutSeconds: idleTimeout && Number.isFinite(idleTimeout) ? idleTimeout : undefined
      });
      statusElement.textContent = `${result.rows.length} 行を処理しました。`;
      outputElement.textContent = JSON.stringify(result, null, 2);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      statusElement.textContent = `エラー: ${message}`;
    }
  });
}
