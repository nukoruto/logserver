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
        'cookie',
        'op_category',
        'latency_ms',
        'metadata',
        'dt_sec',
        'DeltaT',
        'time_label',
        'sid_final',
      ].join(',');
      const rows = [
        '1704067200,uid-1,session,GET,/health,null,"Mozilla/5.0",127.0.0.1,"sid=uid-1.001; HttpOnly",READ,1.23,"{\"DeltaT\":30}",,30,ok,s-final-1',
        '1704067210,uid-1,session,GET,/health,https://app.simulated.local/health,"Mozilla/5.0",127.0.0.1,"sid=uid-1.001; HttpOnly",READ,1.23,"{\"DeltaT\":30}",10,30,ok,s-final-1',
        '1704067260,uid-1,session,GET,/health,https://app.simulated.local/dashboard,"Mozilla/5.0",127.0.0.1,"sid=uid-1.002; HttpOnly",READ,1.23,"{\"DeltaT\":30}",60,30,ok,s-final-2',
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
        'cookie',
        'op_category',
        'latency_ms',
        'metadata',
        'dt_sec',
        'DeltaT',
        'time_label',
        'sid_final',
      ].join(',');
      const rows = [
        '1704067200,uid-1,session,GET,/health,null,"Mozilla/5.0",127.0.0.1,"sid=uid-1.001; HttpOnly",READ,1.23,"{\"DeltaT\":30}",,30,ok,s-final-1',
        '1704067210,uid-1,session,GET,/health,https://app.simulated.local/health,"Mozilla/5.0",127.0.0.1,"sid=uid-1.001; HttpOnly",READ,1.23,"{\"DeltaT\":30}",10,30,ok,s-final-1',
        '1704067220,uid-1,session,GET,/health,https://app.simulated.local/dashboard,"Mozilla/5.0",127.0.0.1,"sid=uid-1.002; HttpOnly",READ,1.23,"{\"DeltaT\":30}",5,30,ok,s-final-2',
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

  it('rejects CSV rows that leak authorization data in metadata', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'audit-metadata-'));
    try {
      const filePath = path.join(dir, '2024-01-05.csv');
      const header = [
        'timestamp_utc',
        'uid',
        'session_id',
        'method',
        'path',
        'referer',
        'user_agent',
        'ip',
        'cookie',
        'op_category',
        'latency_ms',
        'metadata',
        'dt_sec',
        'sid_final',
      ].join(',');
      const rows = [
        '1704499200,uid-5,session,GET,/secure,null,"Mozilla/5.0",127.0.0.1,"sid=uid-5.001; HttpOnly",READ,1.23,"{""headers"":{""Authorization"":""Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fake.payload.signature""}}",10,s-final-1',
      ];
      writeFileSync(filePath, `${header}\n${rows.join('\n')}\n`, 'utf8');

      const result = runAudit(['--dir', dir, '--fail-on-error']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('metadata contains forbidden authorization/cookie/token fields');
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
        'cookie',
        'op_category',
        'latency_ms',
        'metadata',
        'dt_sec',
        'DeltaT',
        'time_label',
        'sid_final',
      ].join(',');
      const rows = [
        '1704153600,uid-1,session,GET,/health,null,127.0.0.1,"sid=uid-1.003; HttpOnly",READ,200,1.0,"{}",,30,ok,s-final-1',
      ];
      writeFileSync(filePath, `${header}\n${rows.join('\n')}\n`, 'utf8');

      const result = runAudit(['--dir', dir, '--fail-on-error']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Missing column user_agent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports unexpected columns when not allow-listed', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'audit-unexpected-'));
    try {
      const filePath = path.join(dir, '2024-01-03.csv');
      const header = [
        'timestamp_utc',
        'uid',
        'session_id',
        'method',
        'path',
        'referer',
        'user_agent',
        'ip',
        'cookie',
        'op_category',
        'latency_ms',
        'metadata',
        'dt_sec',
        'DeltaT',
        'time_label',
        'sid_final',
        'unexpected_field',
      ].join(',');
      const rows = [
        '1704240000,uid-1,session,GET,/health,null,"Mozilla/5.0",127.0.0.1,"sid=uid-1.004; HttpOnly",READ,1.23,"{}",,30,ok,s-final-1,extra',
      ];
      writeFileSync(filePath, `${header}\n${rows.join('\n')}\n`, 'utf8');

      const result = runAudit(['--dir', dir]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Unexpected column unexpected_field');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validates derived status_code when enabled', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'audit-derived-'));
    try {
      const filePath = path.join(dir, '2024-01-04.csv');
      const header = [
        'timestamp_utc',
        'uid',
        'session_id',
        'method',
        'path',
        'referer',
        'user_agent',
        'ip',
        'cookie',
        'op_category',
        'latency_ms',
        'metadata',
        'dt_sec',
        'DeltaT',
        'time_label',
        'sid_final',
        'status_code',
      ].join(',');
      const rows = [
        '1704326400,uid-1,session,GET,/health,null,"Mozilla/5.0",127.0.0.1,"sid=uid-1.005; HttpOnly",READ,1.23,"{}",,30,ok,s-final-1,abc',
      ];
      writeFileSync(filePath, `${header}\n${rows.join('\n')}\n`, 'utf8');

      const result = runAudit(['--dir', dir, '--allow-derived']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Invalid status_code: abc');

      const resultWithoutDerived = runAudit(['--dir', dir]);
      expect(resultWithoutDerived.status).toBe(1);
      expect(resultWithoutDerived.stderr).toContain('Unexpected column status_code');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
