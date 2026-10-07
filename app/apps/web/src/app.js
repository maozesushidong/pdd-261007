const $ = (id) => document.getElementById(id);
const api = (path) => fetch(`http://${location.hostname || '127.0.0.1'}:3000${path}`).then((r) => r.json());
const esc = (value) => String(value ?? '-').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
async function refresh() {
  const selectedShop = $('shop').value;
  const [summary, shops, orders, verifications] = await Promise.all([
    api('/api/v1/metrics/summary'), api('/api/v1/shops'), api(`/api/v1/work-orders?shopId=${encodeURIComponent($('shop').value)}&status=${encodeURIComponent($('status').value)}`), api('/api/v1/verifications'),
  ]);
  $('total').textContent = summary.data.total; $('success').textContent = summary.data.autoSuccess; $('manual').textContent = summary.data.manualReview; $('failed').textContent = summary.data.failed; $('processing').textContent = summary.data.processing;
  $('shop').innerHTML = '<option value="">全部店铺</option>' + shops.data.map((s) => `<option value="${esc(s.shopId)}">${esc(s.name || s.shopId)}</option>`).join('');
  $('shop').value = shops.data.some((s) => s.shopId === selectedShop) ? selectedShop : '';
  $('orders').innerHTML = orders.data.length ? orders.data.map((row) => `<tr><td>${esc(row.shopId)}</td><td>${esc(row.orderNumber)}</td><td><span class="tag">${esc(row.scenarioCode)}</span></td><td>${esc(row.carrier)}<br>${esc(row.trackingNumber)}</td><td>${esc(row.status)}</td><td>${esc(row.updatedAt)}</td></tr>`).join('') : '<tr><td colspan="6" class="empty">暂无工单</td></tr>';
  $('shops').innerHTML = shops.data.map((s) => `<div style="padding:12px 0;border-bottom:1px solid #edf0f5"><strong>${esc(s.name || s.shopId)}</strong><br><span class="${s.step === 'flow-paused' ? 'danger' : 'healthy'}">● ${esc(s.step)}</span> · ${esc(s.currentOrderNumber || '队列空闲')}</div>`).join('') || '暂无店铺';
  $('verifications').innerHTML = verifications.data.length ? verifications.data.map((v) => `<div style="padding:10px 0"><span class="tag">${esc(v.system)}</span> ${esc(v.shopId)}<br><small>${esc(v.stage)} · ${esc(v.url)}</small></div>`).join('') : '暂无验证码或滑块';
  $('connection').textContent = '● 已连接'; $('connection').style.color = '#7ff2bb';
}
$('refresh').addEventListener('click', refresh); $('verification').addEventListener('click', () => { $('verifications').scrollIntoView({ behavior: 'smooth' }); }); refresh();
try { const events = new EventSource(`http://${location.hostname || '127.0.0.1'}:3000/api/v1/events`); events.onmessage = refresh; events.onerror = () => { $('connection').textContent = '● 已断开'; $('connection').style.color = '#ff9c9c'; }; } catch {}
