import * as childProcess from 'node:child_process';

type ExecFileException = childProcess.ExecFileException;

type ExecResult = {
  stdout: string;
  stderr: string;
};

const CHRONYC_COMMAND = 'chronyc' as const;
const CHRONYC_ARGS: readonly string[] = ['tracking'];
const NTPSTAT_COMMAND = 'ntpstat' as const;

const CHRONYC_OFFSET_PATTERN = /(last offset|system time)\s*:\s*([-+]?\d+(?:\.\d+)?)\s*seconds/iu;
const NTPSTAT_OFFSET_PATTERN = /time correct to within\s+([-+]?\d+(?:\.\d+)?)\s*ms/iu;

const toMilliseconds = (value: number): number => Math.abs(value) * 1000;

const parseChronycTracking = (stdout: string): number | null => {
  const lines = stdout.split(/\r?\n/);
  let lastOffset: number | null = null;
  let systemTime: number | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const match = line.match(CHRONYC_OFFSET_PATTERN);
    if (match) {
      const label = match[1];
      const value = match[2];
      const parsed = Number.parseFloat(value);
      if (!Number.isFinite(parsed)) {
        continue;
      }
      if (label.toLowerCase().startsWith('last offset')) {
        lastOffset = toMilliseconds(parsed);
      } else if (label.toLowerCase().startsWith('system time')) {
        systemTime = toMilliseconds(parsed);
      }
    }
  }

  if (lastOffset !== null) {
    return lastOffset;
  }
  if (systemTime !== null) {
    return systemTime;
  }
  return null;
};

const parseNtpstat = (stdout: string): number | null => {
  if (/unsynchronised/iu.test(stdout)) {
    return null;
  }
  const match = stdout.match(NTPSTAT_OFFSET_PATTERN);
  if (!match) {
    return null;
  }
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.abs(value);
};

const execFileAsync = (command: string, args: readonly string[]): Promise<ExecResult> =>
  new Promise((resolve, reject) => {
    childProcess.execFile(command, Array.from(args), (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => {
      if (error) {
        reject(error);
        return;
      }
      const stdoutText = typeof stdout === 'string' ? stdout : stdout.toString();
      const stderrText = typeof stderr === 'string' ? stderr : stderr.toString();
      resolve({ stdout: stdoutText, stderr: stderrText });
    });
  });

const runCommand = async (command: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await execFileAsync(command, args);
  return stdout;
};

/**
 * Returns the absolute NTP offset in milliseconds.
 */
export async function checkNtpOffset(): Promise<number> {
  const errors: string[] = [];

  try {
    const stdout = await runCommand(CHRONYC_COMMAND, CHRONYC_ARGS);
    const offset = parseChronycTracking(stdout);
    if (offset !== null) {
      return offset;
    }
    errors.push('chronyc tracking returned no offset');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`chronyc tracking failed: ${message}`);
  }

  try {
    const stdout = await runCommand(NTPSTAT_COMMAND, []);
    const offset = parseNtpstat(stdout);
    if (offset !== null) {
      return offset;
    }
    errors.push('ntpstat returned no offset');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`ntpstat failed: ${message}`);
  }

  throw new Error(`Unable to determine NTP offset (${errors.join('; ')})`);
}

export default checkNtpOffset;
