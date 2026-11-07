// Undocumented device fields are retained as codes, never clinical interpretations.
function normalizeArrhythmia(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.source !== "huawei_ppg_arrhythmia") return null;
  if (typeof raw.measured_at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(raw.measured_at)) return null;
  const time = Date.parse(raw.measured_at);
  if (!Number.isFinite(time) || time < Date.UTC(2020, 0, 1) || time > Date.now() + 300000) return null;
  if (!Number.isInteger(raw.format_version) || raw.format_version < 1 || raw.format_version > 255) return null;
  const result = { source: "huawei_ppg_arrhythmia", measured_at: new Date(time).toISOString(), format_version: raw.format_version, interpretation: "unresolved" };
  for (const key of ["field_700004347", "field_700004809"]) {
    if (Object.hasOwn(raw, key)) {
      if (!Number.isInteger(raw[key]) || raw[key] < 0 || raw[key] > 65535) return null;
      result[key] = raw[key];
    }
  }
  return result;
}

function mergeArrhythmia(old, incoming) {
  const records = new Map();
  for (const array of [old, incoming]) if (Array.isArray(array)) for (const value of array.slice(0, 256)) {
    const row = normalizeArrhythmia(value);
    if (row) records.set(row.measured_at, { ...records.get(row.measured_at), ...row });
  }
  return [...records.values()].sort((a, b) => a.measured_at.localeCompare(b.measured_at)).slice(-256);
}

module.exports = { normalizeArrhythmia, mergeArrhythmia };
