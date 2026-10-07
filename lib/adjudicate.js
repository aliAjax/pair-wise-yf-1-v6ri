// lib/adjudicate.js
// 业务文件之二：交接判定
// 纯业务逻辑，不直接读写页面：同批幂等、冲突判定、先前交接作废、箱位余量重算。

function readingsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (String(a[i].time) !== String(b[i].time)) return false;
    if (Number(a[i].temp) !== Number(b[i].temp)) return false;
  }
  return true;
}

// 批次内容是否一致（封签、版本、读数）
function contentEqual(existing, batch) {
  return existing.sealNo === batch.sealNo
    && existing.version === batch.version
    && readingsEqual(existing.readings, batch.readings);
}

// adjudicate：只做判定，不落库。返回 { status, replay, reason, result? }
function adjudicate(batch, store) {
  const existing = store.getBatch(batch.batchId);

  // 同批重复提交：取回首次结果，绝不重新入库
  if (existing) {
    if (contentEqual(existing, batch)) {
      return {
        status: existing.status,
        replay: true,
        reason: '同批重复提交，取回首次结果',
        result: existing.result,
      };
    }
    // 批次号相同但封签/读数/版本被改 → 冲突
    return {
      status: 'conflict',
      replay: false,
      reason: '批次内容与首次提交不一致（封签/读数/版本已变更）',
    };
  }

  // 新批次：比对箱子当前记录
  const box = store.getBox(batch.boxNo);
  if (box && box.currentBatchId) {
    if (box.sealNo === batch.sealNo
      && box.version === batch.version
      && readingsEqual(box.readings, batch.readings)) {
      return { status: 'accepted', replay: false, reason: '与箱子当前记录一致（重复确认）', match: true };
    }
    return { status: 'conflict', replay: false, reason: '箱内记录已变更，本批次数据过期', stale: true };
  }

  // 新箱子首次交接
  return { status: 'accepted', replay: false, reason: '新箱子首次交接', match: false };
}

// applyAccept：交接成立后的作废与重算
// 1) 该箱子先前交接立即作废 2) 写入箱子当前记录 3) 批次置 accepted 4) 重算箱位余量
function applyAccept(batch, store, opts = {}) {
  const now = Date.now();

  // 箱子的当前记录一变，先前交接立即作废
  store.invalidateOthersForBox(batch.boxNo, batch.batchId, now);

  // 分配箱位（箱子原先没有则找第一个有余量的）
  let box = store.getBox(batch.boxNo);
  let position = box ? box.position : null;
  if (!position) position = store.firstAvailablePosition();

  // 箱子当前记录更新（记录版本 +1）
  const recordVersion = box ? (box.recordVersion || 0) + 1 : 1;
  store.upsertBox({
    boxNo: batch.boxNo,
    sealNo: batch.sealNo,
    version: batch.version,
    readings: batch.readings,
    position,
    currentBatchId: batch.batchId,
    recordVersion,
    updatedAt: now,
  });

  const reason = opts.reason || '交接成立';
  const result = { accepted: true, position, recordVersion, reason, override: !!opts.override };
  store.setBatchStatus(batch.batchId, 'accepted', result, reason, now);

  // 重算剩余箱位
  const positions = recalculatePositions(store);
  return { result, positions };
}

// recalculatePositions：逐箱位重算 已用 / 余量
function recalculatePositions(store) {
  return store.listPositions().map((p) => {
    const used = store.countBoxesAtPosition(p.position);
    return { position: p.position, total: p.total, used, remaining: p.total - used };
  });
}

module.exports = { adjudicate, applyAccept, recalculatePositions, readingsEqual, contentEqual };
