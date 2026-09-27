let steamNetworkBusy = false, steamNetworkResults = [];
function networkSettingsHTML() {
  return `<div class="settings-card"><div class="settings-line"><div><h2>内置 Steam 网页加速</h2><p>帮助打开软件内的 Steam 登录、社区和比赛记录页面，也用于完美平台的 Steam 授权。无需另外安装代理软件。</p></div><label class="toggle-label"><input type="checkbox" id="steamAcceleration" aria-label="内置 Steam 网页加速" ${state.settings.steamNetwork?.enabled ? 'checked' : ''} ${steamNetworkBusy ? 'disabled' : ''}><span>${state.settings.steamNetwork?.enabled ? '已开启' : '未开启'}</span></label></div><p>仅作用于本软件，不加速 Steam 客户端或游戏。连接效果取决于当前网络，打不开时可测试连接或关闭后重试。</p><button class="button subtle small" id="testSteamNetwork" ${steamNetworkBusy ? 'disabled' : ''}>${steamNetworkBusy ? '正在处理…' : '测试 Steam 连接'}</button><div id="steamNetworkResults" role="status">${steamNetworkResults.map(x => `<p>${x.ok ? '✓' : '×'} ${escape(x.name)}：${escape(x.message)}</p>`).join('')}</div></div>`;
}
function bindNetworkSettings() {
  $('#steamAcceleration')?.addEventListener('change', async e => {
    const enabled = e.target.checked;
    steamNetworkBusy = true; steamNetworkResults = []; renderPage();
    try { state.settings.steamNetwork = await call('steam-network-save', { enabled }); }
    catch {} finally { steamNetworkBusy = false; if (page === 'settings') renderPage(); }
  });
  $('#testSteamNetwork')?.addEventListener('click', async () => {
    steamNetworkBusy = true; steamNetworkResults = []; renderPage();
    try { steamNetworkResults = await call('steam-network-test', { enabled: state.settings.steamNetwork?.enabled === true }); }
    catch {} finally { steamNetworkBusy = false; if (page === 'settings') renderPage(); }
  });
}
