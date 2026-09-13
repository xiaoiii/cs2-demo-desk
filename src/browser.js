let category = 'personal', pageState = {}, appState = {}, localMessage = '';
const tip = document.querySelector('#browserTip');
function renderBrowser() {
  const sync = appState.sync?.[category] || {};
  const button = document.querySelector('#browserSync');
  button.disabled = sync.phase === 'syncing';
  button.textContent = sync.phase === 'syncing' ? '正在获取…' : '↻ 重新获取比赛';
  const hint = category === 'personal' ? '在 Steam 官方页面完成登录后会自动获取比赛；登录凭证会在本机加密保存。若未开始，可点击“重新获取比赛”。' : '完成来源网站验证后会自动继续获取，比赛将在主窗口按赛事分类。也可打开具体比赛页面，补充导入 Demo。';
  tip.textContent = localMessage || pageState.error || (pageState.loading ? '正在加载来源页面…' : sync.phase === 'syncing' ? sync.message || '正在获取比赛记录，可返回主窗口查看进度。' : hint);
}
async function call(action, data) {
  try {
    const result = await window.desk.call(action, data);
    localMessage = result.ok ? '' : result.error;
    if (result.ok && action === 'scan' && Number(result.value) > 0) localMessage = `已导入 ${Number(result.value)} 个新 Demo，可返回主窗口选择下载。`;
    if (result.ok && action === 'state') appState = result.value;
    renderBrowser();
    return result;
  } catch (error) { localMessage = error.message || '操作未完成，请重试。'; renderBrowser(); }
}
document.querySelectorAll('[data-cmd]').forEach(el => el.addEventListener('click', () => call(el.dataset.cmd, el.dataset.cmd === 'sync' ? { category } : undefined)));
document.querySelector('#addressForm').addEventListener('submit', event => { event.preventDefault(); call('browser-url', { url: document.querySelector('#address').value }); });
window.desk.browserSubscribe(next => {
  pageState = next; localMessage = '';
  let host = ''; try { host = new URL(next.url).hostname; } catch {}
  category = next.category || (/(^|\.)hltv\.org$/i.test(host) ? 'tournament' : /(^|\.)steamcommunity\.com$/i.test(host) ? 'personal' : category);
  if (document.activeElement?.id !== 'address') document.querySelector('#address').value = next.url || '';
  document.title = `${next.title || 'Demo 来源'} — ${host || '来源浏览器'}`;
  renderBrowser();
});
window.desk.subscribe(next => { appState = next; renderBrowser(); });
call('state');
