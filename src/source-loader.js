const { BrowserWindow } = require('electron');
const { extractSourcePage } = require('./source-parsers');
const { httpURL } = require('./core');

function createSourceLoader(session) {
  const windows = new Map();
  const delay = ms => new Promise(r => setTimeout(r, ms));
  function close(category) { const w = windows.get(category); windows.delete(category); if (w && !w.isDestroyed()) w.destroy(); }
  async function load(url, options) {
    url = httpURL(url);
    let w = windows.get(options.category);
    if (!w || w.isDestroyed()) {
      w = new BrowserWindow({ show: false, webPreferences: { session, nodeIntegration: false, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
      windows.set(options.category, w);
      w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      for (const event of ['will-navigate', 'will-redirect']) w.webContents.on(event, (e, target) => { try { httpURL(target); } catch { e.preventDefault(); } });
    }
    const wc = w.webContents;
    const script = `(${extractSourcePage.toString()})(${JSON.stringify(options.kind)},${JSON.stringify({ mode: options.mode, now: Date.now() })})`;
    if (options.moreSelector) {
      const before = await wc.executeJavaScript(script);
      const clicked = await wc.executeJavaScript(`(()=>{ const el=document.querySelector(${JSON.stringify(options.moreSelector)}); if(!el||el.disabled)return false;el.click();return true;})()`);
      if (!clicked) return { ...before, hasMore: true, loadMoreSelector: null, nextUrl: null };
      const signature = JSON.stringify(before.records);
      for (let i = 0; i < 70; i++) {
        await delay(200);
        if (w.isDestroyed()) throw new Error('获取已停止。');
        const result = await wc.executeJavaScript(script);
        if (result.challenge || result.loginRequired || JSON.stringify(result.records) !== signature) return result;
      }
      return before;
    }
    let timer, domReady;
    try {
      const ready = new Promise(resolve => {
        domReady = () => { if (/^https?:/.test(wc.getURL())) resolve(); };
        wc.on('dom-ready', domReady);
      });
      await Promise.race([
        wc.loadURL(url),
        ready,
        new Promise((_, reject) => { timer = setTimeout(() => { if (!w.isDestroyed()) wc.stop(); reject(new Error('连接来源超时，请检查网络后刷新。')); }, 25000); }),
      ]);
    } catch (e) {
      if (w.isDestroyed()) throw new Error('获取已停止。');
      throw new Error(`来源页面加载失败：${e.message}`);
    } finally { clearTimeout(timer); if (!wc.isDestroyed()) wc.removeListener('dom-ready', domReady); }
    let result;
    for (let i = 0; i < 35; i++) {
      await delay(200);
      if (w.isDestroyed()) throw new Error('获取已停止。');
      result = await wc.executeJavaScript(script);
      if (result.challenge || result.loginRequired || (result.recognized && (result.records.length || i >= 7))) return result;
    }
    return result;
  }
  return { load, close, closeAll: () => [...windows.keys()].forEach(close) };
}
module.exports = { createSourceLoader };
