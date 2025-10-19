import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, rm, statfs, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import type { BrowserWindow } from 'electron';

import type {
  CommandError,
  CommandResult,
  HealthDiskStatus,
  HealthDirectoryStatus,
  HealthGpuStatus,
  HealthReport,
  LstmCommand,
  ProgressEventPayload
} from '../ipcTypes.js';
import type { BuiltCommand } from './cliArgs.js';

const DEFAULT_PYTHON = process.env.DTLSTM_PYTHON ?? process.env.PYTHON ?? 'python3';
const execFileAsync = promisify(execFile);
const DISK_THRESHOLD_BYTES = 10 * 1024 * 1024 * 1024; // 10 GiB

async function checkDirectoryWritable(path: string): Promise<HealthDirectoryStatus> {
  try {
    await access(path, fsConstants.F_OK);
  } catch {
    return {
      path,
      exists: false,
      writable: false,
      message: 'ディレクトリが存在しません'
    };
  }

  try {
    await access(path, fsConstants.W_OK);
  } catch (error) {
    return {
      path,
      exists: true,
      writable: false,
      message: error instanceof Error ? error.message : '書き込み権限がありません'
    };
  }

  const token = randomBytes(8).toString('hex');
  const testFile = join(path, `.dtlstm-health-${token}`);
  try {
    await writeFile(testFile, 'dt-lstm health check');
    await rm(testFile, { force: true });
    return {
      path,
      exists: true,
      writable: true
    };
  } catch (error) {
    return {
      path,
      exists: true,
      writable: false,
      message: error instanceof Error ? error.message : 'テストファイルの作成に失敗しました'
    };
  }
}

async function checkDiskUsage(targetPath: string): Promise<HealthDiskStatus> {
  try {
    const stats = await statfs(targetPath);
    const freeBytes = stats.bavail * stats.bsize;
    const totalBytes = stats.blocks * stats.bsize;
    const ok = freeBytes >= DISK_THRESHOLD_BYTES;
    const message = ok
      ? undefined
      : `空き容量が不足しています (残り ${(freeBytes / (1024 ** 3)).toFixed(1)} GiB)`;
    return {
      path: targetPath,
      freeBytes,
      totalBytes,
      thresholdBytes: DISK_THRESHOLD_BYTES,
      ok,
      message
    };
  } catch (error) {
    return {
      path: targetPath,
      freeBytes: null,
      totalBytes: null,
      thresholdBytes: DISK_THRESHOLD_BYTES,
      ok: false,
      message: error instanceof Error ? error.message : 'ディスク情報の取得に失敗しました'
    };
  }
}

async function checkGpuMode(): Promise<HealthGpuStatus> {
  const rawMode = (process.env.GPU_MODE ?? '').toLowerCase();
  let mode: 'ada6000' | '4060' | 'cpu' | 'unknown';
  if (rawMode === 'ada6000' || rawMode === '4060') {
    mode = rawMode;
  } else if (rawMode === 'cpu') {
    mode = 'cpu';
  } else {
    mode = 'unknown';
  }

  try {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-gpu=name,index,memory.total',
      '--format=csv,noheader'
    ]);
    const devices = stdout
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const available = devices.length > 0;
    const ok = mode === 'cpu' ? true : available;
    const message = ok
      ? undefined
      : 'GPU_MODE が指定されていますが nvidia-smi で GPU を検出できませんでした';
    return {
      mode,
      available,
      devices,
      cudaVisibleDevices: process.env.CUDA_VISIBLE_DEVICES ?? null,
      message,
      rawOutput: stdout
    };
  } catch (error) {
    const available = false;
    const message =
      mode === 'cpu'
        ? 'CPU モードで実行します (nvidia-smi は不要です)'
        : 'nvidia-smi が見つからないか、GPU 情報の取得に失敗しました';
    return {
      mode,
      available,
      devices: [],
      cudaVisibleDevices: process.env.CUDA_VISIBLE_DEVICES ?? null,
      message,
      error: error instanceof Error ? error.message : '不明なエラー'
    };
  }
}

