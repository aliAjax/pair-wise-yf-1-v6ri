// lib/store.js
// 业务文件之一：批次存储
// 所有交接批次、箱子当前记录、箱位容量都落本地 SQLite，服务重启后仍可查询。
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'transfer.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS batches (
  batch_id   TEXT PRIMARY KEY,
  trip_id    TEXT NOT NULL,
  box_no     TEXT NOT NULL,
  seal_no    TEXT NOT NULL,
  version    TEXT NOT NULL,
  readings   TEXT NOT NULL,
  status     TEXT NOT NULL,            -- pending | accepted | conflict | rejected | invalidated
  result     TEXT,
  reason     TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS boxes (
  box_no           TEXT PRIMARY KEY,
  seal_no          TEXT,
  version          TEXT,
  readings         TEXT,
  position         TEXT,
  current_batch_id TEXT,
  record_version   INTEGER DEFAULT 0,
  updated_at       INTEGER
);
CREATE TABLE IF NOT EXISTS positions (
  position TEXT PRIMARY KEY,
  total    INTEGER NOT NULL
);
`);

// 预置箱位容量
const seedPosition = db.prepare('INSERT OR IGNORE INTO positions (position, total) VALUES (?, ?)');
for (const [p, t] of [['A-01', 10], ['A-02', 8], ['B-01', 6], ['B-02', 4]]) {
  seedPosition.run(p, t);
}

// ---------- 行映射 ----------
function mapBatch(row) {
  if (!row) return null;
  return {
    batchId: row.batch_id,
    tripId: row.trip_id,
    boxNo: row.box_no,
    sealNo: row.seal_no,
    version: row.version,
    readings: JSON.parse(row.readings),
    status: row.status,
    result: row.result ? JSON.parse(row.result) : null,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function mapBox(row) {
  if (!row) return null;
  return {
    boxNo: row.box_no,
    sealNo: row.seal_no,
    version: row.version,
    readings: row.readings ? JSON.parse(row.readings) : null,
    position: row.position,
    currentBatchId: row.current_batch_id,
    recordVersion: row.record_version,
    updatedAt: row.updated_at,
  };
}

// ---------- 批次 ----------
const getBatchStmt = db.prepare('SELECT * FROM batches WHERE batch_id = ?');
function getBatch(batchId) { return mapBatch(getBatchStmt.get(batchId)); }

const insertBatchStmt = db.prepare(`
  INSERT INTO batches (batch_id, trip_id, box_no, seal_no, version, readings, status, result, reason, created_at, updated_at)
  VALUES (@batchId, @tripId, @boxNo, @sealNo, @version, @readings, @status, @result, @reason, @createdAt, @updatedAt)
`);
function insertBatch(b) {
  insertBatchStmt.run({
    batchId: b.batchId, tripId: b.tripId, boxNo: b.boxNo, sealNo: b.sealNo, version: b.version,
    readings: JSON.stringify(b.readings), status: b.status,
    result: b.result ? JSON.stringify(b.result) : null, reason: b.reason,
    createdAt: b.createdAt, updatedAt: b.updatedAt,
  });
}

const setBatchStatusStmt = db.prepare('UPDATE batches SET status = ?, result = ?, reason = ?, updated_at = ? WHERE batch_id = ?');
function setBatchStatus(batchId, status, result, reason, now) {
  setBatchStatusStmt.run(status, result ? JSON.stringify(result) : null, reason, now, batchId);
}

const listBatchesStmt = db.prepare('SELECT * FROM batches ORDER BY created_at DESC');
function listBatches() { return listBatchesStmt.all().map(mapBatch); }

const listBatchesByBoxStmt = db.prepare('SELECT * FROM batches WHERE box_no = ? ORDER BY created_at DESC');
function listBatchesByBox(boxNo) { return listBatchesByBoxStmt.all(boxNo).map(mapBatch); }

// 同一箱子除本批次外，其余未决/已接受交接一律作废
const invalidateOthersStmt = db.prepare(`
  UPDATE batches SET status = 'invalidated', updated_at = ?
  WHERE box_no = ? AND batch_id != ? AND status IN ('accepted', 'pending')
`);
function invalidateOthersForBox(boxNo, keepBatchId, now) {
  return invalidateOthersStmt.run(now, boxNo, keepBatchId);
}

// ---------- 箱子当前记录 ----------
const getBoxStmt = db.prepare('SELECT * FROM boxes WHERE box_no = ?');
function getBox(boxNo) { return mapBox(getBoxStmt.get(boxNo)); }

const upsertBoxStmt = db.prepare(`
  INSERT INTO boxes (box_no, seal_no, version, readings, position, current_batch_id, record_version, updated_at)
  VALUES (@boxNo, @sealNo, @version, @readings, @position, @currentBatchId, @recordVersion, @updatedAt)
  ON CONFLICT(box_no) DO UPDATE SET
    seal_no = excluded.seal_no,
    version = excluded.version,
    readings = excluded.readings,
    position = excluded.position,
    current_batch_id = excluded.current_batch_id,
    record_version = excluded.record_version,
    updated_at = excluded.updated_at
`);
function upsertBox(box) {
  upsertBoxStmt.run({
    boxNo: box.boxNo, sealNo: box.sealNo, version: box.version,
    readings: JSON.stringify(box.readings), position: box.position,
    currentBatchId: box.currentBatchId, recordVersion: box.recordVersion,
    updatedAt: box.updatedAt,
  });
}

const listBoxesStmt = db.prepare('SELECT * FROM boxes ORDER BY box_no');
function listBoxes() { return listBoxesStmt.all().map(mapBox); }

// ---------- 箱位 ----------
const listPositionsStmt = db.prepare('SELECT * FROM positions ORDER BY position');
function listPositions() { return listPositionsStmt.all(); }

const countBoxesAtStmt = db.prepare('SELECT COUNT(*) AS c FROM boxes WHERE position = ? AND current_batch_id IS NOT NULL');
function countBoxesAtPosition(position) { return countBoxesAtStmt.get(position).c; }

function firstAvailablePosition() {
  for (const p of listPositions()) {
    if (countBoxesAtPosition(p.position) < p.total) return p.position;
  }
  return null;
}

module.exports = {
  db,
  getBatch, insertBatch, setBatchStatus, listBatches, listBatchesByBox, invalidateOthersForBox,
  getBox, upsertBox, listBoxes,
  listPositions, countBoxesAtPosition, firstAvailablePosition,
};
