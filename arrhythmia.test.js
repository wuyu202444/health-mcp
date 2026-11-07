const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeArrhythmia } = require("./shared/arrhythmia");
const { mergeHealthData, readHealthToolResult } = require("./health-server");

const row = () => ({ source: "huawei_ppg_arrhythmia", measured_at: "2026-01-02T12:09:52+08:00", format_version: 1, field_700004347: 56, field_700004809: 1 });
test("codes stay unresolved and waveform/diagnosis are never accepted", () => {
  const result = normalizeArrhythmia({ ...row(), interpretation: "normal", diagnosis: "normal", waveform: [1, 2], latitude: 30 });
  assert.deepEqual(result, { source: "huawei_ppg_arrhythmia", measured_at: "2026-01-02T04:09:52.000Z", format_version: 1, interpretation: "unresolved", field_700004347: 56, field_700004809: 1 });
  assert.equal(normalizeArrhythmia({ ...row(), field_700004809: "normal" }), null);
  assert.equal(normalizeArrhythmia({ ...row(), measured_at: "bad" }), null);
});
test("measurement-day routing and repeat uploads preserve other health data", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-arrhythmia-"));
  mergeHealthData(dir, { date: "2026-01-02", steps: { total: 1234 } });
  mergeHealthData(dir, { date: "2026-01-03", arrhythmia: [row(), row()] });
  mergeHealthData(dir, { date: "2026-01-02", arrhythmia: [row()] });
  const stored = JSON.parse(fs.readFileSync(path.join(dir, "2026-01-02.json")));
  assert.equal(stored.arrhythmia.length, 1);
  assert.equal(stored.steps.total, 1234);
  const today = new Date().toISOString();
  mergeHealthData(dir, { arrhythmia: [{ ...row(), measured_at: today.slice(0, 19) + "Z" }] });
  const read = readHealthToolResult(dir, { data_type: "arrhythmia", days: 3 });
  assert.equal(read.arrhythmia.length, 1);
  assert.equal(read.arrhythmia[0].interpretation, "unresolved");
  assert.equal(readHealthToolResult(dir, { data_type: "all", days: 3 }).arrhythmia.length, 1);
  assert.equal(readHealthToolResult(dir, { data_type: "current_status" }).latest_arrhythmia.field_700004809, 1);
});
