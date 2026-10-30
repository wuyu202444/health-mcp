// Explicit projections only: never accept GPS, file paths or unstructured device blobs.
const MAX_SAMPLES = 20000;
const SUMMARY_COLUMNS = ["STEP_COUNT", "WORKOUT_LOAD", "WORKOUT_AEROBIC_EFFECT", "WORKOUT_ANAEROBIC_EFFECT", "RECOVERY_TIME", "MIN_HEART_RATE_PEAK", "MAX_HEART_RATE_PEAK", "MAX_MET", "HR_ZONE_TYPE", "RUN_PACE_ZONE1_MIN", "RUN_PACE_ZONE2_MIN", "RUN_PACE_ZONE3_MIN", "RUN_PACE_ZONE4_MIN", "RUN_PACE_ZONE5_MIN", "RUN_PACE_ZONE5_MAX", "RUN_PACE_ZONE1_TIME", "RUN_PACE_ZONE2_TIME", "RUN_PACE_ZONE3_TIME", "RUN_PACE_ZONE4_TIME", "RUN_PACE_ZONE5_TIME", "ALG_TYPE", "TRAINING_POINTS", "MAX_ALTITUDE", "MIN_ALTITUDE", "ELEVATION_GAIN", "ELEVATION_LOSS"];
const SAMPLE_COLUMNS = ["HEART_RATE", "SPEED", "STEP_RATE", "CADENCE", "STEP_LENGTH", "GROUND_CONTACT_TIME", "IMPACT", "SWING_ANGLE", "FORE_FOOT_LANDING", "MID_FOOT_LANDING", "BACK_FOOT_LANDING", "EVERSION_ANGLE", "CALORIES", "ALTITUDE", "HANG_TIME", "IMPACT_HANG_RATE", "AP", "VO", "GTB", "VR", "CEILING", "TEMP", "SPO2"];
const METRIC_KEYS = ["activeSeconds", "averageAltitude", "maxAltitude", "minAltitude", "averageCadence", "active_calories", "distanceMeters", "elevationGain", "elevationLoss", "eversionAngleAvg", "eversionAngleMax", "backFootLandings", "foreFootLandings", "midFootLandings", "groundContactTimeAvg", "averageHR", "maxHR", "minHR", "impactAvg", "impactMax", "maximumOxygenUptake", "averageKMPaceSeconds", "maxPace", "recoveryTime", "averageSpeed", "maxSpeed", "steps", "stepLengthAvg", "stepRateAvg", "swingAngleAvg", "aerobicTrainingEffect", "anaerobicTrainingEffect", "currentWorkoutLoad", "hrZoneWarmUp", "hrZoneFatBurn", "hrZoneAerobic", "hrZoneAnaerobic", "hrZoneExtreme"];
const PACE_KEYS = ['pace_index', 'distance', 'type', 'pace', 'point_index', 'correction'];
const numeric = value => typeof value === 'number' && Number.isFinite(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const pick = (raw, keys, valid) => Object.fromEntries(keys.filter(key => valid(raw?.[key])).map(key => [key, raw[key]]));

function normalizeRunningDetails(raw, workout) {
  if (!object(raw) || raw.version !== 1 || raw.source !== 'huawei_running' || ![1, 5, 11].includes(workout.raw_type)) return null;
  if (!Array.isArray(raw.samples) || raw.samples.length > MAX_SAMPLES || !Array.isArray(raw.pace_samples) || raw.pace_samples.length > 4096) return null;
  const start = Date.parse(workout.start_time) / 1000, end = Date.parse(workout.end_time) / 1000;
  const byTime = new Map();
  for (const row of raw.samples) {
    if (!object(row) || !Number.isSafeInteger(row.timestamp_seconds) || row.timestamp_seconds < start || row.timestamp_seconds > end) continue;
    const point = { timestamp_seconds: row.timestamp_seconds };
    for (const key of SAMPLE_COLUMNS.map(name => name.toLowerCase()).filter(key => key !== 'speed')) {
      const value = row[key];
      if (!numeric(value) || Math.abs(value) > 1000000 || value === -1 || value === -32768) continue;
      if (['heart_rate', 'step_rate'].includes(key) && (!Number.isInteger(value) || value < 1 || value > 254)) continue;
      if (['ap','vo','gtb','vr'].includes(key) && value === 0) continue;
      point[key] = value;
    }
    if (numeric(row.speed_mps) && row.speed_mps >= 0 && row.speed_mps <= 100) {
      point.speed_mps = row.speed_mps;
      if (row.speed_mps > 0) point.pace_seconds_per_km = 1000 / row.speed_mps;
    }
    if (Object.keys(point).length > 1) byTime.set(point.timestamp_seconds, { ...byTime.get(point.timestamp_seconds), ...point });
  }
  const summaryMetrics = {};
  for (const key of METRIC_KEYS) {
    const item = raw.summary_metrics?.[key];
    if (object(item) && numeric(item.value) && Math.abs(item.value) <= 1e12 && typeof item.unit === 'string' && /^[A-Za-z0-9_/%.-]{0,64}$/.test(item.unit)) {
      summaryMetrics[key] = { value: item.value, unit: item.unit };
    }
  }
  const paces = new Map();
  for (const row of raw.pace_samples) {
    if (!object(row) || ![0, 1].includes(row.type) || !Number.isSafeInteger(row.pace_index) || !Number.isSafeInteger(row.distance) || !numeric(row.pace) || row.pace <= 0) continue;
    const pace = pick(row, PACE_KEYS, value => Number.isSafeInteger(value) && value >= 0 && value <= 1e9);
    paces.set([pace.pace_index, pace.distance, pace.type].join(':'), pace);
  }
  const result = { version: 1, source: 'huawei_running',
    device_summary: pick(raw.device_summary, SUMMARY_COLUMNS, value => numeric(value) && value >= 0 && value <= 1e12),
    summary_metrics: summaryMetrics, samples: [...byTime.values()].sort((a,b) => a.timestamp_seconds-b.timestamp_seconds),
    pace_samples: [...paces.values()].sort((a,b) => a.pace_index-b.pace_index || a.distance-b.distance || a.type-b.type) };
  const recovery = raw.recovery_heart_rate;
  if (object(recovery) && recovery.sample_interval_seconds === 5 && recovery.time_reference === 'first_recovery_sample'
      && Array.isArray(recovery.values_bpm) && recovery.values_bpm.length > 0 && recovery.values_bpm.length <= 512) {
    result.recovery_heart_rate = { sample_interval_seconds: 5, time_reference: 'first_recovery_sample',
      values_bpm: recovery.values_bpm.map(value => Number.isInteger(value) && value >= 1 && value <= 254 ? value : null) };
  }
  return result;
}

function mergeRunningDetails(stored, incoming, workout) {
  const old = normalizeRunningDetails(stored, workout), next = normalizeRunningDetails(incoming, workout);
  if (!old || !next) return next || old;
  const joined = { ...next, device_summary: { ...old.device_summary, ...next.device_summary },
    summary_metrics: { ...old.summary_metrics, ...next.summary_metrics },
    samples: [...old.samples, ...next.samples], pace_samples: [...old.pace_samples, ...next.pace_samples] };
  if ((old.recovery_heart_rate?.values_bpm.length || 0) > (next.recovery_heart_rate?.values_bpm.length || 0)) joined.recovery_heart_rate = old.recovery_heart_rate;
  // Deduplicate before applying the per-workout limits to repeated complete snapshots.
  const samples = new Map();
  for (const row of joined.samples) samples.set(row.timestamp_seconds, { ...samples.get(row.timestamp_seconds), ...row });
  joined.samples = [...samples.values()];
  const paces = new Map();
  for (const row of joined.pace_samples) paces.set([row.pace_index,row.distance,row.type].join(':'), row);
  joined.pace_samples = [...paces.values()];
  return normalizeRunningDetails(joined, workout) || old;
}

function runningDetailPage(workout, offset = 0, limit = 300) {
  const details = workout.details;
  const summary = { ...workout }; delete summary.details;
  if (!details) return { workout: summary, details: null };
  return { workout: summary, details: { ...details, samples: details.samples.slice(offset, offset + limit),
    sample_count: details.samples.length, sample_offset: offset, sample_limit: limit,
    next_sample_offset: offset + limit < details.samples.length ? offset + limit : null } };
}

module.exports = { normalizeRunningDetails, mergeRunningDetails, runningDetailPage, SUMMARY_COLUMNS, SAMPLE_COLUMNS, METRIC_KEYS };