export async function collectSystemHealth(repoRoot: string): Promise<HealthReport> {
  const directories = await Promise.all(
    ['artifacts', 'outputs', 'logs'].map((relative) =>
      checkDirectoryWritable(join(repoRoot, relative))
    )
  );
  const disk = await checkDiskUsage(repoRoot);
  const gpu = await checkGpuMode();

  const warnings: string[] = [];
  const errors: string[] = [];

  for (const dir of directories) {
    if (!dir.exists) {
      warnings.push(`${dir.path} が存在しません`);
    } else if (!dir.writable) {
      errors.push(`${dir.path} へ書き込みできません: ${dir.message ?? '権限を確認してください'}`);
    }
  }

  if (!disk.ok) {
    errors.push(
      disk.message ?? `${disk.path} の空き容量がしきい値 (${(disk.thresholdBytes / (1024 ** 3)).toFixed(1)} GiB) を下回っています`
    );
  }

  if (!gpu.available && (gpu.mode === 'ada6000' || gpu.mode === '4060')) {
    errors.push(
      gpu.message ??
        `GPU_MODE=${gpu.mode} が設定されていますが GPU を検出できません (CUDA_VISIBLE_DEVICES=${gpu.cudaVisibleDevices ?? '未設定'})`
    );
  } else if (!gpu.available && gpu.mode !== 'cpu') {
    warnings.push(gpu.message ?? 'GPU 情報を取得できませんでした');
  }

  return {
    timestamp: new Date().toISOString(),
    io: { directories },
    disk,
    gpu,
    warnings,
    errors
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    return undefined;
  }
}

function parseLogRecord(line: string): { record?: Record<string, unknown>; message?: unknown } {
  const parsed = parseJson(line);
  if (!parsed || typeof parsed !== 'object') {
    return {};
  }
  const record = parsed as Record<string, unknown>;
  const rawMessage = record.message;
  if (typeof rawMessage === 'string') {
    const trimmed = rawMessage.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      const inner = parseJson(trimmed);
      if (inner !== undefined) {
        return { record, message: inner };
      }
    }
  }
  return { record, message: rawMessage };
}

export class DtLstmProcessRunner {
  private readonly pythonModulePath: string;
  private readonly repoRoot: string;
  private window: BrowserWindow;
  private current: ChildProcess | null = null;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private lastStdout: unknown = undefined;
  private lastProgress: ProgressEventPayload | undefined;
  private pending:
    | {
        readonly command: LstmCommand;
        readonly requestId?: string;
        resolve(value: CommandResult): void;
        reject(error: CommandError): void;
      }
    | null = null;

  constructor(
    window: BrowserWindow,
    projectRoot: string
  ) {
    this.window = window;
    const moduleDir = join(projectRoot, 'packages', 'dt-lstm', 'src');
    this.pythonModulePath = moduleDir;
    this.repoRoot = projectRoot;
  }

  setWindow(window: BrowserWindow): void {
    this.window = window;
  }

  async checkHealth(): Promise<HealthReport> {
    return collectSystemHealth(this.repoRoot);
  }

