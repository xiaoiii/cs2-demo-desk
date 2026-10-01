const fs = require('node:fs');
const path = require('node:path');
const { uniquePath, inspectFile } = require('./core');

function isDirectory(folder) {
  try { return path.isAbsolute(folder) && fs.statSync(folder).isDirectory(); } catch { return false; }
}
function gameReplayDirectory(gameExe) {
  if (!gameExe || !fs.existsSync(gameExe) || path.basename(gameExe).toLowerCase() !== 'cs2.exe') return '';
  const folder = path.resolve(path.dirname(gameExe), '../../csgo/replays');
  return isDirectory(folder) ? folder : '';
}
async function publishDemos(files, destination) {
  if (!isDirectory(destination)) throw new Error('录像目录不存在，请在设置中重新选择 Demo 保存位置。');
  const published = [];
  try {
    for (const source of files) {
      if (inspectFile(source) !== 'dem') throw new Error('录像文件无效。');
      const filename = path.basename(source).replace(/(?:\.dem)?$/i, '.dem');
      for (;;) {
        const target = uniquePath(destination, filename);
        try {
          await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL);
          published.push(target); break;
        } catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
    }
    return published;
  } catch (error) {
    for (const file of published) await fs.promises.unlink(file).catch(() => {});
    throw new Error(`无法保存 Demo：${error.message} 原下载文件已保留，请检查录像目录权限和磁盘空间后重试。`);
  }
}
module.exports = { isDirectory, gameReplayDirectory, publishDemos };
