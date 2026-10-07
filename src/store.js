// 批次存储：交接批次的唯一写入入口。所有改动后原子落盘，重启仍可查。
// 不变量：
//  1. 同一批次号重复提交，原样取回首次结果，绝不重复入库；
//  2. 箱子的当前记录一旦变化（新交接正常入库 / 调度员采信冲突），
//     该箱此前的有效交接立即作废，箱位余量随之重算；
//  3. 冲突行、拒绝行不占箱位；干净箱（一致重复提交）不重复占位。

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { adjudicateItem, batchStatusOf, normalizeItem, RESULT, slotSummary } from './judge.js';

export class ClientError extends Error {}

const MAX_ITEMS_PER_BATCH = 50;

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

export function emptyState() {
  return {
    capacity: Number(process.env.SLOT_CAPACITY ?? 24),
    seq: 0,
    // boxes[boxId] = { boxId, seal, temp, version, batchId, updatedAt } —— 箱子当前记录
    boxes: {},
    // batches[id] = { id, tripId, driver, submittedAt, items: [...] }
    batches: {},
    audit: [], // 作废与调度裁决留痕
  };
}

export class Store {
  constructor(file, { clock = () => Date.now() } = {}) {
    this.file = file;
    this.clock = clock;
    this.state = this.#load();
  }