  run(command: BuiltCommand, requestId?: string): Promise<CommandResult> {
    if (this.current) {
      throw new Error('別の dt-lstm コマンドが実行中です');
    }
    return new Promise<CommandResult>((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { ...process.env, ...command.environment };
      env.PYTHONIOENCODING = 'utf-8';
      const pythonPathParts: string[] = [this.pythonModulePath];
      if (typeof env.PYTHONPATH === 'string' && env.PYTHONPATH.length > 0) {
        pythonPathParts.push(env.PYTHONPATH);
      }
      env.PYTHONPATH = pythonPathParts.join(delimiter);
      const args = ['-m', 'dt_lstm.cli', ...command.args];
      const child = spawn(DEFAULT_PYTHON, args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      this.current = child;
      this.pending = { command: command.command, requestId, resolve, reject };
      this.lastStdout = undefined;
      this.stdoutBuffer = '';
      this.stderrBuffer = '';
      this.emitManagerEvent(command.command, requestId, {
        event: 'command_started',
        args: command.args
      });

      child.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk));
      child.stderr.on('data', (chunk: Buffer) => this.handleStderr(chunk, command.command, requestId));
      child.once('error', (error: Error) => {
        this.emitError(command.command, requestId, error.message);
        this.rejectPending({
          command: command.command,
          requestId,
          exitCode: null,
          signal: null,
          message: error.message,
          lastLog: this.lastProgress
        });
        this.cleanup();
      });
      child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        this.flushStdout();
        if (!this.pending) {
          this.cleanup();
          return;
        }
        if (code === 0) {
          const payload = this.lastStdout ?? null;
          this.pending.resolve({
            command: command.command,
            requestId,
            payload,
            exitCode: 0
          });
        } else {
          const message = code === null ? `dt-lstm がシグナル ${String(signal)} で終了しました` : `dt-lstm が終了コード ${code} で失敗しました`;
          this.pending.reject({
            command: command.command,
            requestId,
            exitCode: code,
            signal,
            message,
            lastLog: this.lastProgress
          });
        }
        this.cleanup();
      });
    });
  }

  cancel(): boolean {
    if (!this.current) {
      return false;
    }
    const cancelled = this.current.kill('SIGTERM');
    if (cancelled && this.pending) {
      this.emitManagerEvent(this.pending.command, this.pending.requestId, {
        event: 'command_cancelled'
      });
    }
    return cancelled;
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString('utf-8');
    let index: number;
    while ((index = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, index);
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const message = parseJson(trimmed);
      if (message !== undefined) {
        this.lastStdout = message;
        this.emitProgress({
          stream: 'stdout',
          raw: trimmed,
          record: typeof message === 'object' && message ? (message as Record<string, unknown>) : undefined,
          message
        });
      } else {
        this.emitProgress({ stream: 'stdout', raw: trimmed });
      }
    }
  }

  private flushStdout(): void {
    const remaining = this.stdoutBuffer.trim();
    this.stdoutBuffer = '';
    if (!remaining) {
      return;
    }
    const message = parseJson(remaining);
    if (message !== undefined) {
      this.lastStdout = message;
      this.emitProgress({
        stream: 'stdout',
        raw: remaining,
        record: typeof message === 'object' && message ? (message as Record<string, unknown>) : undefined,
        message
      });
    } else {
      this.emitProgress({ stream: 'stdout', raw: remaining });
    }
  }

  private handleStderr(chunk: Buffer, command: LstmCommand, requestId?: string): void {
    this.stderrBuffer += chunk.toString('utf-8');
    let index: number;
    while ((index = this.stderrBuffer.indexOf('\n')) >= 0) {
      const line = this.stderrBuffer.slice(0, index);
      this.stderrBuffer = this.stderrBuffer.slice(index + 1);
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const parsed = parseLogRecord(trimmed);
      const payload: ProgressEventPayload = {
        command,
        requestId,
        stream: 'stderr',
        raw: trimmed,
        record: parsed.record,
        message: parsed.message
      };
      this.lastProgress = payload;
      this.safeSend(payload);
    }
  }

  private emitProgress(payload: Omit<ProgressEventPayload, 'command' | 'requestId'>): void {
    if (!this.pending) {
      return;
    }
    const enriched: ProgressEventPayload = {
      command: this.pending.command,
      requestId: this.pending.requestId,
      ...payload
    };
    this.lastProgress = enriched;
    this.safeSend(enriched);
  }

  private emitManagerEvent(command: LstmCommand, requestId: string | undefined, message: unknown): void {
    const payload: ProgressEventPayload = {
      command,
      requestId,
      stream: 'stdout',
      raw: JSON.stringify(message),
      message
    };
    this.lastProgress = payload;
    this.safeSend(payload);
  }

  private emitError(command: LstmCommand, requestId: string | undefined, message: string): void {
    const payload: ProgressEventPayload = {
      command,
      requestId,
      stream: 'stderr',
      raw: message,
      message
    };
    this.lastProgress = payload;
    this.safeSend(payload);
  }

  private rejectPending(error: CommandError): void {
    if (this.pending) {
      this.pending.reject(error);
    }
  }

  private cleanup(): void {
    this.current = null;
    this.pending = null;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
  }

  private safeSend(payload: ProgressEventPayload): void {
    try {
      if (this.window.isDestroyed()) {
        return;
      }
      this.window.webContents.send('lstm.progress', payload);
    } catch (error) {
      // レンダラが存在しない場合でも実行継続
    }
  }
}
