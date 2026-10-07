import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, ClientError } from '../src/store.js';
import { RESULT } from '../src/judge.js';

let clock = 0;
const dir = mkdtempSync(join(tmpdir(), 'handover-'));
const file = () => join(dir, `db-${process.pid}-${clock}.json`);

function newStore(f) {
  clock += 1;
  return new Store(f, { clock: () => 1_700_000_000_000 + clock * 1000 });
}

test('新箱首次交接：正常入库并占用一个箱位', () => {
  const f = file();
  const s = newStore(f);
  const { batch } = s.submitBatch({
    batchId: 'B-NEW', tripId: 'T1', driver: '王司机',
    lines: ['A001,SL-1,0,4.2', 'A002,SL-2,0,3.8'],
  });
  assert.equal(batch.status, 'accepted');
  assert.deepEqual(batch.items.map((i) => i.status), [RESULT.ACCEPTED, RESULT.ACCEPTED]);
  assert.equal(s.overview().slots.remaining, 22);
  assert.equal(s.snapshot().boxes.A001.seal, 'SL-1');
});

test('同批次重复提交：取回首次结果，不重复入库', () => {
  const f = file();
  const s = newStore(f);
  const first = s.submitBatch({
    batchId: 'B-IDEM', tripId: 'T1', driver: '王司机',
    lines: ['A001,SL-1,0,4.2'],
  });
  const again = s.submitBatch({
    batchId: 'B-IDEM', tripId: 'T1', driver: '王司机',
    lines: ['A001,SL-1,0,4.2', 'A099,SL-X,0,9.9'], // 即使内容变了也不改首次结果
  });
  assert.equal(again.duplicate, true);
  assert.equal(again.batch, first.batch);
  assert.equal(again.batch.items.length, 1);
  assert.equal(s.overview().batches.length, 1);
  assert.equal(s.overview().slots.occupied, 1);
});

test('失败后重试同一批次：不重复入库，原样返回首次失败结果', () => {
  const f = file();
  const s = newStore(f);
  const bad = s.submitBatch({
    batchId: 'B-BAD', tripId: 'T1', driver: '王司机',
    lines: ['A001,SL-1,v0,4.2'], // 版本不是非负整数 → rejected
  });
  assert.equal(bad.batch.items[0].status, RESULT.REJECTED);
  const retry = s.submitBatch({
    batchId: 'B-BAD', tripId: 'T1', driver: '王司机',
    lines: ['A001,SL-1,0,4.2'],
  });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.batch.items[0].status, RESULT.REJECTED);
  assert.equal(s.overview().slots.occupied, 0);
});

test('干净箱重复交接（封签+读数都一致）：放行但不重复占位', () => {
  const f = file();
  const s = newStore(f);
  s.submitBatch({ batchId: 'B1', tripId: 'T1', driver: '王司机', lines: ['A001,SL-1,0,4.2'] });
  const b2 = s.submitBatch({ batchId: 'B2', tripId: 'T2', driver: '李司机', lines: ['A001,SL-1,0,4.2'] });
  assert.equal(b2.batch.items[0].status, RESULT.ACCEPTED);
  assert.equal(b2.batch.items[0].identical, true);
  assert.equal(s.overview().slots.occupied, 1); // 仍是同一个箱位
});

test('换封签或换读数：返回冲突，旧温度与箱位不被覆盖', () => {
  const f = file();
  const s = newStore(f);
  s.submitBatch({ batchId: 'B1', tripId: 'T1', driver: '王司机', lines: ['A001,SL-1,0,4.2'] });
  const sealChanged = s.submitBatch({ batchId: 'B2', tripId: 'T2', driver: '李司机', lines: ['A001,SL-9,0,4.2'] });
  const tempChanged = s.submitBatch({ batchId: 'B3', tripId: 'T2', driver: '李司机', lines: ['A001,SL-1,0,7.0'] });
  assert.equal(sealChanged.batch.items[0].status, RESULT.CONFLICT);
  assert.match(sealChanged.batch.items[0].reason, /封签号/);
  assert.equal(tempChanged.batch.items[0].status, RESULT.CONFLICT);
  assert.match(tempChanged.batch.items[0].reason, /温度读数/);
  // 在站记录纹丝不动，箱位仍为 1
  assert.deepEqual(s.snapshot().boxes.A001, { ...s.snapshot().boxes.A001, seal: 'SL-1', temp: 4.2, version: 0 });
  assert.equal(s.overview().slots.occupied, 1);
  assert.equal(s.overview().pending.length, 2);
});

test('箱子当前记录一变：先前有效交接立即作废，余量重算', () => {
  const f = file();
  const s = newStore(f);
  s.submitBatch({ batchId: 'B1', tripId: 'T1', driver: '王司机', lines: ['A001,SL-1,0,4.2'] });
  s.submitBatch({ batchId: 'B2', tripId: 'T2', driver: '李司机', lines: ['A002,SL-2,0,3.0'] });
  assert.equal(s.overview().slots.occupied, 2);

  // 调度员采信 B3 对 A001 的冲突读数 → B1 的 A001 行作废；占位仍按去重箱数计
  const c = s.submitBatch({ batchId: 'B3', tripId: 'T3', driver: '赵司机', lines: ['A001,SL-1,0,5.5'] });
  const item = c.batch.items[0];
  s.resolveConflict('B3', item.id, 'accept', '张调度');

  const b1 = s.snapshot().batches.B1;
  assert.equal(b1.items[0].status, 'voided');
  assert.match(b1.items[0].voidedBecause, /采信/);
  assert.equal(b1.status, 'voided');
  assert.equal(s.snapshot().boxes.A001.temp, 5.5);
  assert.equal(s.snapshot().boxes.A001.version, 1);
  assert.equal(s.overview().slots.occupied, 2); // A001 仍占位，只是来源换成 B3
  assert.equal(s.overview().voidedRows.length, 1);
});

