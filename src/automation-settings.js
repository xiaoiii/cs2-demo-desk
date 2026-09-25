function automationSettingsHTML() {
  const s=state.settings, sources=s.autoDownloadSources || ['personal','perfect'];
  const toggle=(id,title,description,checked)=>`<div class="settings-line"><div><h2>${title}</h2><p>${description}</p></div><label class="toggle-label"><input type="checkbox" id="${id}" aria-label="${title}" ${checked?'checked':''}><span>启用</span></label></div>`;
  return `<div class="settings-card">${toggle('openAtLogin','开机自动启动','登录 Windows 后自动打开软件。请将便携版放在固定位置；更换 EXE 或移动位置后，请重新开启此选项。',s.openAtLogin)}</div>
  <div class="settings-card">${toggle('autoDownload','启动后自动下载未下载的比赛 Demo','下次启动软件时先刷新所选来源，再下载各页面时间范围内未完成的录像。已完成、已取消及日期未知的记录会跳过；需要登录时请先登录。',s.autoDownload)}<div class="source-shortcuts">${[['personal','个人官匹'],['perfect','完美平台'],['tournament','职业赛事']].map(([key,label])=>`<label class="toggle-label"><input type="checkbox" data-auto-source="${key}" aria-label="自动下载${label}" ${sources.includes(key)?'checked':''}>${label}</label>`).join('')}</div><p>自动下载会主动刷新所选来源，不受下方“启动时自动获取比赛”开关影响。赛事较多时可能下载大量文件。</p></div>
  <div class="settings-card">${toggle('autoQuit','下载完成后自动退出','本次下载全部成功，且获取、解压与回放准备均结束后，倒计时 10 秒退出。失败、暂停、取消或获取不完整时保留窗口；自动下载无新任务时也会退出。',s.autoQuit)}<p>${escape(state.automation?.message || '尚未开始本次下载任务。')}</p></div>`;
}
function bindAutomationSettings() {
  for(const key of ['openAtLogin','autoDownload','autoQuit']){
    document.getElementById(key)?.addEventListener('change',async e=>{
      try {await call('automation-settings',{[key]:e.target.checked});}
      catch {renderPage();}
    });
  }
  document.querySelectorAll('[data-auto-source]').forEach(el=>el.addEventListener('change',async()=>{
    try {await call('automation-settings',{autoDownloadSources:[...document.querySelectorAll('[data-auto-source]:checked')].map(x=>x.dataset.autoSource)});}
    catch {renderPage();}
  }));
}
function updateAutoQuitBanner() {
  const el=document.getElementById('autoQuitBanner');
  if(!el)return;
  const active=state.automation?.phase==='countdown';el.hidden=!active;
  if(active)document.getElementById('autoQuitText').textContent=`下载已完成，${Math.max(0,Math.ceil((state.automation.quitAt-Date.now())/1000))} 秒后退出软件。`;
}
setInterval(updateAutoQuitBanner,250);
