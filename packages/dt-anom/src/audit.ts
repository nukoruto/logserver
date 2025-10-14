import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { nowIso } from './utils.js';

export interface AuditRecord {
  readonly timestamp: string;
  readonly row: number;
  readonly value: number;
  readonly threshold: number;
  readonly tailProbability: number;
  readonly score: number;
  readonly flagged: boolean;
  readonly metadata: Record<string, unknown>;
}

export class SpotAuditLogger {
  private readonly stream: Writable;
  private closed = false;

  constructor(path: string) {
    this.stream = createWriteStream(path, { encoding: 'utf8' });
  }

  write(record: Omit<AuditRecord, 'timestamp'> & { timestamp?: string }): void {
    if (this.closed) {
      throw new Error('Audit logger already closed');
    }
    const output: AuditRecord = {
      timestamp: record.timestamp ?? nowIso(),
      row: record.row,
      value: record.value,
      threshold: record.threshold,
      tailProbability: record.tailProbability,
      score: record.score,
      flagged: record.flagged,
      metadata: record.metadata
    };
    this.stream.write(`${JSON.stringify(output)}\n`);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.stream.end();
    await once(this.stream, 'close');
    this.closed = true;
  }
}