test('调度员驳回冲突：维持在站记录，冲突行变失败且不占位', () => {
  const f = file();
  const s = newStore(f);
  s.submitBatch({ batchId: 'B1', tripId: 'T1', driver: '王司机', lines: ['A001,SL-1,0,4.2'] });
  const c = s.submitBatch({ batchId: 'B2', tripId: 'T2', driver: '李司机', lines: ['A001,SL-9,0,4.2'] });
  s.resolveConflict('B2', c.batch.items[0].id, 'reject', '张调度');
  assert.equal(s.snapshot().boxes.A001.seal, 'SL-1');
  assert.equal(s.snapshot().batches.B2.items[0].status, RESULT.REJECTED);
  assert.equal(s.overview().slots.occupied, 1);
});

test('提交旧版本号：直接判失败并给出版本原因', () => {
  const f = file();
  const s = newStore(f);
  s.submitBatch({ batchId: 'B1', tripId: 'T1', driver: '王司机', lines: ['A001,SL-1,0,4.2'] });
  const c = s.submitBatch({ batchId: 'B2', tripId: 'T2', driver: '李司机', lines: ['A001,SL-9,2,9.0'] }); // 新版本+换封签 → 冲突
  s.resolveConflict('B2', c.batch.items[0].id, 'accept', '张调度'); // version → max(2,1)=2
  const stale = s.submitBatch({ batchId: 'B3', tripId: 'T2', driver: '李司机', lines: ['A001,SL-1,1,4.2'] });
  assert.equal(stale.batch.items[0].status, RESULT.REJECTED);
  assert.match(stale.batch.items[0].reason, /版本已过期/);
  assert.equal(s.snapshot().boxes.A001.seal, 'SL-9');
});

test('箱位满：新箱被判失败，已有干净箱不受影响', () => {
  const f = file();
  const s = newStore(f);
  s.setCapacity(1, '张调度');
  s.submitBatch({ batchId: 'B1', tripId: 'T1', driver: '王司机', lines: ['A001,SL-1,0,4.2'] });
  const full = s.submitBatch({ batchId: 'B2', tripId: 'T2', driver: '李司机', lines: ['A002,SL-2,0,3.0'] });
  assert.equal(full.batch.items[0].status, RESULT.REJECTED);
  assert.match(full.batch.items[0].reason, /箱位已满/);
  // 已在站的 A001 重复提交依旧干净放行
  const clean = s.submitBatch({ batchId: 'B3', tripId: 'T2', driver: '李司机', lines: ['A001,SL-1,0,4.2'] });
  assert.equal(clean.batch.items[0].status, RESULT.ACCEPTED);
  assert.equal(clean.batch.items[0].identical, true);
  assert.equal(s.overview().slots.occupied, 1);
});

test('同批箱号重复 / 缺字段：失败并带原因，不影响其它行', () => {
  const f = file();
  const s = newStore(f);
  const { batch } = s.submitBatch({
    batchId: 'B-MIX', tripId: 'T1', driver: '王司机',
    lines: ['A001,SL-1,0,4.2', 'A001,SL-1,0,4.2', 'A003,,0,4.2', 'A004,SL-4,0,hot'],
  });
  assert.equal(batch.status, 'rejected');
  assert.equal(batch.items[0].status, RESULT.ACCEPTED);
  assert.match(batch.items[1].reason, /同批箱号重复/);
  assert.match(batch.items[2].reason, /缺封签号/);
  assert.match(batch.items[3].reason, /温度/);
});

test('只有冲突行可裁决；司机不能靠接口乱改', () => {
  const f = file();
  const s = newStore(f);
  const { batch } = s.submitBatch({ batchId: 'B1', tripId: 'T1', driver: '王司机', lines: ['A001,SL-1,0,4.2'] });
  assert.throws(() => s.resolveConflict('B1', batch.items[0].id, 'accept', 'x'), ClientError);
});

test('数据落本地：重启 Store 后批次、冲突、箱位、失败原因仍可查', () => {
  const f = file();
  const s1 = newStore(f);
  s1.submitBatch({ batchId: 'B1', tripId: 'T1', driver: '王司机', lines: ['A001,SL-1,0,4.2'] });
  s1.submitBatch({ batchId: 'B2', tripId: 'T2', driver: '李司机', lines: ['A001,SL-9,0,4.2', 'A002,,0,3'] });
  assert.ok(existsSync(f));
  assert.match(readFileSync(f, 'utf8'), /B2/);

  const s2 = newStore(f); // 模拟服务重启
  const ov = s2.overview();
  assert.equal(ov.slots.occupied, 1);
  assert.equal(ov.pending.length, 1);
  assert.equal(ov.pending[0].item.boxId, 'A001');
  assert.equal(ov.failedRows[0].item.boxId, 'A002');
  assert.match(ov.failedRows[0].item.reason, /缺封签号/);
  // 重启后旧批次号仍是幂等的
  const again = s2.submitBatch({ batchId: 'B1', tripId: 'T1', driver: '王司机', lines: ['A001,SL-1,0,4.2'] });
  assert.equal(again.duplicate, true);
  assert.equal(s2.overview().batches.length, 2);
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
