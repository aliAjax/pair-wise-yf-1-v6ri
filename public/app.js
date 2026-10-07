// public/app.js — 交接台前端交互
function reload() { window.location.reload(); }

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// 身份切换
document.querySelectorAll('.btn.id').forEach((btn) => {
  btn.addEventListener('click', async () => {
    await post('/api/identity', {
      role: btn.dataset.role,
      name: btn.dataset.name,
      tripId: btn.dataset.trip,
    });
    reload();
  });
});

// 司机提交
const form = document.getElementById('submit-form');
if (form) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('submit-msg');
    msg.className = 'msg';
    msg.textContent = '提交中…';
    const fd = new FormData(form);
    const body = {
      batchId: fd.get('batchId'),
      boxNo: fd.get('boxNo'),
      sealNo: fd.get('sealNo'),
      version: fd.get('version'),
      readingsText: fd.get('readingsText'),
    };
    const { ok, data } = await post('/api/batches', body);
    if (ok) {
      msg.className = 'msg ok';
      msg.textContent = data.replay
        ? `取回首次结果：${data.reason}（状态 ${data.status}）`
        : `交接成立：${data.reason}${data.result && data.result.position ? '，箱位 ' + data.result.position : ''}`;
      setTimeout(reload, 900);
    } else {
      msg.className = 'msg err';
      msg.textContent = `失败：${data.error || data.reason || '未知错误'}`;
    }
  });
}

// 调度员处理冲突
document.querySelectorAll('.btn.accept, .btn.reject').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const action = btn.dataset.action;
    const batchId = btn.dataset.batch;
    const { ok, data } = await post(`/api/batches/${encodeURIComponent(batchId)}/resolve`, { action });
    if (ok) {
      reload();
    } else {
      alert(`处理失败：${data.error || data.reason || '未知错误'}`);
    }
  });
});
