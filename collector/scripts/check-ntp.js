const { checkNtpOffset } = require('../src/ntp/offset');

const isDisabled = () => {
  const raw = process.env.NTP_MONITOR_DISABLED;
  if (!raw) {
    return false;
  }
  const normalised = raw.trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalised);
};

const main = async () => {
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
};

void main();
