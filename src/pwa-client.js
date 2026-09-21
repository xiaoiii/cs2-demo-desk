const { createHash, createCipheriv, randomInt } = require('node:crypto');

const MATCH_LIST_URL = 'https://pwaweblogin.wmpvp.com/user-info/recent-ladder-score-list';
const DEMO_URL = 'https://pwaweblogin.wmpvp.com/csgo/demo';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) perfectworldarena/1.0.26051411 Chrome/80.0.3987.163 Electron/8.5.5 Safari/537.36';
const APP_ID = '20000';
const SIGN_TAIL = '969c1bcfdc527c319157cc48f83b1d106ebdeca3e8d9763f1ae6b88dde9b3ea9';

function validateSteamId(value) {
  const id = String(value || '').trim();
  if (!/^7656119\d{10}$/.test(id)) throw new Error('请输入有效的 17 位 SteamID64。');
  return id;
}
function validateToken(value) {
  const token = String(value || '').trim();
  if (!/^[A-Za-z0-9._~+\/=:-]{16,4096}$/.test(token)) throw new Error('完美平台访问令牌格式不正确。');
  return token;
}
function requestSignature(rand, timestamp, data) {
  const inner = createHash('md5').update(`${rand}${timestamp}${data}`, 'utf8').digest('hex');
  return createHash('sha1').update(`${APP_ID}${inner}${SIGN_TAIL}`, 'utf8').digest('hex');
}
function signedParams(params, options = {}) {
  const normalized = Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)]));
  const data = Object.keys(normalized).sort().map(key => `${key}=${normalized[key]}`).join('&');
  const rand = String(options.rand ?? randomInt(100000, 1000000));
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  return { a:APP_ID, r:rand, s:requestSignature(rand, timestamp, data), t:timestamp, ...normalized };
}
function listHeaders(steamId, token) {
  return { Host:'pwaweblogin.wmpvp.com', 'User-Agent':USER_AGENT, Referer:'https://client.wmpvp.com/', 'x-pwa-steamid':steamId, pwasteamid:steamId, Cookie:`steam_cn_token=${token}`, 'Accept-Encoding':'gzip, deflate, br', 'Accept-Language':'zh-CN' };
}
function downloadSignature(steamId, timestamp, publicIp) {
  const id = validateSteamId(steamId), ts = String(timestamp);
  const key = Buffer.from(ts + id.slice(ts.length - 16), 'utf8');
  const iv = Buffer.from(id.slice(-16), 'utf8');
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  return `${ts}-${Buffer.concat([cipher.update(String(publicIp), 'utf8'), cipher.final()]).toString('hex')}`;
}
function downloadHeaders(steamId, publicIp, timestamp = Math.floor(Date.now() / 1000)) {
  return {
    'User-Agent':USER_AGENT, Referer:'https://client.wmpvp.com',
    'X-PWA-SteamId':steamId, 'X-PWA-Signature':downloadSignature(steamId, timestamp, publicIp),
    PwaSteamId:steamId,
    'Accept-Encoding':'gzip, deflate, br', 'Accept-Language':'zh-CN'
  };
}
function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string' && /^\d+$/.test(value)) { const number = Number(value); return number < 1e12 ? number * 1000 : number; }
  const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null;
}
function normalizeMatch(record) {
  const matchId = String(record.match || record.match_id || '').trim();
  if (!matchId) return null;
  const map = String(record.map || record.map_name || '').trim();
  const score = [record.team1_score ?? record.t_win_times, record.team2_score ?? record.ct_win_times].filter(x => x !== undefined && x !== null).join(' : ');
  return {
    matchId, cupId:Number(record.cup_id) || 0,
    matchAt:timestamp(record.match_starttime ?? record.start_time ?? record.created_at ?? record.time ?? record.date),
    map, mode:String(record.game_type_name || record.mode_name || record.game_type || '完美平台').trim(),
    title:[map || `比赛 ${matchId}`, score].filter(Boolean).join(' · '), raw:record
  };
}
async function jsonRequest(url, options, fetcher) {
  const response = await fetcher(url, { ...options, signal:AbortSignal.timeout(20000) });
  if (response.status === 401 || response.status === 403) throw new Error('完美平台登录已失效，请更新访问令牌。');
  if (!response.ok) throw new Error(`完美平台接口返回 HTTP ${response.status}。`);
  const data = await response.json();
  if (data?.code && Number(data.code) !== 0 && Number(data.code) !== 200) {
    const code = /^-?\d{1,8}$/.test(String(data.code)) ? String(data.code) : '未知';
    throw new Error(`完美平台请求未通过（错误码 ${code}）。请刷新重试；持续失败时需检查接口兼容性。`);
  }
  return data;
}
async function fetchRecentMatches({ steamId, token, size = 20, fetcher = fetch }) {
  steamId = validateSteamId(steamId); token = validateToken(token);
  const params = signedParams({ access_token:token, size:Math.min(20, Math.max(1, Math.floor(Number(size)) || 20)), uid:steamId });
  const url = new URL(MATCH_LIST_URL); for (const [key,value] of Object.entries(params)) url.searchParams.set(key,value);
  const body = await jsonRequest(url, { headers:listHeaders(steamId, token) }, fetcher);
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.data?.list) ? body.data.list : null;
  if (!rows) throw new Error('完美平台接口格式已变化，暂时无法读取比赛列表。');
  return rows.map(normalizeMatch).filter(Boolean);
}
async function publicIPv4(fetcher = fetch) {
  for (const url of ['https://api.ipify.org/','https://ifconfig.me/ip']) {
    try { const response = await fetcher(url, { signal:AbortSignal.timeout(10000) }); if (!response.ok) continue; const ip = (await response.text()).trim(); if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split('.').every(x => Number(x) <= 255)) return ip; } catch {}
  }
  throw new Error('无法获取公网 IPv4，暂时不能生成完美平台下载签名。');
}
async function createDemoDownload({ steamId, token, matchId, cupId = 0, fetcher = fetch }) {
  steamId = validateSteamId(steamId); token = validateToken(token);
  matchId = String(matchId || '').trim(); if (!/^[A-Za-z0-9_-]{1,128}$/.test(matchId)) throw new Error('完美平台比赛编号无效。');
  cupId = Number(cupId) || 0;
  const params = signedParams({ access_token:token, cup_id:cupId, match_id:matchId });
  const url = new URL(`${DEMO_URL}/${matchId}_${cupId}.dem`); for (const [key,value] of Object.entries(params)) url.searchParams.set(key,value);
  const ip = await publicIPv4(fetcher);
  return { url:url.href, headers:downloadHeaders(steamId, ip), filename:`PWA-${matchId}.dem.zip` };
}

module.exports = { validateSteamId, validateToken, requestSignature, signedParams, downloadSignature, downloadHeaders, normalizeMatch, fetchRecentMatches, createDemoDownload };
