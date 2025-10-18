import type {
  CalibrateRequest,
  FitRequest,
  InferRequest,
  LstmCommand,
  OnlineRequest,
  TrainRequest
} from '../ipcTypes.js';

export interface BuiltCommand {
  readonly command: LstmCommand;
  readonly args: string[];
  readonly environment: Record<string, string>;
}

function buildBaseEnvironment(requestEnv: Record<string, string> | undefined, gpuMode: string | undefined): Record<string, string> {
  const env: Record<string, string> = { ...requestEnv };
  if (gpuMode) {
    env.GPU_MODE = gpuMode;
  }
  return env;
}

export function buildFitCommand(request: FitRequest): BuiltCommand {
  const { paths, cfg } = request;
  if (!paths.inputs || paths.inputs.length === 0) {
    throw new Error('fit.inputs が指定されていません');
  }
  if (!paths.vocabOut) {
    throw new Error('fit.vocabOut が指定されていません');
  }
  if (!paths.metaOut) {
    throw new Error('fit.metaOut が指定されていません');
  }
  const args: string[] = ['fit', '--in', ...paths.inputs, '--vocab-out', paths.vocabOut, '--cfg-out', paths.metaOut];
  if (cfg?.seed !== undefined) {
    args.push('--seed', String(cfg.seed));
  }
  return {
    command: 'fit',
    args,
    environment: buildBaseEnvironment(request.environment, undefined)
  };
}

export function buildTrainCommand(request: TrainRequest): BuiltCommand {
  const { paths, cfg } = request;
  if (!paths.train || paths.train.length === 0) {
    throw new Error('train.train が指定されていません');
  }
  if (!paths.outDir) {
    throw new Error('train.outDir が指定されていません');
  }
  const args: string[] = ['train', '--train', ...paths.train];
  if (paths.val && paths.val.length > 0) {
    args.push('--val', ...paths.val);
  }
  if (request.numericColumns && request.numericColumns.length > 0) {
    args.push('--numeric-cols', ...request.numericColumns);
  }
  if (request.deltaColumn) {
    args.push('--delta-col', request.deltaColumn);
  }
  if (paths.vocab) {
    args.push('--vocab', paths.vocab);
  }
  if (typeof request.idleTimeout === 'number') {
    args.push('--idle-timeout', String(request.idleTimeout));
  }
  if (cfg?.arch) {
    args.push('--arch', cfg.arch);
  }
  if (cfg?.timeHead) {
    args.push('--time-head', cfg.timeHead);
  }
  if (cfg?.timeObjective) {
    args.push('--time-objective', cfg.timeObjective);
  }
  if (cfg?.embeddingDim !== undefined) {
    args.push('--emb-dim', String(cfg.embeddingDim));
  }
  if (cfg?.hiddenSize !== undefined) {
    args.push('--hidden', String(cfg.hiddenSize));
  }
  if (cfg?.layers !== undefined) {
    args.push('--layers', String(cfg.layers));
  }
  if (cfg?.dropout !== undefined) {
    args.push('--dropout', String(cfg.dropout));
  }
  if (cfg?.mlpHidden && cfg.mlpHidden.length > 0) {
    args.push('--mlp-hidden', ...cfg.mlpHidden.map((value) => String(value)));
  }
  if (cfg?.mlpActivation) {
    args.push('--mlp-activation', cfg.mlpActivation);
  }
  if (cfg?.mlpDropout !== undefined) {
    args.push('--mlp-dropout', String(cfg.mlpDropout));
  }
  if (cfg?.deltaIndex !== undefined) {
    args.push('--delta-index', String(cfg.deltaIndex));
  }
  if (cfg?.rmtppEps !== undefined) {
    args.push('--rmtpp-eps', String(cfg.rmtppEps));
  }
  if (cfg?.epochs !== undefined) {
    args.push('--epochs', String(cfg.epochs));
  }
  if (cfg?.batchSize !== undefined) {
    args.push('--bs', String(cfg.batchSize));
  }
  if (cfg?.learningRate !== undefined) {
    args.push('--lr', String(cfg.learningRate));
  }
  if (cfg?.minLearningRate !== undefined) {
    args.push('--min-lr', String(cfg.minLearningRate));
  }
  if (cfg?.scheduler) {
    args.push('--scheduler', cfg.scheduler);
  }
  if (cfg?.earlyStopping !== undefined) {
    args.push('--early', String(cfg.earlyStopping));
  }
  if (cfg?.clipGrad !== undefined) {
    args.push('--clip-grad', String(cfg.clipGrad));
  }
  if (cfg?.ampLevel) {
    args.push('--amp', cfg.ampLevel);
  }
  if (cfg?.scheduledSampling !== undefined) {
    args.push('--scheduled-sampling', String(cfg.scheduledSampling));
  }
  if (cfg?.uncertaintyWeight !== undefined) {
    args.push('--uncertainty-weight', cfg.uncertaintyWeight ? 'on' : 'off');
  }
  if (cfg?.focalGamma !== undefined && cfg.focalGamma !== null) {
    args.push('--focal-gamma', String(cfg.focalGamma));
  }
  if (cfg?.labelSmoothing !== undefined) {
    args.push('--label-smoothing', String(cfg.labelSmoothing));
  }
  if (cfg?.numWorkers !== undefined) {
    const workers = Math.max(0, Math.floor(cfg.numWorkers));
    args.push('--num-workers', String(workers));
  }
  if (paths.classWeights) {
    args.push('--class-weights', paths.classWeights);
  }
  if (cfg?.seed !== undefined) {
    args.push('--seed', String(cfg.seed));
  }
  args.push('--out', paths.outDir);
  const gpuMode = cfg?.gpuMode;
  return {
    command: 'train',
    args,
    environment: buildBaseEnvironment(request.environment, gpuMode)
  };
}

