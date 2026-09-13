const { randomUUID } = require('node:crypto');
const { httpURL } = require('./core');

const DAY = 86400000;
const clampDays = value => Math.min(365, Math.max(1, Math.trunc(Number(value) || 7)));
class SourceIssue extends Error {
  constructor(phase, message, url) { super(message); this.phase = phase; this.url = url; }
}
function createSyncEngine({ state, loadPage, closePage = () => {}, onChange, urls, now = Date.now, limits = {} }) {
  const jobs = new Map(), jobGenerations = new Map(), resolving = new Map(), generations = { personal: 0, tournament: 0 };
  const maxPages = limits.pages || 20;
  function update(category, patch) { Object.assign(state.sync[category], patch); onChange(); }
  function guard(page, category, url) {
    if (page.challenge) throw new SourceIssue('verification_required', '来源网站需要验证。点击“完成网站验证”，完成后会自动继续获取。', page.pageUrl || url);
    if (page.loginRequired) throw new SourceIssue('login_required', '请先登录一次 Steam。成功后会自动获取比赛，并在本机加密保留登录凭证。', page.pageUrl || url);
    if (!page.recognized) throw new SourceIssue('error', '未识别到比赛页面。可能是网络异常或来源页面发生变化，原有记录已保留。', page.pageUrl || url);
  }
  function ingest(records, category) {
    let added = 0;
    for (const input of records) {
      const source = category === 'personal' ? 'steam' : 'hltv';
      const url = input.url ? httpURL(input.url) : '';
      const pageUrl = input.pageUrl ? httpURL(input.pageUrl) : '';
      const key = String(input.matchKey || url || pageUrl).slice(0, 500);
      if (!key) continue;
      let record = state.items.find(x => (x.source === source && x.matchKey === key) || (url && x.url === url));
      const metadata = {
        title: String(input.title || input.map || '比赛录像').slice(0, 240), category, source, matchKey: key, pageUrl,
        matchAt: Number.isFinite(input.matchAt) && input.matchAt > 0 ? input.matchAt : null,
        map: String(input.map || '').slice(0, 80), mode: String(input.mode || '').slice(0, 50),
        event: String(input.event || (category === 'tournament' ? '未分类赛事' : '')).slice(0, 160),
        eventId: String(input.eventId || '').slice(0, 40), team1: String(input.team1 || '').slice(0, 80), team2: String(input.team2 || '').slice(0, 80),
      };
      if (!record) {
        record = { id: randomUUID(), ...metadata, url, status: url ? 'ready' : category === 'tournament' ? 'catalog' : 'unavailable', received: 0, total: 0, speed: 0, created: now(), files: [] };
        state.items.unshift(record); added++;
      } else {
        Object.assign(record, metadata);
        if (!['connecting', 'downloading', 'paused', 'queued', 'resolving'].includes(record.status)) {
          if (url) { record.url = url; if (['catalog', 'unavailable'].includes(record.status)) record.status = 'ready'; }
          else if (source === 'steam' && ['ready', 'unavailable'].includes(record.status)) { record.url = ''; record.status = 'unavailable'; }
        }
      }
      record.lastSeen = now();
    }
    onChange(); return added;
  }
  function start(category) {
    if (!['personal', 'tournament'].includes(category)) throw new Error('请选择个人比赛或赛事。');
    if (jobs.has(category)) {
      if (jobGenerations.get(category) === generations[category]) return jobs.get(category);
      return jobs.get(category).then(() => start(category));
    }
    const generation = generations[category];
    const alive = () => generation === generations[category];
    const task = (async () => {
      const days = clampDays(category === 'personal' ? state.settings.historyDays : state.settings.tournamentDays);
      const cutoff = now() - days * DAY;
      let added = 0, partial = false, unknown = 0, pages = 0;
      const seen = new Set();
      update(category, { phase: 'syncing', message: `正在获取最近 ${days} 天的比赛…`, found: 0, verifyUrl: '', days });
      try {
        const starts = category === 'personal' ? [ ['premier', urls.premier], ['competitive', urls.competitive], ['wingman', urls.wingman] ] : [ ['hltv', urls.hltv] ];
        for (const [mode, initial] of starts) {
          if (!alive()) return;
          let url = initial, moreSelector = null, previousSignature = '';
          if (category === 'tournament') {
            const u = new URL(url); u.searchParams.set('startDate', new Date(cutoff - DAY).toISOString().slice(0, 10)); u.searchParams.set('endDate', new Date(now()).toISOString().slice(0, 10)); url = u.href;
          }
          for (let index = 0; index < maxPages; index++) {
            if (!alive()) return;
            update(category, { message: `${category === 'personal' ? ({premier:'优先模式',competitive:'竞技模式',wingman:'搭档模式'}[mode]) : '赛事目录'} · 正在读取第 ${index + 1} 页…` });
            const result = await loadPage(url, { kind: category === 'personal' ? 'steam' : 'hltv-results', category, mode, moreSelector, cutoff });
            if (!alive()) return;
            guard(result, category, url); pages++;
            const signature = JSON.stringify(result.records.map(x => [x.matchKey, x.url, x.matchAt]));
            if (index > 0 && signature === previousSignature) { partial = true; break; }
            previousSignature = signature;
            const recent = result.records.filter(x => !Number.isFinite(x.matchAt) || (x.matchAt >= cutoff && x.matchAt <= now() + DAY));
            for (const r of recent) { const key = r.matchKey || r.url || r.pageUrl; if (!seen.has(key)) { seen.add(key); if (!Number.isFinite(r.matchAt)) unknown++; } }
            added += ingest(recent, category);
            update(category, { found: seen.size });
            if (result.oldestAt && result.oldestAt < cutoff) break;
            if (!result.hasMore && !result.nextUrl) break;
            if (index === maxPages - 1) { partial = true; break; }
            if (result.nextUrl) {
              const next = httpURL(result.nextUrl);
              if (new URL(next).origin !== new URL(initial).origin) throw new Error('来源分页跳转到其他网站，已停止自动获取。');
              url = next; moreSelector = null;
            } else if (result.loadMoreSelector) moreSelector = result.loadMoreSelector;
            else { partial = true; break; }
          }
        }
        if (!alive()) return;
        update(category, { phase: partial ? 'partial' : 'idle', lastSync: now(), found: seen.size,
          message: `已获取 ${seen.size} 场比赛，新增 ${added} 条。${unknown ? `其中 ${unknown} 条日期未知，单独标记。` : ''}${partial ? '来源分页未全部完成，可缩小时间范围后刷新。' : ''}${category === 'tournament' ? '已按赛事分类，选择下载时自动查找 Demo。' : ''}`,
          pages, partial, verifyUrl: '',
        });
      } catch (e) {
        if (alive()) update(category, { phase: e.phase || 'error', message: `${e.message}${seen.size ? ` 本次已保留 ${seen.size} 条记录。` : ''}`, verifyUrl: e.url || '', found: seen.size });
      } finally { closePage(category); }
    })();
    jobs.set(category, task); jobGenerations.set(category, generation);
    task.finally(() => { if (jobs.get(category) === task) { jobs.delete(category); jobGenerations.delete(category); } }); return task;
  }
  async function resolveRecord(record) {
    if (record.url) return record;
    if (resolving.has(record.id)) return resolving.get(record.id);
    const task = (async () => {
      record.status = 'resolving'; record.error = ''; onChange();
      const category = `detail-${record.id}`;
      try {
        const result = await loadPage(httpURL(record.pageUrl), { kind: 'hltv-match', category });
        guard(result, 'tournament', record.pageUrl);
        const links = result.records.filter(x => x.url);
        if (!links.length) { record.status = 'unavailable'; record.error = '这场比赛暂未发布 Demo，可稍后刷新来源。'; onChange(); return record; }
        record.url = httpURL(links[0].url); record.status = 'ready';
        if (links.length > 1) ingest(links.slice(1).map((x,i) => ({ ...record, ...x, matchKey: `${record.matchKey}:demo:${i+1}` })), 'tournament');
      } catch (e) {
        record.status = 'failed'; record.error = e.message;
        if (e.phase) {
          stop('tournament');
          update('tournament', { phase: e.phase, message: e.message, verifyUrl: e.url || record.pageUrl });
        }
      } finally { closePage(category); onChange(); }
      return record;
    })();
    resolving.set(record.id, task); task.finally(() => resolving.delete(record.id)); return task;
  }
  function stop(category) {
    for (const key of category ? [category] : ['personal','tournament']) {
      generations[key]++; closePage(key);
      if (state.sync[key].phase === 'syncing') update(key, { phase:'idle', message:'获取已停止，已有记录已保留。' });
    }
  }
  return { start, ingest, resolveRecord, stop, isRunning: category => jobs.has(category) };
}
module.exports = { createSyncEngine, clampDays, SourceIssue };