  #load() {
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
        return { ...emptyState(), ...parsed };
      }
    } catch (err) {
      // 落盘文件损坏时不静默吞：备份后从空库启动，避免继续写坏数据。
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try { renameSync(this.file, backup); } catch { /* ignore */ }
      console.error(`[store] 数据文件无法解析，已备份到 ${backup}：${err.message}`);
    }
    const state = emptyState();
    this.#persist(state);
    return state;
  }

  #persist(state = this.state) {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    renameSync(tmp, this.file); // 同目录 rename 是原子的
  }

  snapshot() {
    return this.state;
  }

  // —— 提交交接批次 ——
  // payload: { batchId?, tripId, driver, lines: ["箱号,封签,版本,读数", ...] }
  submitBatch(payload) {
    const { tripId, driver } = payload;
    if (!tripId || !driver) throw new ClientError('缺车次号或司机');

    // 幂等：同批次号（同车同批的重试）取回首次结果，不再判定、不重复入库。
    const existingId = payload.batchId && this.state.batches[payload.batchId];
    if (existingId) {
      return { batch: existingId, duplicate: true };
    }

    const rawLines = Array.isArray(payload.lines) ? payload.lines : [];
    if (rawLines.length === 0) throw new ClientError('批次里没有任何箱行');
    if (rawLines.length > MAX_ITEMS_PER_BATCH) {
      throw new ClientError(`单批次最多 ${MAX_ITEMS_PER_BATCH} 行`);
    }

    this.state.seq += 1;
    const batchId = payload.batchId || `B${String(this.state.seq).padStart(6, '0')}`;
    if (this.state.batches[batchId]) {
      // 客户端自带 ID 撞车时，保护已有批次。
      return { batch: this.state.batches[batchId], duplicate: true };
    }

    const batch = {
      id: batchId,
      tripId,
      driver,
      submittedAt: nowIso(this.clock),
      items: [],
    };
    this.state.batches[batchId] = batch; // 先落账，保证后续失败重试也能取回首次结果

    const seenInBatch = new Set();
    for (const line of rawLines) {
      const base = {
        id: `${batchId}-#${batch.items.length + 1}`,
        boxId: '',
        submittedSeal: '',
        submittedTemp: null,
        submittedVersion: null,
        status: RESULT.REJECTED,
        reason: '',
        detail: '',
        identical: false,
        decidedBy: null,
        decidedAt: null,
        voidedAt: null,
        voidedBecause: null,
      };

      const norm = normalizeItem(line);
      if (!norm.ok) {
        batch.items.push({ ...base, boxId: norm.partial?.boxId || '', reason: norm.reason });
        continue;
      }
      const item = norm.item;
      Object.assign(base, {
        boxId: item.boxId,
        submittedSeal: item.seal,
        submittedTemp: item.temp,
        submittedVersion: item.version,
      });

      if (seenInBatch.has(item.boxId)) {
        batch.items.push({ ...base, reason: '同批箱号重复' });
        continue;
      }
      seenInBatch.add(item.boxId);

      const verdict = adjudicateItem(item, this.state, {
        duplicateInBatch: false,
      });
      const row = {
        ...base,
        status: verdict.status,
        reason: verdict.reason,
        detail: verdict.detail || '',
        identical: Boolean(verdict.identical),
      };

      if (verdict.status === RESULT.ACCEPTED && !verdict.identical) {
        // 新箱正式占当前记录；箱内此前有效交接（其它车次的旧交接）立即作废。
        this.#voidBoxPriorAccepts(item.boxId, batchId,
          `箱子当前记录被车次 ${tripId} 的新交接更新`);
        this.state.boxes[item.boxId] = {
          boxId: item.boxId,
          seal: item.seal,
          temp: item.temp,
          version: item.version,
          batchId,
          updatedAt: nowIso(this.clock),
        };
      }
      batch.items.push(row);
    }

    batch.status = batchStatusOf(batch);
    this.#persist();
    return { batch, duplicate: false };
  }

  // 作废某箱除 exceptBatch 外、当前仍 accepted 的全部交接行并重算其批次状态。
  #voidBoxPriorAccepts(boxId, exceptBatchId, because) {
    for (const b of Object.values(this.state.batches)) {
      if (b.id === exceptBatchId) continue;
      let touched = false;
      for (const it of b.items) {
        if (it.boxId === boxId && it.status === RESULT.ACCEPTED) {
          it.status = 'voided';
          it.voidedAt = nowIso(this.clock);
          it.voidedBecause = because;
          touched = true;
        }
      }
      if (touched) {
        b.status = batchStatusOf(b);
        this.state.audit.push({
          at: nowIso(this.clock), type: 'void', boxId, batchId: b.id, because,
        });
      }
    }
  }

  // —— 调度员处理冲突 ——
  // action: 'accept'（采信车上的封签/读数，覆盖当前记录）| 'reject'（维持站内记录）
  resolveConflict(batchId, itemId, action, dispatcher) {
    const batch = this.state.batches[batchId];
    if (!batch) throw new ClientError('批次不存在');
    const item = batch.items.find((i) => i.id === itemId);
    if (!item) throw new ClientError('交接行不存在');
    if (item.status !== RESULT.CONFLICT) {
      throw new ClientError('只有冲突状态的交接行能这样处理');
    }

    if (action === 'reject') {
      item.status = RESULT.REJECTED;
      item.reason = `调度员驳回：维持在站封签/读数（${dispatcher}）`;
      item.decidedBy = dispatcher;
      item.decidedAt = nowIso(this.clock);
      this.state.audit.push({
        at: item.decidedAt, type: 'reject-conflict',
        boxId: item.boxId, batchId, by: dispatcher,
      });
    } else if (action === 'accept') {
      // 采信司机版本：该箱此前有效交接全部作废，箱位按新记录重算。
      this.#voidBoxPriorAccepts(item.boxId, batchId,
        `调度员 ${dispatcher} 采信车次 ${batch.tripId} 的冲突读数`);
      const version = Math.max(
        item.submittedVersion ?? 0,
        (this.state.boxes[item.boxId]?.version ?? -1) + 1,
      );
      this.state.boxes[item.boxId] = {
        boxId: item.boxId,
        seal: item.submittedSeal,
        temp: item.submittedTemp,
        version,
        batchId,
        updatedAt: nowIso(this.clock),
      };
      item.status = RESULT.ACCEPTED;
      item.reason = `调度员采信：封签 ${item.submittedSeal} / ${item.submittedTemp}℃（v${version}）`;
      item.detail = '';
      item.decidedBy = dispatcher;
      item.decidedAt = nowIso(this.clock);
      this.state.audit.push({
        at: item.decidedAt, type: 'accept-conflict',
        boxId: item.boxId, batchId, by: dispatcher, version,
      });
    } else {
      throw new ClientError('未知处理动作');
    }

    batch.status = batchStatusOf(batch);
    this.#persist();
    return item;
  }

  setCapacity(n, dispatcher) {
    const capacity = Number(n);
    if (!Number.isInteger(capacity) || capacity < 0) throw new ClientError('箱位数必须是非负整数');
    const occupied = slotSummary(this.state).occupied;
    if (capacity < occupied) {
      throw new ClientError(`不能低于当前有效占位箱数 ${occupied}`);
    }
    this.state.capacity = capacity;
    this.state.audit.push({
      at: nowIso(this.clock), type: 'capacity', value: capacity, by: dispatcher,
    });
    this.#persist();
  }

  // —— 页面查询 ——
  overview() {
    const state = this.state;
    const batches = Object.values(state.batches).sort((a, b) =>
      b.submittedAt.localeCompare(a.submittedAt));

    const pending = [];
    const failedRows = [];
    const voidedRows = [];
    for (const b of batches) {
      for (const it of b.items) {
        if (it.status === RESULT.CONFLICT) pending.push({ batch: b, item: it });
        if (it.status === RESULT.REJECTED) failedRows.push({ batch: b, item: it });
        if (it.status === 'voided') voidedRows.push({ batch: b, item: it });
      }
    }
    return {
      capacity: state.capacity,
      slots: slotSummary(state),
      boxes: state.boxes,
      batches,
      pending,
      failedRows,
      voidedRows,
      audit: state.audit.slice(-30).reverse(),
    };
  }
}
