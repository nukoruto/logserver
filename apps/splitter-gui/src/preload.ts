import { contextBridge, ipcRenderer } from 'electron';
import { algoVersion, SessionSplitOptions, AugmentedRow, ThresholdDetail } from '@logserver/session-splitter';

type PreviewRequest = {
  filePath: string;
  options?: Partial<SessionSplitOptions>;
  selectedUser?: string | null;
  overrideDeltaT?: number | null;
};

type PreviewResponse = {
  filePath: string;
  algoVersion: string;
  users: string[];
  selectedUser: string | null;
  defaultDeltaT: number | null;
  appliedDeltaT: number | null;
  histogram: {
    binEdges: number[];
    binCounts: number[];
    domain: { min: number; max: number; logMin: number; logMax: number };
    tauOtsu: number | null;
    tauKnee: number | null;
    tauFinal: number | null;
  };
  sessionCurve: {
    thresholds: number[];
    counts: number[];
    knee: number | null;
  };
  thresholdsByUser: Record<string, number>;
  perUserDetail: Record<string, ThresholdDetail>;
  previewRows: AugmentedRow[];
};

type ExportResult = {
  canceled: boolean;
  output?: { rowsPath: string; thresholdsPath: string; metaPath: string };
};

contextBridge.exposeInMainWorld('sessionSplitter', {
  algoVersion,
  selectFile: async (): Promise<string | null> => {
    const filePath = await ipcRenderer.invoke('split/select-file');
    return (filePath as string | null) ?? null;
  },
  preview: async (payload: PreviewRequest): Promise<PreviewResponse> => {
    const response = await ipcRenderer.invoke('split/preview', payload);
    return response as PreviewResponse;
  },
  export: async (payload: PreviewRequest & { outputDir?: string | null }): Promise<ExportResult> => {
    const response = await ipcRenderer.invoke('split/export', payload);
    return response as ExportResult;
  }
});
