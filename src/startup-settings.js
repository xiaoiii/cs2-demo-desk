const path = require('node:path');
const fs = require('node:fs');
const categories = ['personal','perfect','tournament'];
function normalizeOptions(settings = {}) {
  return {
    autoDownload: settings.autoDownload === true,
    autoQuit: settings.autoQuit === true,
    autoDownloadSources: Array.isArray(settings.autoDownloadSources)
      ? categories.filter(x => settings.autoDownloadSources.includes(x)) : ['personal','perfect'],
  };
}
function loginOptions(app, env = process.env) {
  const executable = env.PORTABLE_EXECUTABLE_FILE || (app.isPackaged ? app.getPath('exe') : '');
  if (!executable || !path.isAbsolute(executable) || !fs.existsSync(executable)) throw new Error('请运行已下载的 Windows EXE 后设置开机启动。');
  return { name:'CS2 Demo Desk', path:executable, args:[] };
}
function setAutoLaunch(app, enabled, env) {
  const options = loginOptions(app,env);
  app.setLoginItemSettings({...options,openAtLogin:enabled});
  const actual = app.getLoginItemSettings({path:options.path,args:options.args});
  const registered = loginEnabled(actual,options);
  if (enabled && !registered) throw new Error('Windows 未启用此启动项，请检查系统“启动应用”设置。');
  if (!enabled && registered) throw new Error('无法移除 Windows 启动项，请检查系统“启动应用”设置。');
  return registered;
}
function loginEnabled(actual,options) {
  // openAtLogin queries Electron's default entry name, so inspect our explicit named entry.
  if(Array.isArray(actual.launchItems))return actual.launchItems.some(item=>item.name===options.name && item.scope==='user' && item.enabled && path.resolve(item.path).toLowerCase()===path.resolve(options.path).toLowerCase() && JSON.stringify(item.args)===JSON.stringify(options.args));
  return actual.openAtLogin===true && actual.executableWillLaunchAtLogin!==false;
}
function getAutoLaunch(app,env){const options=loginOptions(app,env);return loginEnabled(app.getLoginItemSettings({path:options.path,args:options.args}),options);}
module.exports = {normalizeOptions,loginOptions,loginEnabled,getAutoLaunch,setAutoLaunch};
