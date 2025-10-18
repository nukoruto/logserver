import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

describe('audit CLI', () => {
  const collectorDir = path.resolve(__dirname, '../..');
  const repoRoot = path.resolve(collectorDir, '..');
  const scriptPath = path.resolve(repoRoot, 'scripts/audit.ts');

  const runAudit = (args: string[], cwd = collectorDir) => {
    return spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', scriptPath, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env },
    });
  };

  it('passes on valid CSV input', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'audit-ok-'));
    try {
      const filePath = path.join(dir, '2024-01-01.csv');
      const metaPath = path.join(dir, 'meta.json');
      const header = [
        'timestamp_utc',
        'uid',
        'session_id',
        'method',
        'path',
        'referer',
        'user_agent',
        'ip',
        'op_category',
        'status_code',
        'latency_ms',
        'metadata',
        'dt_sec',
        'DeltaT',
        'time_label',
        'sid_final',
      ].join(',');
      const rows = [
        '2024-01-01T00:00:00.000Z,uid-1,session,GET,/health,null,"Mozilla/5.0",127.0.0.1,READ,200,1.23,"{\"DeltaT\":30}",,30,ok,s-final-1',
        '2024-01-01T00:00:10.000Z,uid-1,session,GET,/health,https://app.simulated.local/health,"Mozilla/5.0",127.0.0.1,READ,200,1.23,"{\"DeltaT\":30}",10,30,ok,s-final-1',
        '2024-01-01T00:01:00.000Z,uid-1,session,GET,/health,https://app.simulated.local/dashboard,"Mozilla/5.0",127.0.0.1,READ,200,1.23,"{\"DeltaT\":30}",60,30,ok,s-final-2',
      ];
      writeFileSync(filePath, `${header}\n${rows.join('\n')}\n`, 'utf8');
      writeFileSync(
        metaPath,
        JSON.stringify(
          {
            DeltaT: { 'uid-1': 30 },
            tau_otsu: { 'uid-1': Math.log(25) },
            tau_knee: { 'uid-1': Math.log(30) },
            tau_final: { 'uid-1': Math.log(30) },
          },
          null,
          2
        ),
        'utf8'
      );

      const result = runAudit(['--dir', dir, '--fail-on-error']);
      expect(result.status).toBe(0);
      const summary = JSON.parse(result.stdout.trim().split('\n').pop() ?? '{}');
      expect(summary.findings).toBe(0);
      expect(summary.sid_final_transition_checks).toBe(1);
      expect(summary.per_uid_delta_t['uid-1']).toBeCloseTo(30);
      expect(summary.method_usage.knee).toBe(1);
      expect(summary.unknown_time_label_ratio).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when encountering invalid values with --fail-on-error', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'audit-bad-'));
    try {
      const filePath = path.join(dir, '2024-01-01.csv');
      const metaPath = path.join(dir, 'meta.json');
      const header = [
        'timestamp_utc',
        'uid',
        'session_id',
        'method',
        'path',
        'referer',
        'user_agent',
        'ip',
        'op_category',
        'status_code',
        'latency_ms',
        'metadata',
        'dt_sec',
        'DeltaT',
        'time_label',
        'sid_final',
      ].join(',');
      const rows = [
        '2024-01-01T00:00:00.000Z,uid-1,session,GET,/health,null,"Mozilla/5.0",127.0.0.1,READ,200,1.23,"{\"DeltaT\":30}",,30,ok,s-final-1',
        '2024-01-01T00:00:10.000Z,uid-1,session,GET,/health,https://app.simulated.local/health,"Mozilla/5.0",127.0.0.1,READ,200,1.23,"{\"DeltaT\":30}",10,30,ok,s-final-1',
        '2024-01-01T00:00:20.000Z,uid-1,session,GET,/health,https://app.simulated.local/dashboard,"Mozilla/5.0",127.0.0.1,READ,200,1.23,"{\"DeltaT\":30}",5,30,ok,s-final-2',
      ];
      writeFileSync(filePath, `${header}\n${rows.join('\n')}\n`, 'utf8');
      writeFileSync(
        metaPath,
        JSON.stringify(
          {
            DeltaT: { 'uid-1': 30 },
            tau_otsu: { 'uid-1': Math.log(30) },
            tau_knee: { 'uid-1': Math.log(30) },
            tau_final: { 'uid-1': Math.log(30) },
          },
          null,
          2
        ),
        'utf8'
      );

      const result = runAudit(['--dir', dir, '--fail-on-error']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('sid_final changed without exceeding ΔT');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when schema columns are missing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'audit-schema-'));
    try {
      const filePath = path.join(dir, '2024-01-02.csv');
      const header = [
        'timestamp_utc',
        'uid',
        'session_id',
        'method',
        'path',
        'referer',
        'ip',
        'op_category',
        'status_code',
        'latency_ms',
        'metadata',
        'dt_sec',
        'DeltaT',
        'time_label',
        'sid_final',
      ].join(',');
      const rows = [
        '2024-01-02T00:00:00.000Z,uid-1,session,GET,/health,null,127.0.0.1,READ,200,1.0,"{}",,30,ok,s-final-1',
      ];
      writeFileSync(filePath, `${header}\n${rows.join('\n')}\n`, 'utf8');

      const result = runAudit(['--dir', dir, '--fail-on-error']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Missing column user_agent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
