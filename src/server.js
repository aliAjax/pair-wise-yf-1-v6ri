// 页面操作：零依赖 HTTP 服务。
// 角色：driver（司机，只能提交/重查自己车次的批次）、dispatcher（调度员，可处理冲突、改箱位）。
// 数据全部落在本地 JSON 文件，服务重启后批次、冲突、余量、失败原因均可继续查询。

import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, ClientError } from './store.js';
import { BATCH_STATUS_LABEL, RESULT } from './judge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.DATA_FILE || join(__dirname, '..', 'data', 'handover.json');
const PORT = Number(process.env.PORT ?? 3000);

// 演示账号：真实部署可换成外部账号源，鉴权语义不变。
const USERS = [
  { username: 'driver1', password: '123456', role: 'driver', name: '王司机', tripId: 'TRIP-01' },
  { username: 'driver2', password: '123456', role: 'driver', name: '李司机', tripId: 'TRIP-02' },
  { username: 'dispatcher', password: '123456', role: 'dispatcher', name: '张调度' },
];

const sessions = new Map(); // token -> user（重启后要求重新登录，业务数据不受影响）
const store = new Store(DATA_FILE);

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function currentUser(req) {
  const token = parseCookies(req).session;
  return token && sessions.get(token) ? sessions.get(token) : null;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) { reject(new ClientError('提交内容过大')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      const params = new URLSearchParams(data);
      resolve(Object.fromEntries(params));
    });
    req.on('error', reject);
  });
}

function redirect(res, location, setCookie) {
  res.writeHead(303, {
    location,
    ...(setCookie ? { 'set-cookie': setCookie } : {}),
  });
  res.end();
}

