const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _electron } = require('playwright');
const { extractSourcePage } = require('../src/source-parsers');
let app, page;
const root = path.resolve(__dirname, '..');
const stamp = Date.UTC(2026, 8, 9, 10, 20, 30);
const row = (map, date, link = '', extra = '') => `<tr><td class="val_left"><table class="csgo_scoreboard_inner_left"><tbody><tr><td>${map}</td></tr><tr><td>${date}</td></tr><tr><td>${link ? `<a href="${link}">Download GOTV Replay</a>` : 'Replay unavailable'}</td></tr></tbody></table></td><td><table class="csgo_scoreboard_inner_right"><tbody><tr><td>${extra || 'Player 13 : 8'}</td></tr></tbody></table></td></tr>`;
const steam = rows => `<title>Personal Game Data</title><table class="csgo_scoreboard_root"><tbody>${rows}</tbody></table>`;
async function parse(html, kind = 'steam', options = { mode: 'premier' }) {
  await page.setContent(`<base href="https://fixture.example/">${html}`);
  return page.evaluate(`(${extractSourcePage.toString()})(${JSON.stringify(kind)}, ${JSON.stringify(options)})`);
}
before(async () => {
  fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
  const profile = fs.mkdtempSync(path.join(root, 'test-results', 'parser-profile-'));
  const env = { ...process.env, PARSER_TEST_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ args: [path.join(__dirname, 'fixtures', 'parser-host.cjs')], env });
  page = await app.firstWindow();
});
after(async () => { if (app) await app.close(); });

