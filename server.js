// server.js — 冷链转运站交接台入口
const express = require('express');
const store = require('./lib/store');
const page = require('./lib/page');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// 简易 cookie 解析（不引额外依赖）
app.use((req, res, next) => {
  req.cookies = {};
  const raw = req.headers.cookie;
  if (raw) {
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i > -1) req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  next();
});

const DRIVERS = [
  { role: 'driver', name: '张师傅', tripId: 'TRIP-001' },
  { role: 'driver', name: '李师傅', tripId: 'TRIP-002' },
];
const DISPATCHERS = [
  { role: 'dispatcher', name: '王调度', tripId: null },
];
const DEFAULT_IDENTITY = DRIVERS[0];

function getIdentity(req) {
  try {
    const c = req.cookies.identity;
    if (c) {
      const obj = JSON.parse(c);
      if (obj && (obj.role === 'driver' || obj.role === 'dispatcher')) return obj;
    }
  } catch (e) { /* ignore */ }
  return DEFAULT_IDENTITY;
}

// 整页
app.get('/', (req, res) => {
  const identity = getIdentity(req);
  const data = page.getDashboardData(store);
  res.send(page.renderDashboard(data, identity));
});

// 司机提交交接批次
app.post('/api/batches', (req, res) => {
  const identity = getIdentity(req);
  const out = page.handleSubmitBatch(req.body, identity, store);
  res.status(out.httpStatus || (out.ok ? 200 : 400)).json(out);
});

// 调度员处理冲突
app.post('/api/batches/:batchId/resolve', (req, res) => {
  const identity = getIdentity(req);
  const out = page.handleResolveConflict(
    { ...req.body, batchId: req.params.batchId }, identity, store,
  );
  res.status(out.httpStatus || (out.ok ? 200 : 400)).json(out);
});

// 页面数据（供前端局部刷新）
app.get('/api/dashboard', (req, res) => {
  res.json(page.getDashboardData(store));
});

// 身份切换
app.post('/api/identity', (req, res) => {
  const { role, name, tripId } = req.body;
  let identity;
  if (role === 'dispatcher') {
    identity = DISPATCHERS[0];
  } else {
    identity = DRIVERS.find((d) => d.tripId === tripId) || DRIVERS.find((d) => d.name === name) || DEFAULT_IDENTITY;
  }
  res.cookie('identity', JSON.stringify(identity), { httpOnly: true });
  res.json({ ok: true, identity });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`冷链转运站交接台已启动：http://localhost:${PORT}`);
});
