import { contextBridge, ipcRenderer } from 'electron';
import { algoVersion, SessionSplitOptions, AugmentedRow } from '@logserver/session-splitter';

contextBridge.exposeInMainWorld('sessionSplitter', {
  algoVersion,
  selectFile: async (): Promise<string | null> => {
    const filePath = await ipcRenderer.invoke('session-splitter:select-file');
    return filePath ?? null;
  },
  splitFile: async (
    filePath: string,
    options: Partial<SessionSplitOptions> = {}
  ): Promise<{ algo_ver: typeof algoVersion; rows: AugmentedRow[]; thresholds: Record<string, number> }> => {
    const result = await ipcRenderer.invoke('session-splitter:split-file', filePath, options);
    return result as {
      algo_ver: typeof algoVersion;
      rows: AugmentedRow[];
      thresholds: Record<string, number>;
    };
  }
});
