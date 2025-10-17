import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fitAnomalyModel } from '../src/fit.js';
import { scoreStream } from '../src/score.js';
import { readAnomalyStats, readAnomalyMeta } from '../src/io.js';
import { recalibrateSpotParameters, type SpotCalibrateResult, type SpotSample } from '../src/spot.js';

async function createTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'dt-anom-'));
}

describe('dt-anom pipeline', () => {
  it('fits stats and scores stream with audit output', async () => {
    const dir = await createTempDir();
    const inputPath = join(dir, 'train.csv');
    const csv = [
      'timestamp_utc,uid,session_id,method,path,referer,user_agent,op_category,dt_sec,log_dt,z,z_clipped,z_deseas',
      '2024-01-01T00:00:00Z,u1,s1,GET,/login,-,UA1,AUTH,1.0,0.0,0.2,0.2,0.1',
      '2024-01-01T00:00:01Z,u1,s1,POST,/login,-,UA1,AUTH,1.2,0.18,0.3,0.3,0.0',
      '2024-01-01T00:00:06Z,u1,s1,POST,/admin,-,UA1,UPDATE,5.0,0.70,4.5,4.5,4.0',
      '2024-01-01T00:00:07Z,u1,s1,GET,/dashboard,-,UA1,READ,0.9,0.0,0.1,0.1,0.05',
      '2024-01-01T00:00:09Z,u1,s1,POST,/update,-,UA1,UPDATE,2.5,0.40,2.1,2.1,1.9',
      '2024-01-01T00:00:14Z,u1,s1,POST,/admin/delete,-,UA1,UPDATE,6.2,0.79,4.2,4.2,3.9',
      '2024-01-01T00:00:15Z,u1,s1,GET,/logout,-,UA1,AUTH,0.8,-0.10,0.05,0.05,0.02'
    ].join('\n');
    await writeFile(inputPath, csv, 'utf8');
    const statsOut = join(dir, 'anom_stats.json');
    const metaOut = join(dir, 'anom_meta.json');
    const { stats, meta } = await fitAnomalyModel({
      inputs: [inputPath],
      statsOut,
      metaOut,
      baseColumn: 'dt_sec',
      quantiles: [0.1, 0.9, 0.95, 0.99],
      quantileLower: 0.1,
      quantileUpper: 0.9,
      minQuantileSamples: 2,
      budgetTotal: 0.05,
      budgetWeightMode: 'count',
      spotDomain: 'log_dt',
      spotCalibCount: 5,
      spotQuantileCandidates: [0.9, 0.95, 0.99],
      minTailCount: 2,
      flagTailProbability: 1e-3,
      alpha: 0.6,
      q: 0.995,
      calibWindow: 500,
      declusterR: 3,
      kofn: [1, 3],
      H: 1.3,
      reestimateEvery: 4,
      minExceed: 2,
      poolStrategy: 'per-user',
      xiEps: 1e-4,
      upperCapPerDay: 20,
      lowerClip: -4,
      seeds: [42],
      preprocHash: 'dummy-preproc-hash'
    });
    expect(stats.global_quantiles).toHaveLength(4);
    expect(stats.quantile_levels).toEqual([0.1, 0.9, 0.95, 0.99]);
    expect(stats.quantile.length).toBeGreaterThanOrEqual(5);
    expect(stats.quantile.every((entry) => entry.cdf.length === stats.quantile_levels.length)).toBe(true);
    expect(stats.base_column).toBe('dt_sec');
    expect(stats.spot.length).toBeGreaterThanOrEqual(3);
    const globalSpot = stats.spot.find((entry) => entry.uid === '__global__' && entry.op_category === '__global__');
    expect(globalSpot).toBeDefined();
    expect(globalSpot?.u).toBeGreaterThan(0);
    expect(globalSpot?.estimator).toBeDefined();
    expect(Array.isArray(globalSpot?.warnings)).toBe(true);
    expect(meta.input_files).toEqual([inputPath]);
    expect(meta.algo_ver).toBe('5.0-spec');
    expect(stats.algo_ver).toBe('5.0-spec');
    expect(meta.H).toBeCloseTo(1.3, 10);
    expect(meta.seeds).toEqual([42]);
    expect(meta.grouping.user).toBe('uid');
    expect(meta.spot.domain).toBe('log_dt');
    expect(meta.scoring.base_std).toBeGreaterThan(0);
    expect(meta.budget.total).toBeCloseTo(0.05, 10);
    expect(meta.budget.weight_mode).toBe('count');
    const allocationSum = meta.budget.allocations.reduce((acc, entry) => acc + entry.q_alloc, 0);
    expect(allocationSum).toBeCloseTo(meta.budget.total, 10);
    const updateAllocation = meta.budget.allocations.find(
      (entry) => entry.uid === 'u1' && entry.op_category === 'UPDATE'
    );
    expect(updateAllocation).toBeDefined();
    expect(updateAllocation?.weight).toBeGreaterThan(0);

    const loadedStats = await readAnomalyStats(statsOut);
    const loadedMeta = await readAnomalyMeta(metaOut);
    const loadedGlobalSpot = loadedStats.spot.find((entry) => entry.uid === '__global__');
    expect(loadedGlobalSpot?.beta).toBeGreaterThan(0);
    expect(loadedGlobalSpot?.warnings).toBeDefined();
    expect(Array.isArray(loadedGlobalSpot?.warnings)).toBe(true);
    expect(loadedMeta.spot.recalibrated).toBe(false);

    const scoreInput = join(dir, 'score.csv');
    const scoreCsv =
      csv +
      '\n' +
      '2024-01-01T00:00:20Z,u1,s1,POST,/admin/purge,-,UA1,UPDATE,7.5,0.88,5.1,5.1,4.6';
    await writeFile(scoreInput, scoreCsv, 'utf8');
    const scoreOutput = join(dir, 'scored.csv');
    const auditPath = join(dir, 'spot_audit.jsonl');
    const summary = await scoreStream({
      input: scoreInput,
      output: scoreOutput,
      statsPath: statsOut,
      metaPath: metaOut,
      auditPath
    });
    expect(summary.processedRows).toBe(8);
    const scored = await readFile(scoreOutput, 'utf8');
    const lines = scored.trim().split('\n');
    expect(lines[0]).toContain('tau_hi');
    expect(lines[0]).toContain('alarm_reason');
    expect(lines[0]).toContain('spot_theta_ext');
    expect(lines[0]).toContain('spot_alarm_kofn');
    expect(lines[0]).toContain('p_upper_quantile');
    expect(lines[0]).toContain('p_upper_spot');
    expect(lines[0]).toContain('p_lower');
    expect(lines[0]).toContain('s_evt');
    expect(lines[0]).toContain('neglog10_p');
    expect(lines.length).toBe(9);
    const header = lines[0].split(',');
    const alarmIndex = header.indexOf('alarm');
    const tauHiIndex = header.indexOf('tau_hi');
    const tauLoIndex = header.indexOf('tau_lo');
    const tauDynamicIndex = header.indexOf('spot_tau_t');
    const spotAlarmIndex = header.indexOf('spot_alarm_kofn');
    const spotEstimatorIndex = header.indexOf('spot_estimator');
    const spotWarningsIndex = header.indexOf('spot_warnings');
    const pUpperSpotIndex = header.indexOf('p_upper_spot');
    const sEvtIndex = header.indexOf('s_evt');
    const neglogIndex = header.indexOf('neglog10_p');
    expect(alarmIndex).toBeGreaterThanOrEqual(0);
    expect(tauDynamicIndex).toBeGreaterThanOrEqual(0);
    expect(spotAlarmIndex).toBeGreaterThanOrEqual(0);
    expect(spotEstimatorIndex).toBeGreaterThanOrEqual(0);
    expect(spotWarningsIndex).toBeGreaterThanOrEqual(0);
    expect(pUpperSpotIndex).toBeGreaterThanOrEqual(0);
    expect(sEvtIndex).toBeGreaterThanOrEqual(0);
    expect(neglogIndex).toBeGreaterThanOrEqual(0);
    const dataRows = lines.slice(1).map((line) => line.split(','));
    const uidIndex = header.indexOf('uid');
    const categoryIndex = header.indexOf('op_category');
    const tauPerGroup = new Map<string, number[]>();
    for (const cols of dataRows) {
      const key = `${cols[uidIndex]}||${cols[categoryIndex]}`;
      const sequence = tauPerGroup.get(key);
      const value = Number(cols[tauDynamicIndex]);
      if (sequence) {
        sequence.push(value);
      } else {
        tauPerGroup.set(key, [value]);
      }
    }
    for (const sequence of tauPerGroup.values()) {
      for (let i = 1; i < sequence.length; i += 1) {
        expect(sequence[i]).toBeGreaterThanOrEqual(sequence[i - 1] - 1e-9);
      }
    }
    const spotAlarmRows = dataRows.filter((cols) => cols[spotAlarmIndex] === '1');
    expect(spotAlarmRows.length).toBeGreaterThan(0);
    const flaggedRow = dataRows.find((cols) => cols[alarmIndex] === '1');
    expect(flaggedRow).toBeTruthy();
    if (flaggedRow) {
      const tauHi = Number(flaggedRow[tauHiIndex]);
      const tauLo = Number(flaggedRow[tauLoIndex]);
      const dtValue = Number(flaggedRow[header.indexOf('dt_sec')]);
      const reason = flaggedRow[header.indexOf('alarm_reason')];
      const sEvtValue = Number(flaggedRow[sEvtIndex]);
      const neglogValue = Number(flaggedRow[neglogIndex]);
      const pUpperSpotValue = Number(flaggedRow[pUpperSpotIndex]);
      expect(Number.isFinite(tauHi)).toBe(true);
      expect(Number.isFinite(tauLo)).toBe(true);
      expect(sEvtValue).toBeGreaterThanOrEqual(1);
      expect(neglogValue).toBeGreaterThan(0);
      expect(flaggedRow[spotAlarmIndex]).toBe('1');
      expect(flaggedRow[spotEstimatorIndex].length).toBeGreaterThan(0);
      expect(pUpperSpotValue).toBeGreaterThan(0);
      if (reason === 'both') {
        expect(dtValue > tauHi || dtValue < tauLo).toBe(true);
      } else {
        expect(reason).toBe('spot_upper');
      }
    }
    const auditContent = await readFile(auditPath, 'utf8');
    const auditLines = auditContent.trim().split('\n');
    expect(auditLines.length).toBeGreaterThanOrEqual(8);
    const parsedAudit = auditLines.map((line) => JSON.parse(line));
    const rowAudit = parsedAudit.find((entry) => entry.metadata?.spot_domain !== undefined);
    expect(rowAudit).toBeTruthy();
    if (rowAudit) {
      expect(rowAudit.metadata).toHaveProperty('p_upper_spot');
      expect(rowAudit.metadata).toHaveProperty('spot_estimator');
      expect(rowAudit.metadata).toHaveProperty('spot_warnings');
      expect(rowAudit.metadata).toHaveProperty('s_evt');
    }
    const reestimateEvent = parsedAudit.find((entry) => entry.metadata?.event === 'reestimate');
    expect(reestimateEvent).toBeTruthy();
    if (reestimateEvent) {
      expect(reestimateEvent.metadata).toHaveProperty('p_upper_spot');
      expect(reestimateEvent.metadata).toHaveProperty('diagnostics');
    }
  });

  it('recalibrates xi/beta when sufficient tail samples arrive', () => {
    const current: SpotCalibrateResult = {
      quantile: 0.9,
      threshold: 4,
      xi: 0.1,
      beta: 1,
      theta: 0.5,
      pRef: 0.05,
      calibrationSize: 10,
      meanResidual: 0.2,
      qStar: 0.8
    };
    const samples: SpotSample[] = [
      { value: 4.5, index: 1 },
      { value: 5.2, index: 2 },
      { value: 6.0, index: 3 },
      { value: 7.5, index: 4 }
    ];
    const recalibrated = recalibrateSpotParameters(current, samples, [0.8, 0.9, 0.95], {
      minTailCount: 2,
      xiEps: 1e-4,
      declusterR: 1,
      q: 0.9
    });
    expect(recalibrated.beta).toBeGreaterThan(0);
  });
});