// 从页面输入框解析批次行：一行一箱，箱号,封签号,版本,读数
function parseLines(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

// —— 页面渲染 ——
const STATUS_BADGE = {
  accepted: '<span class="badge ok">正常</span>',
  conflict: '<span class="badge conflict">冲突</span>',
  rejected: '<span class="badge fail">失败</span>',
  voided: '<span class="badge void">已作废</span>',
};

function layout(user, body, flash = '') {
  const nav = user
    ? `<form method="post" action="/logout" class="nav">
         <span class="who">${esc(user.name)}（${user.role === 'dispatcher' ? '调度员' : `司机 · ${esc(user.tripId)}`}）</span>
         <button class="btn small" type="submit">退出登录</button>
       </form>`
    : '';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>冷链交接台</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif; background:#f4f6f8; color:#1f2933; }
  header { background:#0f2f48; color:#fff; padding:12px 20px; display:flex; justify-content:space-between; align-items:center; }
  header h1 { font-size:17px; margin:0; font-weight:600; }
  main { max-width:1080px; margin:20px auto; padding:0 16px; }
  .card { background:#fff; border:1px solid #e2e8ee; border-radius:8px; padding:16px 18px; margin-bottom:18px; }
  .card h2 { font-size:15px; margin:0 0 12px; display:flex; align-items:center; gap:8px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; }
  .stat { background:#f8fafc; border:1px solid #e6edf3; border-radius:6px; padding:10px 12px; }
  .stat b { display:block; font-size:24px; }
  .stat .k { color:#64748b; font-size:12px; }
  .stat.warn b { color:#b45309; } .stat.danger b { color:#b91c1c; } .stat.good b { color:#15803d; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:7px 8px; border-bottom:1px solid #edf1f5; vertical-align:top; }
  th { color:#64748b; font-weight:600; background:#fafbfc; }
  .badge { display:inline-block; padding:1px 8px; border-radius:10px; font-size:12px; white-space:nowrap; }
  .badge.ok { background:#dcfce7; color:#166534; }
  .badge.conflict { background:#fef3c7; color:#92400e; }
  .badge.fail { background:#fee2e2; color:#991b1b; }
  .badge.void { background:#e5e7eb; color:#4b5563; }
  .reason { color:#9a3412; } .muted { color:#64748b; } .small2 { font-size:12px; }
  .btn { background:#0f2f48; color:#fff; border:0; border-radius:5px; padding:7px 14px; cursor:pointer; font-size:13px; }
  .btn.small { padding:3px 10px; font-size:12px; }
  .btn.green { background:#15803d; } .btn.gray { background:#6b7280; }
  .inline { display:inline; }
  textarea,input,select { width:100%; padding:7px 9px; border:1px solid #cbd5e1; border-radius:5px; font:inherit; }
  textarea { height:110px; font-family:ui-monospace,Menlo,monospace; }
  label { display:block; font-size:12px; color:#475569; margin:8px 0 3px; }
  .flash { background:#fef3c7; border:1px solid #fcd34d; color:#78350f; padding:9px 12px; border-radius:6px; margin-bottom:16px; }
  .login { max-width:340px; margin:60px auto; }
  .hint { background:#f1f5f9; border-radius:5px; padding:8px 10px; font-size:12px; color:#475569; margin-top:6px; }
  code { background:#f1f5f9; padding:1px 4px; border-radius:3px; }
  .nav { display:flex; gap:12px; align-items:center; margin:0; }
  .who { font-size:13px; opacity:.9; }
</style></head><body>
<header><h1>🧊 冷链转运站 · 交接台</h1>${nav}</header>
<main>${flash ? `<div class="flash">${flash}</div>` : ''}${body}</main>
</body></html>`;
}

function loginPage(flash) {
  return layout(null, `<div class="card login">
  <h2>登录</h2>
  <form method="post" action="/login">
    <label>用户名</label><input name="username" required autofocus>
    <label>密码</label><input name="password" type="password" required>
    <p><button class="btn" type="submit">登录</button></p>
  </form>
  <div class="hint">演示账号：driver1 / driver2（司机，密码 123456）；dispatcher（调度员，密码 123456）</div>
</div>`, flash);
}

function dashboard(user, flash) {
  const ov = store.overview();
  const { slots } = ov;
  const slotClass = slots.remaining === 0 ? 'danger' : slots.remaining <= 3 ? 'warn' : 'good';

  // 提交表单（仅司机本人车次）
  const submitCard = user.role === 'driver' ? `<div class="card">
    <h2>📝 登记交接批次（车次 ${esc(user.tripId)}）</h2>
    <form method="post" action="/submit">
      <label>批次号（断网时由车上生成，留空则系统发号；同号重交自动取回首次结果）</label>
      <input name="batchId" placeholder="例如 OFF-${esc(user.tripId)}-20261007-01">
      <label>箱号,封签号,版本,读数（一行一箱，断网期间逐箱登记）</label>
      <textarea name="lines" placeholder="A001,SL-8801,0,4.2&#10;A002,SL-8802,0,3.8"></textarea>
      <div class="hint">新箱版本填 <code>0</code>；重复看到同封签同读数按“干净箱”放行且不重复占位；
      封签号或温度与在站记录不一致会进冲突队列，由调度员处理，不会覆盖旧温度与箱位。</div>
      <p><button class="btn" type="submit">提交 / 重试提交</button></p>
    </form>
  </div>` : '';

  // 调度能力
  const capacityCard = user.role === 'dispatcher' ? `<div class="card">
    <h2>⚙️ 箱位设置</h2>
    <form method="post" action="/capacity" class="inline">
      <input type="hidden" name="from" value="top">
      <label>总箱位数（不能低于当前有效占位数 ${slots.occupied}）</label>
      <div style="display:flex;gap:8px;align-items:center">
        <input style="max-width:140px" name="capacity" type="number" min="0" value="${slots.capacity}">
        <button class="btn small" type="submit">保存</button>
      </div>
    </form>
  </div>` : '';

  // 待处理冲突
  const pendingRows = ov.pending.map(({ batch, item }) => {
    const cur = ov.boxes[item.boxId];
    const controls = user.role === 'dispatcher'
      ? `<form class="inline" method="post" action="/resolve">
          <input type="hidden" name="batchId" value="${esc(batch.id)}">
          <input type="hidden" name="itemId" value="${esc(item.id)}">
          <button class="btn small green" name="action" value="accept">采信车上</button>
          <button class="btn small gray" name="action" value="reject">维持在站</button>
        </form>`
      : '<span class="muted small2">待调度员处理</span>';
    return `<tr>
      <td>${esc(batch.id)}<div class="muted small2">${esc(batch.tripId)} · ${esc(batch.driver)}</div></td>
      <td><b>${esc(item.boxId)}</b></td>
      <td>车：${esc(item.submittedSeal)} / ${esc(item.submittedTemp)}℃<br>
          <span class="muted small2">版本 v${esc(item.submittedVersion)} · ${fmtTime(batch.submittedAt)}</span></td>
      <td>${cur ? `站：${esc(cur.seal)} / ${esc(cur.temp)}℃<br><span class="muted small2">版本 v${esc(cur.version)}</span>` : '—'}</td>
      <td class="reason small2">${esc(item.reason)}</td>
      <td>${controls}</td>
    </tr>`;
  }).join('');

  // 全部批次
  const batchRows = ov.batches.map((b) => {
    const counts = b.items.reduce((acc, i) => { acc[i.status] = (acc[i.status] || 0) + 1; return acc; }, {});
    const mine = user.role === 'dispatcher' || b.tripId === user.tripId;
    const summary = ['accepted', 'conflict', 'rejected', 'voided']
      .filter((k) => counts[k]).map((k) => `${STATUS_BADGE[k]} ${counts[k]}`).join(' ');
    return `<tr${mine ? '' : ' class="muted"'}>
      <td>${esc(b.id)}${mine ? '' : ' <span class="small2">(其他车次)</span>'}</td>
      <td>${esc(b.tripId)}<div class="muted small2">${esc(b.driver)}</div></td>
      <td>${b.items.length}</td>
      <td>${summary || '—'}</td>
      <td>${esc(BATCH_STATUS_LABEL[b.status] || b.status)}</td>
      <td>${fmtTime(b.submittedAt)}</td>
      <td><a class="small2" href="/batch/${encodeURIComponent(b.id)}">详情</a></td>
    </tr>`;
  }).join('');

  // 失败原因
  const failRows = ov.failedRows.map(({ batch, item }) => `<tr>
      <td>${esc(batch.id)}<div class="muted small2">${fmtTime(batch.submittedAt)}</div></td>
      <td>${esc(item.boxId) || '—'}</td>
      <td>${esc(batch.tripId)} · ${esc(batch.driver)}</td>
      <td class="reason">${esc(item.reason)}${item.detail ? `<div class="muted small2">${esc(item.detail)}</div>` : ''}</td>
      ${user.role === 'dispatcher' && item.status === RESULT.REJECTED && item.boxId
        ? `<td><form class="inline" method="post" action="/retry-accept"><input type="hidden" name="batchId" value="${esc(batch.id)}"><input type="hidden" name="itemId" value="${esc(item.id)}"><button class="btn small gray">调度员直接采信</button></form></td>`
        : '<td></td>'}
    </tr>`).join('');

  const voidRows = ov.voidedRows.map(({ batch, item }) => `<tr>
      <td>${esc(batch.id)}</td><td>${esc(item.boxId)}</td>
      <td>${esc(batch.tripId)} · ${esc(batch.driver)}</td>
      <td class="muted small2">${esc(item.voidedBecause || '记录已被更新')} · ${fmtTime(item.voidedAt)}</td>
    </tr>`).join('');

  // 当前箱记录
  const boxRows = Object.values(ov.boxes).sort((a, b) => a.boxId.localeCompare(b.boxId)).map((x) => `<tr>
      <td><b>${esc(x.boxId)}</b></td><td>${esc(x.seal)}</td><td>${esc(x.temp)}℃</td>
      <td>v${esc(x.version)}</td><td>${esc(x.batchId)}</td><td>${fmtTime(x.updatedAt)}</td>
    </tr>`).join('');

  return layout(user, `
  <div class="card">
    <h2>📦 箱位余量</h2>
    <div class="grid">
      <div class="stat ${slotClass}"><b>${slots.remaining}</b><span class="k">剩余箱位</span></div>
      <div class="stat"><b>${slots.occupied}</b><span class="k">有效交接占位（去重箱号）</span></div>
      <div class="stat"><b>${slots.capacity}</b><span class="k">总箱位</span></div>
      <div class="stat ${ov.pending.length ? 'warn' : 'good'}"><b>${ov.pending.length}</b><span class="k">待处理冲突</span></div>
    </div>
  </div>
  ${capacityCard}
  ${submitCard}
  <div class="card">
    <h2>🚧 待处理交接（冲突队列 ${ov.pending.length}）</h2>
    ${pendingRows ? `<table><thead><tr><th>批次/车次</th><th>箱号</th><th>车上登记</th><th>在站当前</th><th>冲突原因</th><th>调度处理</th></tr></thead><tbody>${pendingRows}</tbody></table>`
      : '<p class="muted">暂无冲突。换封签或改读数的交接会出现在这里，旧温度和箱位不会被直接覆盖。</p>'}
  </div>
  <div class="card">
    <h2>📋 交接批次</h2>
    ${batchRows ? `<table><thead><tr><th>批次</th><th>车次/司机</th><th>箱行数</th><th>行结果</th><th>批次状态</th><th>提交时间</th><th></th></tr></thead><tbody>${batchRows}</tbody></table>` : '<p class="muted">还没有批次。</p>'}
  </div>
  <div class="card">
    <h2>❌ 失败行与原因（${ov.failedRows.length}）</h2>
    ${failRows ? `<table><thead><tr><th>批次</th><th>箱号</th><th>来源</th><th>失败原因</th><th></th></tr></thead><tbody>${failRows}</tbody></table>` : '<p class="muted">暂无失败行。</p>'}
  </div>
  <div class="card">
    <h2>♻️ 已作废交接（箱记录变更后自动失效，${ov.voidedRows.length}）</h2>
    ${voidRows ? `<table><thead><tr><th>批次</th><th>箱号</th><th>原车次</th><th>作废原因/时间</th></tr></thead><tbody>${voidRows}</tbody></table>` : '<p class="muted">暂无作废记录。干净箱的重复提交不会产生作废。</p>'}
  </div>
  <div class="card">
    <h2>🧊 箱子当前记录（${Object.keys(ov.boxes).length}）</h2>
    ${boxRows ? `<table><thead><tr><th>箱号</th><th>封签</th><th>温度</th><th>版本</th><th>来自批次</th><th>更新时间</th></tr></thead><tbody>${boxRows}</tbody></table>` : '<p class="muted">站内尚无箱子记录。</p>'}
  </div>`, flash);
}

function batchDetail(user, id, flash) {
  const batch = store.snapshot().batches[id];
  if (!batch) return dashboard(user, '批次不存在');
  const rows = batch.items.map((it) => `<tr>
    <td>${esc(it.boxId) || '—'}</td>
    <td>${STATUS_BADGE[it.status] || esc(it.status)}</td>
    <td>${esc(it.submittedSeal) || '—'} / ${it.submittedTemp ?? '—'}℃ <span class="muted small2">v${esc(it.submittedVersion)}</span></td>
    <td class="reason small2">${esc(it.reason)}${it.detail ? `<br>${esc(it.detail)}` : ''}${it.voidedBecause ? `<br><span class="muted">作废：${esc(it.voidedBecause)} · ${fmtTime(it.voidedAt)}</span>` : ''}${it.decidedBy ? `<br><span class="muted">调度：${esc(it.decidedBy)} · ${fmtTime(it.decidedAt)}</span>` : ''}</td>
    <td>${user.role === 'dispatcher' && it.status === RESULT.CONFLICT
      ? `<form class="inline" method="post" action="/resolve"><input type="hidden" name="batchId" value="${esc(batch.id)}"><input type="hidden" name="itemId" value="${esc(it.id)}"><button class="btn small green" name="action" value="accept">采信</button> <button class="btn small gray" name="action" value="reject">驳回</button></form>`
      : ''}</td>
  </tr>`).join('');
  const body = `<div class="card">
    <h2>批次 ${esc(batch.id)} <span class="muted small2">${esc(batch.tripId)} · ${esc(batch.driver)} · ${fmtTime(batch.submittedAt)}</span></h2>
    <table><thead><tr><th>箱号</th><th>结果</th><th>车上登记</th><th>判定/原因</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    <p><a href="/">← 返回交接台</a></p>
  </div>`;
  return layout(user, body, flash);
}

// —— 路由 ——
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const { pathname } = url;
    const user = currentUser(req);

    if (req.method === 'GET' && pathname === '/login') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(loginPage(''));
    }

    if (req.method === 'POST' && pathname === '/login') {
      const body = await parseBody(req);
      const found = USERS.find((u) => u.username === body.username && u.password === body.password);
      if (!found) return res.end(loginPage('用户名或密码错误'));
      const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      sessions.set(token, found);
      return redirect(res, '/', `session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax`);
    }

    if (req.method === 'POST' && pathname === '/logout') {
      const token = parseCookies(req).session;
      if (token) sessions.delete(token);
      return redirect(res, '/login', 'session=; Path=/; Max-Age=0');
    }

    if (!user) return redirect(res, '/login');

    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      const msg = url.searchParams.get('msg');
      return res.end(dashboard(user, msg ? esc(msg) : ''));
    }

    if (req.method === 'GET' && pathname.startsWith('/batch/')) {
      const id = decodeURIComponent(pathname.slice('/batch/'.length));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(batchDetail(user, id));
    }

    if (req.method === 'POST' && pathname === '/submit') {
      if (user.role !== 'driver') throw new ClientError('只有司机能登记交接');
      const body = await parseBody(req);
      const lines = parseLines(body.lines);
      const { batch, duplicate } = store.submitBatch({
        batchId: body.batchId?.trim() || undefined,
        tripId: user.tripId,       // 车次取自登录身份，司机不能代写其它车次
        driver: user.name,
        lines,
      });
      const target = `/batch/${encodeURIComponent(batch.id)}`;
      const msg = duplicate
        ? '该批次此前已提交，取回首次结果，未重复入库'
        : '批次已登记';
      return redirect(res, `${target}?msg=${encodeURIComponent(msg)}`);
    }

    if (req.method === 'POST' && pathname === '/resolve') {
      if (user.role !== 'dispatcher') throw new ClientError('只有调度员能处理冲突');
      const body = await parseBody(req);
      store.resolveConflict(body.batchId, body.itemId, body.action, user.name);
      return redirect(res, `/?msg=${encodeURIComponent(`冲突已${body.action === 'accept' ? '采信（旧交接作废，箱位已重算）' : '驳回'}`)}`);
    }

    if (req.method === 'POST' && pathname === '/capacity') {
      if (user.role !== 'dispatcher') throw new ClientError('只有调度员能改箱位');
      const body = await parseBody(req);
      store.setCapacity(body.capacity, user.name);
      return redirect(res, '/?msg=' + encodeURIComponent('箱位数已更新'));
    }

    if (req.method === 'POST' && pathname === '/retry-accept') {
      // 调度员对失败行（如版本过期被拒）的兜底采信，复用冲突裁决通道。
      if (user.role !== 'dispatcher') throw new ClientError('只有调度员能这样操作');
      const body = await parseBody(req);
      const b = store.snapshot().batches[body.batchId];
      const it = b?.items.find((x) => x.id === body.itemId);
      if (!it) throw new ClientError('行不存在');
      if (it.status !== RESULT.REJECTED) throw new ClientError('该行不是失败状态');
      // 先把行转回冲突，再走标准采信，保证作废/版本/落盘逻辑只有一条路径。
      it.status = RESULT.CONFLICT;
      it.reason = `调度员介入复核（原失败原因：${it.reason}）`;
      store.resolveConflict(body.batchId, body.itemId, 'accept', user.name);
      return redirect(res, '/?msg=' + encodeURIComponent('已由调度员采信并更新当前记录'));
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  } catch (err) {
    const msg = err instanceof ClientError ? err.message : `服务器错误：${err.message}`;
    if (!(err instanceof ClientError)) console.error(err);
    res.writeHead(err instanceof ClientError ? 400 : 500, { 'content-type': 'text/html; charset=utf-8' });
    res.end(layout(currentUser(req), `<div class="card"><p class="reason">${esc(msg)}</p><p><a href="/">返回</a></p></div>`));
  }
});

server.listen(PORT, () => {
  console.log(`冷链交接台已启动：http://localhost:${PORT}`);
  console.log(`数据文件：${DATA_FILE}（修改箱记录会自动作废旧交接并重算箱位）`);
});
