// 交接判定：纯业务逻辑，不碰存储、不碰网络，便于单测。
// 判定结果类型：accepted（正常入库）/ conflict（封签或读数被换，等调度员）
// / rejected（请求本身不合法：缺字段、版本旧、箱位满等，不属于冲突）。

export const RESULT = Object.freeze({
  ACCEPTED: 'accepted',
  CONFLICT: 'conflict',
  REJECTED: 'rejected',
});

export const REASON = Object.freeze({
  MISSING_BOX: '缺箱号',
  MISSING_SEAL: '缺封签号',
  BAD_VERSION: '版本不是非负整数',
  BAD_TEMP: '温度读数不是数字',
  DUPLICATE_BATCH_LINE: '同批箱号重复',
  STALE_VERSION: '版本已过期（车站里有更新的记录）',
  SEAL_MISMATCH: '封签号与车站当前记录不一致',
  TEMP_MISMATCH: '温度读数与车站当前记录不一致',
  NO_SLOT: '箱位已满',
  CLEAN_BOX: '干净箱：封签与读数均一致',
  NEW_BOX: '新箱：本站尚无记录',
});

// 把页面/接口传入的原始行归一成 { boxId, seal, version, temp }，并报缺字段。
export function normalizeItem(raw) {
  const str = (raw ?? '').toString().trim();
  if (!str) return { ok: false, reason: REASON.MISSING_BOX };

  // 按位置解析：箱号,封签,版本,读数（兼容中文逗号/分号；空字段必须保留以便报缺项）
  const parts = str.split(/[,，;；]/).map((p) => p.trim());
  const partialBox = (parts[0] || '').toUpperCase();
  const fail = (reason) => ({ ok: false, reason, partial: { boxId: partialBox } });
  if (parts.length < 4) {
    return fail(!parts[0] ? REASON.MISSING_BOX : REASON.MISSING_SEAL);
  }
  const [boxRaw, sealRaw, verRaw, tempRaw] = parts;
  const boxId = (boxRaw || '').trim().toUpperCase();
  const seal = (sealRaw || '').trim().toUpperCase();
  if (!boxId) return fail(REASON.MISSING_BOX);
  if (!seal) return fail(REASON.MISSING_SEAL);

  if (!/^\d+$/.test(String(verRaw).trim())) return fail(REASON.BAD_VERSION);
  const version = Number(String(verRaw).trim());

  const temp = Number(String(tempRaw).trim());
  if (!Number.isFinite(temp)) return fail(REASON.BAD_TEMP);

  return { ok: true, item: { boxId, seal, version, temp } };
}

// 核心判定。state 是 store 中的全量状态（只读使用）。
// 返回 { status, reason, identical?, detail? }，不修改任何数据。
export function adjudicateItem(item, state, options = {}) {
  const { boxId, seal, version, temp } = item;
  const current = state.boxes[boxId];

  // 同批重复箱号由提交方先挡掉，这里再兜一层。
  if (options.duplicateInBatch) {
    return { status: RESULT.REJECTED, reason: REASON.DUPLICATE_BATCH_LINE };
  }

  if (!current) {
    // 新箱：首次进站，按提交版本建立记录；先看有没有箱位。
    if (slotSummary(state).remaining <= 0) {
      return { status: RESULT.REJECTED, reason: REASON.NO_SLOT };
    }
    return { status: RESULT.ACCEPTED, reason: REASON.NEW_BOX };
  }

  // 旧版本：车上抄的是过期底单，无论内容如何都不能覆盖新记录。
  if (version < current.version) {
    return {
      status: RESULT.REJECTED,
      reason: REASON.STALE_VERSION,
      detail: `提交版本 v${version}，当前 v${current.version}`,
    };
  }

  const sealSame = seal === current.seal;
  const tempSame = Number(temp) === Number(current.temp);

  // 封签号和读数都没变：幂等的重复交接，直接取回“一致”结果，不动记录、不动箱位。
  if (sealSame && tempSame) {
    return { status: RESULT.ACCEPTED, reason: REASON.CLEAN_BOX, identical: true };
  }

  // 换了封签或换了读数：旧温度/箱位不能被悄悄覆盖，转冲突队列。
  const conflicts = [];
  if (!sealSame) {
    conflicts.push(`${REASON.SEAL_MISMATCH}（提交 ${seal} / 在站 ${current.seal}）`);
  }
  if (!tempSame) {
    conflicts.push(`${REASON.TEMP_MISMATCH}（提交 ${temp}℃ / 在站 ${current.temp}℃）`);
  }
  const stale = version > current.version
    ? `（车单 v${version} 新于在站 v${current.version}，等待调度员采信）`
    : `（同版本 v${version} 内容不一致）`;
  return {
    status: RESULT.CONFLICT,
    reason: conflicts.join('；') + stale,
  };
}

// 重算箱位余量：以“当前仍有效（accepted）的交接”为准，按不重复箱号计占位数。
// 被作废/冲突/拒绝的交接都不占位；同一箱多次一致提交只占一个位。
export function slotSummary(state) {
  const occupiedBoxes = new Set();
  for (const batch of Object.values(state.batches)) {
    for (const it of batch.items) {
      if (it.status === RESULT.ACCEPTED) occupiedBoxes.add(it.boxId);
    }
  }
  const capacity = state.capacity;
  return {
    capacity,
    occupied: occupiedBoxes.size,
    remaining: Math.max(0, capacity - occupiedBoxes.size),
    occupiedBoxes: [...occupiedBoxes].sort(),
  };
}

// 根据批次内各行当前状态汇总批次状态。
export function batchStatusOf(batch) {
  const items = batch.items;
  if (items.length === 0) return 'empty';
  if (items.every((i) => i.status === 'voided')) return 'voided';
  if (items.some((i) => i.status === RESULT.CONFLICT)) return 'conflict';
  if (items.some((i) => i.status === RESULT.REJECTED)) return 'rejected';
  if (items.every((i) => i.status === RESULT.ACCEPTED)) return 'accepted';
  return 'mixed';
}

// 调度员裁决后，批次可能同时残留 accepted/conflict/rejected，统一用 mixed 表达。
export const BATCH_STATUS_LABEL = Object.freeze({
  accepted: '全部正常',
  conflict: '有冲突待处理',
  rejected: '有失败行',
  mixed: '部分处理',
  voided: '已全部作废',
  empty: '空批次',
});
