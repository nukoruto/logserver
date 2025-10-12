jest.mock('node:child_process', () => ({
  execFile: jest.fn(),
}));

import { execFile } from 'node:child_process';

import { checkNtpOffset } from '../../src/ntp/offset';

describe('checkNtpOffset', () => {
  const execFileMock = execFile as unknown as jest.Mock;

  beforeEach(() => {
    jest.resetModules();
    execFileMock.mockReset();
  });

  it('parses chronyc tracking output', async () => {
    execFileMock.mockImplementation((_command: string, _args: string[], callback: (...args: unknown[]) => void) => {
      if (typeof callback === 'function') {
        callback(null, 'Last offset     : -0.000123 seconds\nRMS offset      : 0.000200 seconds\n', '');
      }
      return {};
    });

    const offset = await checkNtpOffset();
    expect(offset).toBeCloseTo(0.123, 3);
    expect(execFileMock).toHaveBeenCalledWith('chronyc', ['tracking'], expect.any(Function));
  });

  it('falls back to ntpstat when chronyc is unavailable', async () => {
    execFileMock.mockImplementationOnce((_command: string, _args: string[], callback: (...args: unknown[]) => void) => {
      if (typeof callback === 'function') {
        const error = Object.assign(new Error('not found'), { code: 'ENOENT' });
        callback(error, '', '');
      }
      return {};
    });

    execFileMock.mockImplementationOnce((_command: string, _args: string[], callback: (...args: unknown[]) => void) => {
      if (typeof callback === 'function') {
        callback(null, 'synchronised to NTP server (10.0.0.1) at stratum 2\ntime correct to within 42 ms\n', '');
      }
      return {};
    });

    const offset = await checkNtpOffset();
    expect(offset).toBe(42);
    expect(execFileMock).toHaveBeenNthCalledWith(1, 'chronyc', ['tracking'], expect.any(Function));
    expect(execFileMock).toHaveBeenNthCalledWith(2, 'ntpstat', [], expect.any(Function));
  });

  it('throws when neither command yields an offset', async () => {
    execFileMock.mockImplementation((_command: string, _args: string[], callback: (...args: unknown[]) => void) => {
      if (typeof callback === 'function') {
        callback(null, 'unsynchronised\n', '');
      }
      return {};
    });

    await expect(checkNtpOffset()).rejects.toThrow('Unable to determine NTP offset');
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});
