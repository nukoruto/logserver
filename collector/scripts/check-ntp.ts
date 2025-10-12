import { checkNtpOffset } from '../src/ntp/offset';

const isDisabled = (): boolean => {
  const raw = process.env.NTP_MONITOR_DISABLED;
  if (!raw) {
    return false;
  }
  const normalised = raw.trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalised);
};

async function main(): Promise<void> {
  if (isDisabled()) {
    console.log(JSON.stringify({
      status: 'skipped',
      reason: 'NTP monitoring disabled by environment',
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  try {
    const offsetMs = await checkNtpOffset();
    console.log(JSON.stringify({
      status: 'ok',
      offset_ms: offsetMs,
      timestamp: new Date().toISOString(),
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      status: 'error',
      error: message,
      timestamp: new Date().toISOString(),
    }));
    process.exitCode = 1;
  }
}

void main();
