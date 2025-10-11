const { execFile } = require('node:child_process');

const CHRONYC_COMMAND = 'chronyc';
const CHRONYC_ARGS = ['tracking'];
const NTPSTAT_COMMAND = 'ntpstat';

const CHRONYC_OFFSET_PATTERN = /(last offset|system time)\s*:\s*([-+]?\d+(?:\.\d+)?)\s*seconds/iu;
const NTPSTAT_OFFSET_PATTERN = /time correct to within\s+([-+]?\d+(?:\.\d+)?)\s*ms/iu;

const toMilliseconds = (value) => Math.abs(value) * 1000;

const parseChronycTracking = (stdout) => {
  const lines = stdout.split(/\r?\n/);
  let lastOffset = null;
  let systemTime = null;

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

const parseNtpstat = (stdout) => {
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

const execFileAsync = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      const stdoutText = typeof stdout === 'string' ? stdout : stdout.toString();
      const stderrText = typeof stderr === 'string' ? stderr : stderr.toString();
      resolve({ stdout: stdoutText, stderr: stderrText });
    });
  });

const runCommand = async (command, args) => {
  const { stdout } = await execFileAsync(command, args);
  return stdout;
};

const checkNtpOffset = async () => {
  const errors = [];

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
};

module.exports = {
  checkNtpOffset,
  default: checkNtpOffset,
};
