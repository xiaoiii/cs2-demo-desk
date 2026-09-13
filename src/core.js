const fs = require('node:fs');
const path = require('node:path');

const SOURCES = {
  premier: 'https://steamcommunity.com/my/gcpd/730/?tab=matchhistorypremier',
  competitive: 'https://steamcommunity.com/my/gcpd/730/?tab=matchhistorycompetitivepermap',
  wingman: 'https://steamcommunity.com/my/gcpd/730/?tab=matchhistorywingman',
  hltv: 'https://www.hltv.org/results',
  events: 'https://www.hltv.org/events',
};
function httpURL(value) {
  let u;
  try { u = new URL(String(value).trim()); } catch { throw new Error('请输入完整的 http:// 或 https:// 下载地址。'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('只支持不含账号密码的 HTTP / HTTPS 地址。');
  if (u.href.length > 8192) throw new Error('地址过长。');
  return u.href;
}
function sourceOf(url) {
  const host = new URL(url).hostname.toLowerCase();
  if (/(^|\.)(valve\.net|steamcontent\.com|steamcommunity\.com)$/.test(host)) return 'personal';
  return 'tournament';
}
function safeFilename(name) {
  let result = path.win32.basename(String(name)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '');
  if (!result || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) result = `demo_${result || 'replay.dem'}`;
  if (result.length > 160) result = result.slice(0, 140) + path.extname(result).slice(0, 15);
  return result;
}
function uniquePath(dir, name, occupied = []) {
  const safe = safeFilename(name), ext = path.extname(safe), base = path.basename(safe, ext);
  let dest = path.join(dir, safe), index = 1;
  while (fs.existsSync(dest) || occupied.some(p => p?.toLowerCase() === dest.toLowerCase())) dest = path.join(dir, `${base} (${index++})${ext}`);
  return dest;
}
function fileKind(buffer) {
  if (['PBDEMS2\0', 'HL2DEMO\0'].includes(buffer.subarray(0, 8).toString('ascii'))) return 'dem';
  if (buffer.subarray(0, 3).toString() === 'BZh' && buffer[3] >= 49 && buffer[3] <= 57) return 'bz2';
  if (buffer[0] === 0x50 && buffer[1] === 0x4b && [3, 5, 7].includes(buffer[2])) return 'zip';
  if (buffer.subarray(0, 7).equals(Buffer.from([82,97,114,33,26,7,0])) || buffer.subarray(0, 8).equals(Buffer.from([82,97,114,33,26,7,1,0]))) return 'rar';
  if (buffer.subarray(0, 6).equals(Buffer.from([55,122,188,175,39,28]))) return '7z';
  return null;
}
function inspectFile(filename) {
  const fd = fs.openSync(filename, 'r');
  try { const b = Buffer.alloc(16); const n = fs.readSync(fd, b, 0, b.length, 0); return fileKind(b.subarray(0, n)); } finally { fs.closeSync(fd); }
}
function parseLinks(text, category) {
  return [...new Set(String(text).split(/\r?\n/).map(x => x.trim()).filter(Boolean))].map(url => {
    if (/^(CSGO-|steam:\/\/)/i.test(url)) throw new Error('分享码需要 Steam / CS2 客户端解析。请使用“分享码交给 CS2”，或从个人比赛页面导入下载链接。');
    url = httpURL(url);
    let name;
    try { name = decodeURIComponent(new URL(url).pathname.split('/').pop()); } catch { name = 'Demo'; }
    return { url, title: name || 'Demo', category: category || sourceOf(url) };
  });
}
function shareCode(value) {
  const match = String(value).match(/CSGO(?:-[A-Za-z0-9]{5}){5}/);
  if (!match) throw new Error('请输入完整的 CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx 比赛分享码。');
  return match[0];
}
// Runs only in the source page. It reads public page content and never reads login fields or cookies.
function extractPage() {
  const result = [], seen = new Set();
  for (const a of document.querySelectorAll('a[href], [data-demo-link]')) {
    let url;
    try { url = new URL(a.getAttribute('data-demo-link') || a.getAttribute('href'), location.href).href; } catch { continue; }
    if (!/^https?:\/\//i.test(url)) continue;
    if (!(/\.(?:dem(?:\.bz2)?|rar|zip|7z)(?:[?#]|$)/i.test(url) || /\/download\/demo\/\d+/i.test(url))) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const row = a.closest('.csgo_scoreboard_root, .match, .match-row, .match-info-box') || a.closest('tr');
    const context = row ? row.innerText.replace(/\s+/g, ' ').trim().slice(0, 220) : '';
    const title = context || document.title.replace(/\s*\|\s*HLTV.org.*$/, '') || a.textContent.trim();
    result.push({ url, title, pageUrl: location.href });
  }
  return { title: document.title, pageUrl: location.href, links: result.slice(0, 300) };
}
function atomicSave(filename, data) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename + '.tmp', JSON.stringify(data, null, 2));
  fs.renameSync(filename + '.tmp', filename);
}
module.exports = { SOURCES, httpURL, sourceOf, safeFilename, uniquePath, fileKind, inspectFile, parseLinks, shareCode, extractPage, atomicSave };
