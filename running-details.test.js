const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mergeHealthData, readHealthToolResult, formatLocalDate } = require('./health-server');
const { normalizeRunningDetails, mergeRunningDetails } = require('./shared/running-details');

// Entirely synthetic; the optional private backup is validated separately outside this repo.
const start = Math.floor((Date.now() - 3600000) / 1000);
const workout = (extra = {}) => ({ id: `gbw1:42:${start}:1:16`, raw_type: 1, activity_kind: 16,
  start_time: new Date(start * 1000).toISOString(), end_time: new Date((start + 600) * 1000).toISOString(),
  captured_at: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(), timezone: 'Asia/Shanghai', active_seconds: 590, total_seconds: 590,
  distance_meters: 2000, average_heart_rate: 140, min_heart_rate: 110, max_heart_rate: 170, ...extra });
const details = (samples = []) => ({ version: 1, source: 'huawei_running',
  device_summary: { STEP_COUNT: 1000, DEVICE_ID: 99 },
  summary_metrics: { averageHR: { value: 140, unit: 'bpm' }, latitude: { value: 30, unit: 'degrees' } },
  samples, pace_samples: [{ pace_index: 0, distance: 1, type: 0, pace: 300, route: [1, 2] }],
  recovery_heart_rate: { sample_interval_seconds: 5, time_reference: 'first_recovery_sample',
    values_bpm: [150, 140, 255, 0, null, 120], route: [1, 2] }, route: [[1, 2]] });

test('running details preserve available metrics, zero speed and relative recovery without location fields', () => {
  const value = normalizeRunningDetails(details([
    { timestamp_seconds: start + 5, heart_rate: 150, speed_mps: 4, step_rate: 170, latitude: 30 },
    { timestamp_seconds: start + 10, speed_mps: 0, heart_rate: 255, cadence: -1, vo: 0 },
    { timestamp_seconds: start - 5, heart_rate: 140 },
  ]), workout());
  assert.equal(value.samples.length, 2);
  assert.equal(value.samples[0].pace_seconds_per_km, 250);
  assert.equal(value.samples[1].speed_mps, 0);
  assert.equal(value.samples[1].pace_seconds_per_km, undefined);
  assert.equal(value.samples[1].heart_rate, undefined);
  assert.equal(value.samples[1].cadence, undefined);
  assert.equal(value.samples[1].vo, undefined);
  assert.deepEqual(value.recovery_heart_rate.values_bpm, [150, 140, null, null, null, 120]);
  assert.equal(value.recovery_heart_rate.time_reference, 'first_recovery_sample');
  assert.equal(value.recovery_heart_rate.one_minute_drop, undefined);
  for (const forbidden of ['latitude', 'DEVICE_ID', 'route']) assert.ok(!JSON.stringify(value).includes(forbidden));
});

test('ordinary summary re-sends do not delete details; late samples and recovery extend rather than double', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'running-detail-test-'));
  const date = formatLocalDate(new Date(start * 1000));
  const id = workout().id;
  const old = details([{ timestamp_seconds: start + 5, heart_rate: 140 }]);
  mergeHealthData(dir, { date, workouts: [workout({ details: old })] });
  mergeHealthData(dir, { date, workouts: [workout()] });
  let read = readHealthToolResult(dir, { data_type: 'workouts', workout_id: id, days: 3 });
  assert.equal(read.details.samples.length, 1);
  const next = details([{ timestamp_seconds: start + 5, speed_mps: 3 }, { timestamp_seconds: start + 10, heart_rate: 150 }]);
  next.recovery_heart_rate.values_bpm = [150];
  mergeHealthData(dir, { date, workouts: [workout({ details: next })] });
  mergeHealthData(dir, { date, workouts: [workout({ details: next })] });
  read = readHealthToolResult(dir, { data_type: 'workouts', workout_id: id, days: 3, sample_limit: 1 });
  assert.equal(read.details.sample_count, 2);
  assert.equal(read.details.samples.length, 1);
  assert.equal(read.details.samples[0].heart_rate, 140);
  assert.equal(read.details.samples[0].speed_mps, 3);
  assert.equal(read.details.next_sample_offset, 1);
  assert.equal(read.details.recovery_heart_rate.values_bpm.length, 6);
  assert.equal(readHealthToolResult(dir, { data_type: 'workouts', days: 3 }).workouts[0].details, undefined);
  const list = readHealthToolResult(dir, { data_type: 'all', days: 3 }).workouts[0];
  assert.equal(list.detail_sample_count, 2);
  const page = readHealthToolResult(dir, { data_type: 'workouts', workout_id: id, days: 3, sample_offset: 1, sample_limit: 1 });
  assert.equal(page.details.samples[0].timestamp_seconds, start + 10);
  assert.equal(page.details.next_sample_offset, null);
});

test('unsupported/oversized details cannot erase saved data or prevent ordinary summary persistence', () => {
  const valid = details([{ timestamp_seconds: start, heart_rate: 140 }]);
  const invalid = { ...valid, samples: Array(20001).fill({}) };
  assert.equal(normalizeRunningDetails(invalid, workout()), null);
  assert.equal(mergeRunningDetails(valid, invalid, workout()).samples.length, 1);
  assert.equal(normalizeRunningDetails(valid, workout({ raw_type: 3 })), null);
});
