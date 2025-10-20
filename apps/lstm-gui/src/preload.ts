import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

import type {
  CalibrateRequest,
  FitRequest,
  HealthReport,
  InferRequest,
  OnlineRequest,
  ProgressEventPayload,
  TrainRequest
} from './ipcTypes.js';

const api = {
  fit: (request: FitRequest) => ipcRenderer.invoke('lstm.fit', request),
  train: (request: TrainRequest) => ipcRenderer.invoke('lstm.train', request),
  calibrate: (request: CalibrateRequest) => ipcRenderer.invoke('lstm.calibrate', request),
  infer: (request: InferRequest) => ipcRenderer.invoke('lstm.infer', request),
  online: (request: OnlineRequest) => ipcRenderer.invoke('lstm.online', request),
  cancel: () => ipcRenderer.invoke('lstm.cancel'),
  health: () => ipcRenderer.invoke('lstm.health'),
  onProgress: (callback: (payload: ProgressEventPayload) => void) => {
    const handler = (_event: IpcRendererEvent, payload: ProgressEventPayload) => {
      callback(payload);
    };
    ipcRenderer.on('lstm.progress', handler);
    return () => {
      ipcRenderer.removeListener('lstm.progress', handler);
    };
  },
  onHealth: (callback: (report: HealthReport) => void) => {
    const handler = (_event: IpcRendererEvent, payload: HealthReport) => {
      callback(payload);
    };
    ipcRenderer.on('lstm.health.result', handler);
    return () => {
      ipcRenderer.removeListener('lstm.health.result', handler);
    };
  }
};

contextBridge.exposeInMainWorld('dtLstm', api);

declare global {
  interface Window {
    dtLstm: typeof api;
  }
}
