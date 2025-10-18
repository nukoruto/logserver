import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  buildCalibrateCommand,
  buildFitCommand,
  buildInferCommand,
  buildOnlineCommand,
  buildTrainCommand
} from '../src/python/cliArgs.js';

void test('buildFitCommand requires inputs and outputs', () => {
  assert.throws(() => buildFitCommand({ paths: { inputs: [], vocabOut: '', metaOut: '' } }), /fit\.inputs/);
  const command = buildFitCommand({ paths: { inputs: ['a.csv'], vocabOut: 'v.json', metaOut: 'm.json' } });
  assert.equal(command.command, 'fit');
  assert.deepEqual(command.args, ['fit', '--in', 'a.csv', '--vocab-out', 'v.json', '--cfg-out', 'm.json']);
});

void test('buildTrainCommand maps optional parameters', () => {
  const command = buildTrainCommand({
    paths: {
      train: ['train.csv'],
      val: ['val.csv'],
      vocab: 'vocab.json',
      classWeights: 'weights.json',
      outDir: 'out'
    },
    numericColumns: ['c1', 'c2'],
    deltaColumn: 'dt',
    idleTimeout: 1200,
    cfg: {
      seed: 7,
      arch: 'phased_lstm',
      timeHead: 'rmtpp',
      timeObjective: 'rmtpp',
      embeddingDim: 256,
      hiddenSize: 128,
      layers: 2,
      dropout: 0.3,
      mlpHidden: [64, 32],
      mlpActivation: 'relu',
      mlpDropout: 0.1,
      deltaIndex: 1,
      rmtppEps: 1e-5,
      epochs: 50,
      batchSize: 32,
      learningRate: 0.001,
      minLearningRate: 1e-5,
      scheduler: 'cosine',
      earlyStopping: 5,
      clipGrad: 0.5,
      ampLevel: 'O1',
      scheduledSampling: 0.2,
      uncertaintyWeight: true,
      focalGamma: 2,
      labelSmoothing: 0.1,
      numWorkers: 4,
      gpuMode: 'ada6000'
    }
  });
  assert.equal(command.command, 'train');
  assert.ok(command.environment.GPU_MODE === 'ada6000');
  assert.ok(command.args.includes('--train'));
  assert.ok(command.args.includes('--val'));
  assert.ok(command.args.includes('--vocab'));
  assert.ok(command.args.includes('--class-weights'));
  assert.ok(command.args.includes('--numeric-cols'));
  assert.ok(command.args.includes('--delta-col'));
  assert.ok(command.args.includes('--idle-timeout'));
  assert.ok(command.args.includes('--epochs'));
  assert.ok(command.args.includes('--amp'));
});

void test('buildInferCommand requires checkpoint or bundle', () => {
  assert.throws(() => buildInferCommand({ paths: { inputs: ['a'], output: 'out.csv' } }), /checkpoint/);
  const command = buildInferCommand({
    paths: {
      inputs: ['a.csv'],
      output: 'scores.csv',
      checkpoint: 'model.pt',
      calibration: 'calib.json',
      audit: 'audit.jsonl'
    },
    cfg: { topk: 3, seed: 1, gpuMode: '4060' }
  });
  assert.equal(command.command, 'infer');
  assert.ok(command.args.includes('--ckpt'));
  assert.ok(command.args.includes('--calib'));
  assert.ok(command.args.includes('--audit'));
  assert.ok(command.args.includes('--topk'));
  assert.equal(command.environment.GPU_MODE, '4060');
});

void test('buildOnlineCommand wires optional parameters', () => {
  const command = buildOnlineCommand({
    paths: {
      stream: 'stream.csv',
      checkpoint: 'model.pt',
      calibration: 'calib.json',
      output: 'online.csv',
      audit: 'audit.jsonl'
    },
    cfg: {
      seed: 9,
      q: 0.02,
      kofn: '2/3',
      hysteresis: 1.2,
      gpuMode: 'ada6000'
    }
  });
  assert.equal(command.command, 'online');
  assert.ok(command.args.includes('--stream'));
  assert.ok(command.args.includes('--q'));
  assert.ok(command.args.includes('--kofn'));
  assert.ok(command.args.includes('--hysteresis'));
  assert.equal(command.environment.GPU_MODE, 'ada6000');
});

void test('buildCalibrateCommand validates inputs', () => {
  assert.throws(() => buildCalibrateCommand({ paths: { val: [], checkpoint: '', output: '' } }), /calibrate\.val/);
  const command = buildCalibrateCommand({
    paths: { val: ['val.csv'], checkpoint: 'model.pt', output: 'calib.json' },
    cfg: { bins: 20, batchSize: 64, maxK: 10, seed: 3, gpuMode: '4060' }
  });
  assert.equal(command.command, 'calibrate');
  assert.ok(command.args.includes('--bins'));
  assert.ok(command.args.includes('--batch-size'));
  assert.ok(command.args.includes('--max-k'));
  assert.equal(command.environment.GPU_MODE, '4060');
});
