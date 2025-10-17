import { describe, expect, it } from 'vitest';

import { runSpotScenario } from './spotTestUtils.js';

describe('SPOT hysteresis latch', () => {
  it('holds alarm state until s_evt falls below 1/H when H=1.1', async () => {
    const scenario = await runSpotScenario({ qStar: 0.02, dtValues: [4, 10, 4.7, 4], hysteresisH: 1.1 });
    try {
      const alarms = scenario.rows.map((row) => row.alarm);
      expect(alarms).toEqual([0, 1, 1, 0]);

      const sevtValues = scenario.rows.map((row) => row.dt / Math.max(row.spot_tau_t, 1e-12));
      const unlatchThreshold = 1 / 1.1;
      expect(sevtValues[2]).toBeGreaterThan(unlatchThreshold);
      expect(sevtValues[3]).toBeLessThanOrEqual(unlatchThreshold + 1e-12);
    } finally {
      await scenario.cleanup();
    }
  });
});
