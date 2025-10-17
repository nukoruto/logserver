import { describe, expect, it } from 'vitest';

import { runSpotScenario } from './spotTestUtils.js';

describe('SPOT alarm sensitivity', () => {
  it('reduces alarm count when tau increases and keeps neglog10_p monotonic', async () => {
    const baseline = await runSpotScenario({ qStar: 0.02, dtValues: [5, 6, 8, 10, 12] });
    const relaxed = await runSpotScenario({ qStar: 0.002, dtValues: [5, 6, 8, 10, 12] });

    try {
      expect(relaxed.flagged).toBeLessThan(baseline.flagged);

      const neglogMonotonic = relaxed.rows.every((row, index, array) => {
        if (index === 0) {
          return true;
        }
        return row.neglog10_p >= array[index - 1].neglog10_p - 1e-9;
      });
      expect(neglogMonotonic).toBe(true);

      const hasFinite = relaxed.rows.every((row) =>
        Number.isFinite(row.neglog10_p) && Number.isFinite(row.spot_tau_t)
      );
      expect(hasFinite).toBe(true);
    } finally {
      await baseline.cleanup();
      await relaxed.cleanup();
    }
  });
});
