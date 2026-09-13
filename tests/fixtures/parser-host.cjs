const { app, BrowserWindow, session } = require('electron');
if (process.env.PARSER_TEST_PROFILE) app.setPath('userData', process.env.PARSER_TEST_PROFILE);
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/i.test(details.url) }));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.loadURL('about:blank');
});
app.on('window-all-closed', () => app.quit());