export function buildCalibrateCommand(request: CalibrateRequest): BuiltCommand {
  const { paths, cfg } = request;
  if (!paths.val || paths.val.length === 0) {
    throw new Error('calibrate.val が指定されていません');
  }
  if (!paths.checkpoint) {
    throw new Error('calibrate.checkpoint が指定されていません');
  }
  if (!paths.output) {
    throw new Error('calibrate.output が指定されていません');
  }
  const args: string[] = ['calibrate', '--val', ...paths.val, '--ckpt', paths.checkpoint, '--out', paths.output];
  if (cfg?.batchSize !== undefined) {
    args.push('--batch-size', String(cfg.batchSize));
  }
  if (cfg?.bins !== undefined) {
    args.push('--bins', String(cfg.bins));
  }
  if (cfg?.maxK !== undefined) {
    args.push('--max-k', String(cfg.maxK));
  }
  if (cfg?.seed !== undefined) {
    args.push('--seed', String(cfg.seed));
  }
  return {
    command: 'calibrate',
    args,
    environment: buildBaseEnvironment(request.environment, cfg?.gpuMode)
  };
}

export function buildInferCommand(request: InferRequest): BuiltCommand {
  const { paths, cfg } = request;
  if (!paths.inputs || paths.inputs.length === 0) {
    throw new Error('infer.inputs が指定されていません');
  }
  if (!paths.output) {
    throw new Error('infer.output が指定されていません');
  }
  if (!paths.checkpoint && !paths.bundle) {
    throw new Error('infer には checkpoint か bundle のいずれかが必要です');
  }
  const args: string[] = ['infer', '--in', ...paths.inputs];
  if (paths.checkpoint) {
    args.push('--ckpt', paths.checkpoint);
  }
  if (paths.bundle) {
    args.push('--bundle', paths.bundle);
  }
  if (paths.calibration) {
    args.push('--calib', paths.calibration);
  }
  if (paths.audit) {
    args.push('--audit', paths.audit);
  }
  if (cfg?.topk !== undefined) {
    args.push('--topk', String(cfg.topk));
  }
  if (cfg?.seed !== undefined) {
    args.push('--seed', String(cfg.seed));
  }
  args.push('--out', paths.output);
  return {
    command: 'infer',
    args,
    environment: buildBaseEnvironment(request.environment, cfg?.gpuMode)
  };
}

export function buildOnlineCommand(request: OnlineRequest): BuiltCommand {
  const { paths, cfg } = request;
  if (!paths.stream) {
    throw new Error('online.stream が指定されていません');
  }
  if (!paths.checkpoint) {
    throw new Error('online.checkpoint が指定されていません');
  }
  if (!paths.output) {
    throw new Error('online.output が指定されていません');
  }
  const args: string[] = ['online', '--stream', paths.stream, '--ckpt', paths.checkpoint, '--out', paths.output];
  if (paths.calibration) {
    args.push('--calib', paths.calibration);
  }
  if (paths.audit) {
    args.push('--audit', paths.audit);
  }
  if (cfg?.q !== undefined) {
    args.push('--q', String(cfg.q));
  }
  if (cfg?.kofn) {
    args.push('--kofn', cfg.kofn);
  }
  if (cfg?.hysteresis !== undefined) {
    args.push('--hysteresis', String(cfg.hysteresis));
  }
  if (cfg?.seed !== undefined) {
    args.push('--seed', String(cfg.seed));
  }
  return {
    command: 'online',
    args,
    environment: buildBaseEnvironment(request.environment, cfg?.gpuMode)
  };
}
