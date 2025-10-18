import { spawn, type ChildProcess } from 'node:child_process';
import { delimiter, join } from 'node:path';
import type { BrowserWindow } from 'electron';

import type {
  CommandError,
  CommandResult,
  LstmCommand,
  ProgressEventPayload
} from '../ipcTypes.js';
import type { BuiltCommand } from './cliArgs.js';

const DEFAULT_PYTHON = process.env.DTLSTM_PYTHON ?? process.env.PYTHON ?? 'python3';

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
  }

  setWindow(window: BrowserWindow): void {
    this.window = window;
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
