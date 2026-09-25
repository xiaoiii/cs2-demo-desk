const {normalizeOptions} = require('./startup-settings');
const busyStatuses = new Set(['queued','resolving','connecting','downloading','paused']);
const queueable = new Set(['ready','catalog','failed','interrupted']);
function createDownloadAutomation({state, queue, isBusy, quit, onChange, now = Date.now, delay = 10000}) {
  let startup = null, automatic = false, armed = false, finished = false, suppressed = false;
  let tracked = new Set(), attempted = new Set(), quitAt = 0;
  function update(phase,message) {
    const next = {phase,message,quitAt};
    if (JSON.stringify(next) !== JSON.stringify(state.automation)) { state.automation = next; onChange(); }
  }
  function track(ids) {
    if (!ids.length) return;
    if (finished) { tracked = new Set(); finished = false; startup = null; }
    ids.forEach(id=>tracked.add(id)); armed = true; quitAt = 0;
  }
  function begin(sources) {
    startup = {sources:[...sources],settled:false};
    automatic = true; armed = true; finished = false; tracked = new Set(); attempted = new Set(); quitAt = 0;
    update('syncing','启动后正在刷新所选来源，完成后自动下载未下载的比赛。');
  }
  function settled() { if(startup)startup.settled=true; }
  function cancel() { suppressed = true; quitAt = 0; update('cancelled','已取消本次自动退出，下载会继续。'); }
  function stopAutomatic() { automatic=false; if(startup)startup.settled=true; quitAt=0; }
  function tick() {
    const options = normalizeOptions(state.settings);
    if (startup && !startup.settled) { quitAt=0; return; }
    if (automatic && !options.autoDownload) stopAutomatic();
    if (automatic) {
      const ids = state.items.filter(record=>{
        if (!startup.sources.includes(record.category) || attempted.has(record.id) || !queueable.has(record.status)) return false;
        if (!['idle','partial'].includes(state.sync[record.category]?.phase)) return false;
        const days = Number(state.settings[record.category === 'personal' ? 'historyDays' : record.category === 'perfect' ? 'perfectDays' : 'tournamentDays']) || 7;
        if (!Number.isFinite(record.matchAt) || record.matchAt < now()-days*86400000 || record.matchAt > now()) return false;
        return Boolean(record.url || (record.source === 'pwa' && record.matchId) || (record.source === 'hltv' && record.pageUrl));
      }).slice(0,300).map(x=>x.id);
      if (ids.length) { ids.forEach(id=>attempted.add(id)); track(ids); queue(ids); }
    }
    const busy = isBusy() || state.items.some(x=>busyStatuses.has(x.status) || x.extracting) || Object.values(state.sync).some(x=>x.phase==='syncing');
    if (busy) { quitAt=0; if(armed)update('downloading','正在处理下载任务；暂停中的任务会阻止自动退出。'); return; }
    if (!armed) return;
    automatic = false; finished = true;
    const failure = [...tracked].some(id=>{const record=state.items.find(x=>x.id===id);return record?.status !== 'completed' || Boolean(record.error);});
    const sourceIssue = startup?.sources.some(c=>state.sync[c]?.phase !== 'idle');
    if (failure || sourceIssue) { quitAt=0; update('attention','部分获取或下载未完成，已保留窗口，请检查登录、验证或失败任务。'); return; }
    if (!options.autoQuit || suppressed) { quitAt=0; update('complete',suppressed?'任务已完成，本次自动退出已取消。':'下载任务已完成。'); return; }
    if (!quitAt) quitAt=now()+delay;
    update('countdown','下载任务已完成，将在 10 秒后退出软件。可取消本次退出。');
    if(now()>=quitAt){ armed=false;quitAt=0;quit(); }
  }
  return {begin,settled,track,tick,cancel,stopAutomatic};
}
module.exports = {createDownloadAutomation};
