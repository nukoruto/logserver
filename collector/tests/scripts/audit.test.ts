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
      const header = 'timestamp_utc,uid,session_id,method,path,referer,user_agent,ip,op_category,status_code,latency_ms';
      const row = '2024-01-01T00:00:00.000Z,uid,session,GET,/health,,agent,127.0.0.1,READ,200,1.23';
      writeFileSync(filePath, `${header}\n${row}\n`, 'utf8');

      const result = runAudit(['--dir', dir, '--fail-on-error']);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('"findings":0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when encountering invalid values with --fail-on-error', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'audit-bad-'));
    try {
      const filePath = path.join(dir, '2024-01-01.csv');
      const header = 'timestamp_utc,uid,session_id,method,path,referer,user_agent,ip,op_category,status_code,latency_ms';
      const row = 'invalid,uid,session,FETCH,/health,,agent,127.0.0.1,UNKNOWN,200,1.23';
      writeFileSync(filePath, `${header}\n${row}\n`, 'utf8');

      const result = runAudit(['--dir', dir, '--fail-on-error']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Invalid HTTP method');
      expect(result.stderr).toContain('Invalid op_category');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
