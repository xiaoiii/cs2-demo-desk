// Serialized into the isolated source page. Keep this function self-contained and
// read only the rendered match markup (never cookies, credentials or page state).
function extractSourcePage(kind, options = {}) {
  const pageUrl = location.href;
  const text = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  const url = value => { try { if (typeof value !== 'string' || !value.trim()) return ''; const u = new URL(value, pageUrl); return /^(https?):$/.test(u.protocol) && !u.username && !u.password ? u.href : ''; } catch { return ''; } };
  const visible = el => {
    for (let p = el; p && p.nodeType === 1; p = p.parentElement) {
      const style = getComputedStyle(p);
      if (p.hidden || style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return Boolean(el);
  };
  const enabled = el => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !el.classList.contains('disabled');
  const epoch = value => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    const ms = n < 100000000000 ? n * 1000 : n;
    return ms >= Date.UTC(2000, 0, 1) && ms < Date.UTC(2100, 0, 1) ? ms : null;
  };
  const date = value => {
    const m = String(value || '').match(/\b(20\d{2})[-/]([01]?\d)[-/]([0-3]?\d)(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?(?:\s*(GMT|UTC|Z))?\b/i);
    if (!m) return null;
    const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4] || 0, m[5] || 0, m[6] || 0].map(Number);
    const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return null;
    return d.getTime();
  };
  const hash = value => { let h = 2166136261; for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619); return (h >>> 0).toString(16); };
  const result = { pageUrl, title: document.title || '', records: [], recognized: false, loginRequired: false, challenge: false, oldestAt: null, nextUrl: null, hasMore: false, loadMoreSelector: null };
  result.challenge = /just a moment|attention required|security verification|验证您是真人|请稍候/i.test(result.title) || Boolean(document.querySelector('#challenge-form, #cf-challenge-running, .cf-challenge, [data-testid="challenge-stage"]'));
  if (result.challenge) return result;
  const add = record => {
    if (!result.records.some(x => x.matchKey === record.matchKey)) result.records.push({ url: '', pageUrl, title: '', matchAt: null, matchKey: '', map: '', mode: '', event: '', eventId: '', team1: '', team2: '', category: kind === 'steam' ? 'personal' : 'tournament', ...record });
  };
  if (kind === 'steam') {
    const roots = [...document.querySelectorAll('.csgo_scoreboard_root')];
    result.loginRequired = /\/(?:login|openid\/login)(?:\/|$)/i.test(location.pathname) || (!roots.length && Boolean(document.querySelector('#login_form, #loginForm, form input[type="password"]')));
    if (result.loginRequired) return result;
    const history = document.querySelector('#personaldata_elements_container, #personaldata_container, .gcpd_content');
    result.recognized = roots.length > 0 || Boolean(history && /(?:no (?:matches|match history|competitive matches|data)|没有.*(?:比赛|记录)|无.*比赛记录)/i.test(text(history)));
    const accountId = location.pathname.match(/\/profiles\/(\d{17})(?:\/|$)/)?.[1];
    if (accountId) result.accountId = accountId;
    const mode = options.mode || 'competitive';
    const modeName = { premier: '优先模式', competitive: '竞技模式', wingman: '搭档模式' }[mode] || mode;
    const groups = [];
    for (const root of roots) {
      // A single outer table contains many matches. Do not combine dates or links
      // from adjacent matches or nested player score rows.
      const inner = [...root.querySelectorAll('table.csgo_scoreboard_inner_left')];
      if (inner.length) {
        for (const info of inner) {
          const left = info.closest('td.val_left');
          groups.push({ info, row: left?.closest('tr') || info.parentElement });
        }
      } else {
        const left = [...root.querySelectorAll('td.val_left')].filter(el => !el.parentElement.closest('table.csgo_scoreboard_inner_right'));
        if (left.length) for (const info of left) groups.push({ info, row: info.closest('tr') });
        else if (text(root) || root.querySelector('a')) groups.push({ info: root, row: root });
      }
    }
    for (const { info, row } of groups) {
      const infoRows = info.tagName === 'TABLE' ? [...info.rows].filter(r => r.closest('table') === info) : [];
      const content = infoRows.length ? infoRows.map(text).join(' ') : text(info);
      const first = text(infoRows[0]);
      const map = ((first || content).match(/\b(?:de|cs|ar)_[a-z0-9_]+\b/i) || [])[0] || first.replace(/^(?:Map|地图)\s*[:：]?\s*/i, '').replace(/^(?:Premier|Competitive|Wingman|优先模式|竞技模式|搭档模式)\s*[:：-]?\s+/i, '').slice(0, 80);
      const timeEl = info.querySelector('[data-unix], [data-timestamp], time[datetime]');
      const matchAt = epoch(timeEl?.getAttribute('data-unix') || timeEl?.getAttribute('data-timestamp')) || date(timeEl?.getAttribute('datetime')) || date(text(infoRows[1])) || date(content);
      const links = [...row.querySelectorAll('a[href]')];
      const demo = links.map(a => ({ a, href: url(a.getAttribute('href')) })).find(({ a, href }) => href && (/\.dem(?:\.(?:bz2|zip))?(?:[?#]|$)/i.test(href) || /(?:download.*(?:replay|demo)|下载.*(?:录像|回放)|download gotv)/i.test(text(a))));
      const download = demo?.href || '';
      // Dates remain stable when Valve removes the expiring replay URL.
      const identity = matchAt ? `${matchAt}:${map}` : download || `unknown:${hash(content)}`;
      if (!matchAt && !download && !map) continue;
      add({ url: download, title: `${map || '地图未知'} · ${modeName}`, matchAt, map, mode, matchKey: `steam:${accountId || 'self'}:${mode}:${identity}` });
    }
    if (result.recognized) {
      const continueText = document.querySelector('#load_more_button_continue_text');
      const mayContinue = !continueText || visible(continueText);
      const selectors = ['.load_more_history_area #load_more_clickable', '#load_more_button'];
      if (mayContinue) for (const selector of selectors) if (enabled(document.querySelector(selector))) { result.hasMore = true; result.loadMoreSelector = selector; break; }
      const next = [...document.querySelectorAll('a[rel="next"], a.pagebtn, a.pagelink')].find(el => enabled(el) && (/next|下一页|›|»|>/.test(text(el).toLowerCase()) || el.rel === 'next'));
      if (next && url(next.getAttribute('href')) && !/^(?:#|javascript:)/i.test(next.getAttribute('href') || '')) { result.nextUrl = url(next.getAttribute('href')); result.hasMore = true; }
      if (!result.hasMore && mayContinue) {
        // Unknown pagination is reported as incomplete instead of inventing a
        // cursor or reading Steam's private in-page session variables.
        result.hasMore = [...document.querySelectorAll('button, a, [role="button"]')].some(el => enabled(el) && /^(?:load more(?: matches| history)?|show more|加载更多|载入更多|更多比赛)\s*[.…]*$/i.test(text(el)));
      }
    }
  } else if (kind === 'hltv-results') {
    const rows = [...document.querySelectorAll('.result-con')];
    result.recognized = rows.length > 0 || Boolean(document.querySelector('.results-all, .results-holder, .results-container'));
    for (const row of rows) {
      const anchor = [...row.querySelectorAll('a[href]')].find(a => /\/matches\/\d+\//.test(a.getAttribute('href') || ''));
      if (!anchor) continue;
      const matchPage = url(anchor.getAttribute('href'));
      if (!matchPage) continue;
      const id = new URL(matchPage).pathname.match(/\/matches\/(\d+)/)?.[1];
      const timeNode = row.matches('[data-zonedgrouping-entry-unix]') ? row : row.querySelector('[data-zonedgrouping-entry-unix], [data-unix]');
      const matchAt = epoch(timeNode?.getAttribute('data-zonedgrouping-entry-unix') || timeNode?.getAttribute('data-unix'));
      const team1 = text(row.querySelector('.team1 .team, .team1, .team:first-child'));
      const team2 = text(row.querySelector('.team2 .team, .team2, .team:last-child'));
      const eventLink = row.querySelector('a[href*="/events/"]');
      const event = text(row.querySelector('.event-name')) || text(eventLink) || row.querySelector('.event img')?.getAttribute('title') || '未分类赛事';
      const eventId = eventLink?.getAttribute('href')?.match(/\/events\/(\d+)/)?.[1] || row.getAttribute('data-event-id') || '';
      const map = text(row.querySelector('.map-text, .map'));
      add({ pageUrl: matchPage, title: team1 && team2 ? `${team1} vs ${team2}` : text(row.querySelector('.result')) || '赛事比赛', matchAt, matchKey: `hltv:${id}`, map, event, eventId, team1, team2 });
    }
    const next = [...document.querySelectorAll('a.pagination-next, .pagination-next a, a[rel="next"]')].find(enabled);
    const href = next?.getAttribute('href');
    if (href && !/^(?:#|javascript:)/i.test(href)) { result.nextUrl = url(href); result.hasMore = Boolean(result.nextUrl); }
  } else if (kind === 'hltv-match') {
    const region = document.querySelector('.match-page') || document;
    const demos = [...region.querySelectorAll('a[data-demo-link], a[href*="/download/demo/"]')];
    result.recognized = Boolean(document.querySelector('.match-page, .timeAndEvent')) || demos.length > 0;
    const team1 = text(region.querySelector('.team1-gradient .teamName, .team1 .teamName'));
    const team2 = text(region.querySelector('.team2-gradient .teamName, .team2 .teamName'));
    const eventLink = region.querySelector('.timeAndEvent .event a, .event a[href*="/events/"]');
    const event = text(eventLink) || '未分类赛事';
    const eventId = eventLink?.getAttribute('href')?.match(/\/events\/(\d+)/)?.[1] || '';
    const matchAt = epoch(region.querySelector('.timeAndEvent [data-unix]')?.getAttribute('data-unix'));
    const map = [...new Set([...region.querySelectorAll('.mapholder .mapname')].map(text))].join(', ');
    const id = location.pathname.match(/\/matches\/(\d+)/)?.[1] || hash(pageUrl);
    const seen = new Set();
    for (const a of demos) {
      const download = url(a.getAttribute('data-demo-link') || a.getAttribute('href'));
      if (!download || seen.has(download)) continue;
      seen.add(download);
      add({ url: download, title: team1 && team2 ? `${team1} vs ${team2}` : result.title.replace(/\s*\|\s*HLTV.org.*$/i, ''), matchAt, matchKey: `hltv:${id}:demo:${hash(download)}`, event, eventId, team1, team2, map });
    }
  }
  const times = result.records.map(r => r.matchAt).filter(Number.isFinite);
  if (times.length) result.oldestAt = Math.min(...times);
  return result;
}

module.exports = { extractSourcePage };