test('Steam outer table is split into separate matches with individual timestamps', async () => {
  const data = await parse(steam(row('de_mirage', '2026-09-09 10:20:30 GMT', 'https://replay.example/a.dem.bz2') + row('de_nuke', '2026-09-01 01:02:03 GMT', 'https://replay.example/b.dem.bz2')));
  assert.equal(data.recognized, true); assert.equal(data.records.length, 2);
  assert.equal(data.records[0].matchAt, stamp); assert.equal(data.records[0].map, 'de_mirage');
  assert.equal(data.records[1].matchAt, Date.UTC(2026, 8, 1, 1, 2, 3));
  assert.equal(data.oldestAt, data.records[1].matchAt); assert.equal(data.records[1].mode, 'premier');
});
test('Expired Steam replays retain stable identities and remain records', async () => {
  const a = await parse(steam(row('Mirage', '2026-09-09 10:20:30 GMT', 'https://replay.example/a.dem.bz2')));
  const b = await parse(steam(row('Mirage', '2026-09-09 10:20:30 GMT')));
  assert.equal(b.records.length, 1); assert.equal(b.records[0].url, ''); assert.equal(a.records[0].matchKey, b.records[0].matchKey);
});
test('Unknown and invalid dates are never converted to today', async () => {
  const data = await parse(steam(row('de_inferno', 'unavailable', 'https://replay.example/c.dem') + row('de_nuke', '2026-02-30 00:00:00 GMT')));
  assert.equal(data.records.length, 2); assert.equal(data.records[0].matchAt, null); assert.equal(data.records[1].matchAt, null); assert.equal(data.oldestAt, null);
});
test('Player dates and links outside the Steam match region do not create records', async () => {
  const data = await parse(steam(row('de_mirage', 'Unknown', '', 'Joined 2026-09-09 10:20:30 GMT')) + '<a href="https://x.example/other.dem">Download</a>');
  assert.equal(data.records.length, 1); assert.equal(data.records[0].matchAt, null); assert.equal(data.records[0].url, '');
});
test('Visible Steam pagination is reported and hidden controls stop pagination', async () => {
  const html = steam(row('de_mirage', '2026-09-09 10:20:30 GMT'));
  let data = await parse(html + '<button id="load_more_button">Load More</button>');
  assert.equal(data.hasMore, true); assert.equal(data.loadMoreSelector, '#load_more_button');
  data = await parse(html + '<div style="display:none"><button id="load_more_button">Load More</button></div>');
  assert.equal(data.hasMore, false);
  data = await parse(html + '<button>Load more matches</button>');
  assert.equal(data.hasMore, true); assert.equal(data.loadMoreSelector, null);
});
test('Steam empty history is recognized without fabricating a match', async () => {
  const data = await parse(steam('') + '<p>No matches available</p>');
  assert.equal(data.recognized, true); assert.deepEqual(data.records, []);
});
test('Steam native history control stops when its continuation label is hidden', async () => {
  const html = steam(row('Competitive Mirage', '2026-09-09 10:20:30 GMT'));
  let data = await parse(html + '<div class="load_more_history_area"><div id="load_more_clickable"><button id="load_more_button"><span id="load_more_button_continue_text">LOAD MORE HISTORY</span></button></div></div>');
  assert.equal(data.hasMore, true); assert.equal(data.loadMoreSelector, '.load_more_history_area #load_more_clickable'); assert.equal(data.records[0].map, 'Mirage');
  data = await parse(html + '<div class="load_more_history_area"><div id="load_more_clickable"><button id="load_more_button"><span id="load_more_button_continue_text" style="display:none">LOAD MORE HISTORY</span><span>No more matches</span></button></div></div>');
  assert.equal(data.hasMore, false); assert.equal(data.loadMoreSelector, null);
});
test('Login and challenge pages are distinguished from empty history', async () => {
  let data = await parse('<title>Sign in</title><form id="login_form"><input type="password"></form>');
  assert.equal(data.loginRequired, true); assert.equal(data.recognized, false);
  data = await parse('<title>Just a moment...</title><form id="challenge-form"></form>', 'hltv-results');
  assert.equal(data.challenge, true); assert.equal(data.recognized, false);
});
test('HLTV results provide event classification, teams, dates and pagination', async () => {
  const html = `<div class="results-all"><div class="result-con" data-zonedgrouping-entry-unix="${stamp}" data-event-id="8266"><a class="a-reset" href="https://www.hltv.org/matches/2397605/big-vs-g2"><span class="team1">BIG</span><span class="team2">G2</span><span class="result-score">1 - 2</span><span class="event-name">FISSURE Playground 3</span><span class="map-text">bo3</span></a></div></div><a class="pagination-next" href="https://www.hltv.org/results?offset=100">Next</a>`;
  const data = await parse(html, 'hltv-results');
  assert.equal(data.records.length, 1); assert.equal(data.records[0].matchAt, stamp);
  assert.equal(data.records[0].title, 'BIG vs G2'); assert.equal(data.records[0].event, 'FISSURE Playground 3'); assert.equal(data.records[0].eventId, '8266');
  assert.equal(data.records[0].url, ''); assert.equal(data.records[0].matchKey, 'hltv:2397605');
  assert.equal(data.nextUrl, 'https://www.hltv.org/results?offset=100');
});
test('HLTV results use null for unknown dates and ignore disabled pagination', async () => {
  const data = await parse('<div class="results-all"><div class="result-con"><a href="https://www.hltv.org/matches/123/fixture"><span class="team1">A</span><span class="team2">B</span></a></div></div><a class="pagination-next disabled" href="https://www.hltv.org/results?offset=100">Next</a>', 'hltv-results');
  assert.equal(data.records[0].matchAt, null); assert.equal(data.records[0].event, '未分类赛事'); assert.equal(data.hasMore, false);
});
test('HLTV details deduplicate data-demo-link and reject non-web URLs', async () => {
  const data = await parse('<title>A vs B | HLTV.org</title><div class="match-page"><a data-demo-link="https://www.hltv.org/download/demo/123">Demo download</a><a href="https://www.hltv.org/download/demo/123">Duplicate</a><a data-demo-link="javascript:alert(1)">Bad</a></div><a href="https://www.hltv.org/download/demo/456">Unrelated footer</a>', 'hltv-match');
  assert.equal(data.records.length, 1); assert.equal(data.records[0].url, 'https://www.hltv.org/download/demo/123'); assert.equal(data.records[0].title, 'A vs B');
});
test('Real saved HLTV match markup yields the published replay and metadata', async () => {
  const live = fs.readFileSync(path.join(root, 'test-results', 'hltv-live.html'), 'utf8').replaceAll('data-demo-link="/download/', 'data-demo-link="https://www.hltv.org/download/');
  const data = await parse(live, 'hltv-match');
  assert.equal(data.recognized, true); assert.equal(data.challenge, false); assert.equal(data.records.length, 1);
  assert.equal(data.records[0].url, 'https://www.hltv.org/download/demo/111176');
  assert.equal(data.records[0].team1, 'BIG'); assert.equal(data.records[0].team2, 'G2');
  assert.equal(data.records[0].event, 'FISSURE Playground 3'); assert.equal(data.records[0].eventId, '8266');
  assert.equal(data.records[0].matchAt, 1788941400000);
});
