export type LstmCommand = 'fit' | 'train' | 'calibrate' | 'infer' | 'online';

interface CommandBase {
  readonly requestId?: string;
  readonly environment?: Record<string, string>;
}

export interface FitRequest extends CommandBase {
  readonly cfg?: Partial<{ seed: number }>;
  readonly paths: {
    readonly inputs: string[];
    readonly vocabOut: string;
    readonly metaOut: string;
  };
}

export interface TrainRequest extends CommandBase {
  readonly cfg?: Partial<{
    seed: number;
    arch: 'lstm' | 'phased_lstm';
    timeHead: 'regression' | 'rmtpp';
    timeObjective: 'l1' | 'huber' | 'nll' | 'rmtpp';
    embeddingDim: number;
    hiddenSize: number;
    layers: number;
    dropout: number;
    mlpHidden: number[];
    mlpActivation: 'relu' | 'gelu' | 'silu';
    mlpDropout: number;
    deltaIndex: number;
    rmtppEps: number;
    epochs: number;
    batchSize: number;
    learningRate: number;
    minLearningRate: number;
    scheduler: 'none' | 'cosine';
    earlyStopping: number;
    clipGrad: number;
    ampLevel: 'off' | 'O0' | 'O1';
    scheduledSampling: number;
    uncertaintyWeight: boolean;
    focalGamma: number | null;
    labelSmoothing: number;
    numWorkers: number;
    gpuMode: 'ada6000' | '4060';
  }>;
  readonly paths: {
    readonly train: string[];
    readonly val?: string[] | null;
    readonly vocab?: string | null;
    readonly classWeights?: string | null;
    readonly outDir: string;
  };
  readonly numericColumns?: string[];
  readonly deltaColumn?: string;
  readonly idleTimeout?: number;
}

export interface CalibrateRequest extends CommandBase {
  readonly cfg?: Partial<{
    seed: number;
    batchSize: number;
    bins: number;
    maxK: number;
    gpuMode: 'ada6000' | '4060';
  }>;
  readonly paths: {
    readonly val: string[];
    readonly checkpoint: string;
    readonly output: string;
  };
}

export interface InferRequest extends CommandBase {
  readonly cfg?: Partial<{
    seed: number;
    topk: number;
    gpuMode: 'ada6000' | '4060';
  }>;
  readonly paths: {
    readonly inputs: string[];
    readonly checkpoint?: string | null;
    readonly bundle?: string | null;
    readonly calibration?: string | null;
    readonly output: string;
    readonly audit?: string | null;
  };
}

export interface OnlineRequest extends CommandBase {
  readonly cfg?: Partial<{
    seed: number;
    q: number;
    kofn: string;
    hysteresis: number;
    gpuMode: 'ada6000' | '4060';
  }>;
  readonly paths: {
    readonly stream: string;
    readonly checkpoint: string;
    readonly calibration?: string | null;
    readonly output: string;
    readonly audit?: string | null;
  };
}

export type LstmRequest =
  | FitRequest
  | TrainRequest
  | CalibrateRequest
  | InferRequest
  | OnlineRequest;

export interface ProgressEventPayload {
  readonly command: LstmCommand;
  readonly requestId?: string;
  readonly stream: 'stdout' | 'stderr';
  readonly raw: string;
  readonly record?: Record<string, unknown>;
  readonly message?: unknown;
}

export interface CommandResult {
  readonly command: LstmCommand;
  readonly requestId?: string;
  readonly payload: unknown;
  readonly exitCode: number;
}

export interface CommandError {
  readonly command: LstmCommand;
  readonly requestId?: string;
  readonly exitCode: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly message: string;
  readonly lastLog?: ProgressEventPayload;
}

export interface HealthDirectoryStatus {
  readonly path: string;
  readonly exists: boolean;
  readonly writable: boolean;
  readonly message?: string;
}

export interface HealthDiskStatus {
  readonly path: string;
  readonly freeBytes: number | null;
  readonly totalBytes: number | null;
  readonly thresholdBytes: number;
  readonly ok: boolean;
  readonly message?: string;
}

export interface HealthGpuStatus {
  readonly mode: 'ada6000' | '4060' | 'cpu' | 'unknown';
  readonly available: boolean;
  readonly devices: string[];
  readonly cudaVisibleDevices: string | null;
  readonly message?: string;
  readonly error?: string;
  readonly rawOutput?: string;
}

export interface HealthReport {
  readonly timestamp: string;
  readonly io: {
    readonly directories: HealthDirectoryStatus[];
  };
  readonly disk: HealthDiskStatus;
  readonly gpu: HealthGpuStatus;
  readonly warnings: string[];
  readonly errors: string[];
}
