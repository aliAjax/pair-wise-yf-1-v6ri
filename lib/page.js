// lib/page.js
// 业务文件之三：页面操作
// 交接台页面的数据汇总、提交/驳回操作、以及整页 HTML 渲染。
const { adjudicate, applyAccept, recalculatePositions } = require('./adjudicate');

// 把一行行 "HH:MM,温度" 的文本解析成读数数组
function parseReadings(text) {
  const lines = String(text || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const readings = [];
  for (const line of lines) {
    const m = line.match(/^([^,，]+)[,，]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!m) throw new Error(`读数格式错误：「${line}」，应为 时间,温度（如 08:00,4.2）`);
    readings.push({ time: m[1].trim(), temp: Number(m[2]) });
  }
  if (readings.length === 0) throw new Error('至少需要一条读数');
  return readings;
}

// 汇总页面数据：待处理交接、失败原因、箱位余量、箱子当前记录
function getDashboardData(store) {
  const all = store.listBatches();
  const pending = all.filter((b) => b.status === 'pending' || b.status === 'conflict');
  const failures = all.filter((b) => b.status === 'conflict' || b.status === 'rejected' || b.status === 'invalidated');
  const positions = recalculatePositions(store);
  const boxes = store.listBoxes();
  return { pending, failures, positions, boxes, all };
}

// 司机提交交接批次
function handleSubmitBatch(raw, identity, store) {
  if (!identity || identity.role !== 'driver') {
    return { ok: false, status: 403, error: '仅司机可提交交接批次' };
  }
  const batchId = String(raw.batchId || '').trim();
  const boxNo = String(raw.boxNo || '').trim();
  const sealNo = String(raw.sealNo || '').trim();
  const version = String(raw.version || '').trim();
  if (!batchId || !boxNo || !sealNo || !version) {
    return { ok: false, status: 400, error: '批次号、箱号、封签号、版本均为必填' };
  }
  // 司机只能写本车次：车次以身份为准，表单里带的车次若不一致直接拒绝
  if (raw.tripId && String(raw.tripId).trim() !== identity.tripId) {
    return { ok: false, status: 403, error: '司机只能提交本车次（车次与身份不符）' };
  }
  let readings;
  try {
    readings = parseReadings(raw.readingsText);
  } catch (e) {
    return { ok: false, status: 400, error: e.message };
  }

  const batch = {
    batchId, tripId: identity.tripId, boxNo, sealNo, version, readings,
  };

  // 同批重复提交：adjudicate 会取回首次结果，绝不重新入库
  const existing = store.getBatch(batchId);
  if (existing) {
    const det = adjudicate(batch, store);
    if (det.replay) {
      const ok = existing.status === 'accepted';
      return {
        ok, httpStatus: ok ? 200 : (existing.status === 'conflict' ? 409 : 200),
        replay: true, status: existing.status, result: det.result, reason: det.reason,
      };
    }
    // 批次号相同但内容被改 → 返回冲突，但不覆盖首次结果（首次结果不可变）
    return { ok: false, httpStatus: 409, conflict: true, reason: det.reason };
  }

  // 新批次：先判定再入库（不能先插 pending，否则 adjudicate 会查到刚插入的自己）
  const det = adjudicate(batch, store);
  const now = Date.now();
  if (det.status === 'accepted') {
    store.insertBatch({ ...batch, status: 'pending', result: null, reason: null, createdAt: now, updatedAt: now });
    const { result } = applyAccept(batch, store, { reason: det.reason });
    return { ok: true, httpStatus: 200, replay: false, status: 'accepted', result, reason: det.reason };
  }
  // 冲突：保留现场，交调度员处理
  store.insertBatch({ ...batch, status: 'conflict', result: null, reason: det.reason, createdAt: now, updatedAt: now });
  return { ok: false, httpStatus: 409, conflict: true, reason: det.reason };
}

// 调度员处理冲突：accept（强制接受，成为当前记录）或 reject（驳回）
function handleResolveConflict(raw, identity, store) {
  if (!identity || identity.role !== 'dispatcher') {
    return { ok: false, status: 403, error: '仅调度员可处理冲突' };
  }
  const batchId = String(raw.batchId || '').trim();
  const action = String(raw.action || '').trim();
  if (!batchId || !['accept', 'reject'].includes(action)) {
    return { ok: false, status: 400, error: '批次号与处理方式（accept / reject）必填' };
  }
  const existing = store.getBatch(batchId);
  if (!existing) return { ok: false, httpStatus: 404, error: '批次不存在' };
  if (existing.status !== 'conflict') {
    return { ok: false, httpStatus: 400, error: `批次状态为 ${existing.status}，无需处理` };
  }

  const now = Date.now();
  if (action === 'reject') {
    store.setBatchStatus(batchId, 'rejected', null, '调度员驳回', now);
    return { ok: true, httpStatus: 200, status: 'rejected', reason: '已驳回' };
  }
  // 强制接受：作为箱子当前记录，先前交接作废、箱位重算
  const batch = {
    batchId: existing.batchId,
    tripId: existing.tripId,
    boxNo: existing.boxNo,
    sealNo: existing.sealNo,
    version: existing.version,
    readings: existing.readings,
  };
  const { result } = applyAccept(batch, store, { reason: '调度员接受（强制）', override: true });
  return { ok: true, httpStatus: 200, status: 'accepted', result, reason: '调度员已接受' };
}

// ---------- 页面渲染 ----------
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function readingsToText(readings) {
  return readings.map((r) => `${r.time},${r.temp}`).join('\n');
}

function statusBadge(status) {
  const map = {
    accepted: ['已接受', 'ok'],
    conflict: ['冲突', 'conflict'],
    rejected: ['已驳回', 'rejected'],
    invalidated: ['已作废', 'invalid'],
    pending: ['待处理', 'pending'],
  };
  const [label, cls] = map[status] || [status, 'pending'];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

function renderDashboard(data, identity) {
  const isDriver = identity && identity.role === 'driver';
  const isDispatcher = identity && identity.role === 'dispatcher';

  const pendingRows = data.pending.map((b) => `
    <tr>
      <td class="mono">${esc(b.batchId)}</td>
      <td>${esc(b.tripId)}</td>
      <td>${esc(b.boxNo)}</td>
      <td>${esc(b.sealNo)}</td>
      <td>${esc(b.version)}</td>
      <td class="mono small">${esc(readingsToText(b.readings)).replace(/\n/g, '<br>')}</td>
      <td>${statusBadge(b.status)}</td>
      <td class="reason">${esc(b.reason || '')}</td>
      <td class="actions">
        ${isDispatcher && b.status === 'conflict' ? `
          <button class="btn accept" data-action="accept" data-batch="${esc(b.batchId)}">接受</button>
          <button class="btn reject" data-action="reject" data-batch="${esc(b.batchId)}">驳回</button>
        ` : '<span class="muted">—</span>'}
      </td>
    </tr>`).join('');

  const failureRows = data.failures.map((b) => `
    <tr>
      <td class="mono">${esc(b.batchId)}</td>
      <td>${esc(b.boxNo)}</td>
      <td>${statusBadge(b.status)}</td>
      <td class="reason">${esc(b.reason || '')}</td>
    </tr>`).join('');

  const positionRows = data.positions.map((p) => `
    <tr>
      <td class="mono">${esc(p.position)}</td>
      <td>${p.total}</td>
      <td>${p.used}</td>
      <td class="${p.remaining === 0 ? 'full' : ''}">${p.remaining}</td>
    </tr>`).join('');

  const boxRows = data.boxes.map((bx) => `
    <tr>
      <td class="mono">${esc(bx.boxNo)}</td>
      <td>${esc(bx.sealNo)}</td>
      <td>${esc(bx.version)}</td>
      <td class="mono small">${bx.readings ? esc(readingsToText(bx.readings)).replace(/\n/g, '<br>') : '<span class="muted">—</span>'}</td>
      <td>${bx.position ? esc(bx.position) : '<span class="muted">待分配</span>'}</td>
      <td class="mono small">${esc(bx.currentBatchId || '')}</td>
      <td>${bx.recordVersion}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>冷链转运站 · 交接台</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="topbar">
  <h1>冷链转运站 · 交接台</h1>
  <div class="identity">
    <span class="muted">当前身份：</span>
    <strong>${esc(identity.name)}</strong>
    <span class="muted">（${isDriver ? '司机 · 车次 ' + esc(identity.tripId) : '调度员'}）</span>
  </div>
</header>

<main class="grid">
  <section class="card full">
    <h2>身份切换</h2>
    <div class="switcher">
      <button class="btn id" data-role="driver" data-name="张师傅" data-trip="TRIP-001">司机 · 张师傅（TRIP-001）</button>
      <button class="btn id" data-role="driver" data-name="李师傅" data-trip="TRIP-002">司机 · 李师傅（TRIP-002）</button>
      <button class="btn id" data-role="dispatcher" data-name="王调度" data-trip="">调度员 · 王调度</button>
    </div>
    <p class="muted small">司机只能提交本车次交接；调度员可处理冲突（接受 / 驳回）。数据落本地，重启不丢。</p>
  </section>

  ${isDriver ? `
  <section class="card full">
    <h2>提交交接批次</h2>
    <form id="submit-form" class="form">
      <div class="row">
        <label>车次</label>
        <input type="text" value="${esc(identity.tripId)}" readonly>
      </div>
      <div class="row">
        <label>批次号</label>
        <input type="text" name="batchId" placeholder="如 BATCH-001" required>
      </div>
      <div class="row">
        <label>箱号</label>
        <input type="text" name="boxNo" placeholder="如 BOX-01" required>
      </div>
      <div class="row">
        <label>封签号</label>
        <input type="text" name="sealNo" placeholder="如 SEAL-01" required>
      </div>
      <div class="row">
        <label>版本</label>
        <input type="text" name="version" placeholder="如 v1" required>
      </div>
      <div class="row">
        <label>读数（每行 时间,温度）</label>
        <textarea name="readingsText" rows="4" placeholder="08:00,4.2&#10;09:00,5.1" required></textarea>
      </div>
      <button type="submit" class="btn primary">提交交接</button>
      <div id="submit-msg" class="msg"></div>
    </form>
  </section>` : ''}

  <section class="card">
    <h2>待处理交接 <span class="count">${data.pending.length}</span></h2>
    <table class="table">
      <thead><tr><th>批次号</th><th>车次</th><th>箱号</th><th>封签</th><th>版本</th><th>读数</th><th>状态</th><th>原因</th><th>操作</th></tr></thead>
      <tbody>${pendingRows || '<tr><td colspan="9" class="muted">暂无</td></tr>'}</tbody>
    </table>
  </section>

  <section class="card">
    <h2>失败原因 <span class="count">${data.failures.length}</span></h2>
    <table class="table">
      <thead><tr><th>批次号</th><th>箱号</th><th>状态</th><th>原因</th></tr></thead>
      <tbody>${failureRows || '<tr><td colspan="4" class="muted">暂无</td></tr>'}</tbody>
    </table>
  </section>

  <section class="card">
    <h2>箱位余量</h2>
    <table class="table">
      <thead><tr><th>箱位</th><th>总容量</th><th>已用</th><th>余量</th></tr></thead>
      <tbody>${positionRows || '<tr><td colspan="4" class="muted">暂无</td></tr>'}</tbody>
    </table>
  </section>

  <section class="card full">
    <h2>箱子当前记录</h2>
    <table class="table">
      <thead><tr><th>箱号</th><th>封签</th><th>版本</th><th>读数</th><th>箱位</th><th>当前批次</th><th>记录版本</th></tr></thead>
      <tbody>${boxRows || '<tr><td colspan="7" class="muted">暂无</td></tr>'}</tbody>
    </table>
  </section>
</main>

<script src="/app.js"></script>
</body>
</html>`;
}

module.exports = {
  getDashboardData, handleSubmitBatch, handleResolveConflict, renderDashboard, parseReadings,
};
