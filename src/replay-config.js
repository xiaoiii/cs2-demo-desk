const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {cfg} = require('./replay-controls');
const filename = 'demodesk_controls.cfg';
function writeConfig(directory, config) {
  const content = cfg(config);
  fs.mkdirSync(directory,{recursive:true});
  const target = path.join(directory,filename), temporary = `${target}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary,content,'utf8'); fs.renameSync(temporary,target); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return target;
}
function installConfig(gameExe, config) {
  if (!path.isAbsolute(gameExe) || path.basename(gameExe).toLowerCase() !== 'cs2.exe' || !fs.existsSync(gameExe)) throw new Error('找不到 CS2 安装位置。');
  const gameDir = path.resolve(path.dirname(gameExe),'../../csgo');
  if (!fs.existsSync(gameDir)) throw new Error('找不到 CS2 的 game/csgo 目录。');
  return writeConfig(path.join(gameDir,'cfg'),config);
}
module.exports = {writeConfig,installConfig};
