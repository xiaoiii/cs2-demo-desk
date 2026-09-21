const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { inspectFile } = require('./core');
const { installConfig } = require('./replay-config');

function stageFiles(gameExe, id) {
  if (!/^[a-f0-9]{32}$/.test(id) || !path.isAbsolute(gameExe) || path.basename(gameExe).toLowerCase() !== 'cs2.exe') throw new Error('播放准备信息无效。');
  const gameDir = path.resolve(path.dirname(gameExe),'../../csgo');
  const name = `demodesk_${id}`;
  return { gameDir, name, demo:path.join(gameDir,`${name}.dem`), cfg:path.join(gameDir,'cfg',`${name}.cfg`), log:path.join(gameDir,`${name}.log`) };
}
async function preparePlayback(gameExe, source, controls) {
  if (!path.isAbsolute(source) || !fs.existsSync(source) || inspectFile(source) !== 'dem') throw new Error('找不到有效的 DEM 文件，请先下载或解压。');
  if (!fs.existsSync(gameExe)) throw new Error('找不到 CS2 安装目录。');
  const stage = { gameExe:path.resolve(gameExe), id:randomUUID().replace(/-/g,'') };
  const files = stageFiles(stage.gameExe,stage.id);
  if (!fs.existsSync(files.gameDir)) throw new Error('CS2 的 game/csgo 目录不存在，请检查安装位置。');
  if (controls) installConfig(gameExe,controls);
  await fs.promises.mkdir(path.dirname(files.cfg),{recursive:true});
  const owned = [];
  try {
    await fs.promises.copyFile(source,files.demo,fs.constants.COPYFILE_EXCL); owned.push(files.demo);
    const script = `echo DEMODESK_PLAY_${stage.id}\n${controls?.enabled ? 'exec demodesk_controls\n' : ''}playdemo "${files.name}.dem"\ndemoui true\n`;
    await fs.promises.writeFile(files.cfg,script,{encoding:'ascii',flag:'wx'}); owned.push(files.cfg);
    return stage;
  } catch {
    for (const file of owned) await fs.promises.unlink(file).catch(()=>{});
    throw new Error('无法准备游戏内回放文件，请检查游戏盘的剩余空间和写入权限。');
  }
}
async function cleanupPlayback(stage, gameExe) {
  if (!stage || path.resolve(stage.gameExe || '') !== path.resolve(gameExe)) return;
  let files; try { files = stageFiles(gameExe,stage.id); } catch { return; }
  // Only the three generated files in this verified installation; no recursive deletion.
  for (const file of [files.demo,files.cfg,files.log]) {
    try { if ((await fs.promises.lstat(file)).isFile()) await fs.promises.unlink(file); } catch {}
  }
}
function playbackArgs(stage) {
  const files = stageFiles(stage.gameExe,stage.id);
  if (!fs.existsSync(files.cfg) || !fs.existsSync(files.demo) || inspectFile(files.demo) !== 'dem') throw new Error('播放文件尚未准备完成。');
  return ['-applaunch','730','-condebug','-consolelog',`${files.name}.log`,'+exec',files.name];
}
function findInLibraries(roots) {
  const libraries = new Set(roots.filter(Boolean));
  for (const root of [...libraries]) {
    try {
      const text = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const match of text.matchAll(/"path"\s+"([^"]+)"/g)) libraries.add(match[1].replace(/\\\\/g, '\\'));
    } catch {}
  }
  for (const root of libraries) {
    const filename = path.join(root, 'steamapps', 'common', 'Counter-Strike Global Offensive', 'game', 'bin', 'win64', 'cs2.exe');
    if (fs.existsSync(filename)) return filename;
  }
  return '';
}
async function detectSteam() {
  const candidates = [];
  try {
    const { stdout } = await promisify(execFile)('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam'], { windowsHide:true });
    const exe = stdout.match(/SteamExe\s+REG_SZ\s+(.+)/); if (exe) candidates.push(exe[1].trim());
    const root = stdout.match(/SteamPath\s+REG_SZ\s+(.+)/); if (root) candidates.push(path.join(root[1].trim(),'steam.exe'));
  } catch {}
  for (const root of [process.env['ProgramFiles(x86)'],process.env.ProgramFiles]) if (root) candidates.push(path.join(root,'Steam','steam.exe'));
  return candidates.find(filename=>path.basename(filename).toLowerCase()==='steam.exe' && fs.existsSync(filename)) || '';
}
async function isCs2Running() {
  const { stdout } = await promisify(execFile)('tasklist.exe', ['/FI','IMAGENAME eq cs2.exe','/FO','CSV','/NH'], { windowsHide:true });
  return /^"cs2\.exe",/im.test(stdout);
}
async function launchPlayback(executable, stage, launch = spawn) {
  if (path.basename(executable).toLowerCase() !== 'steam.exe' || !fs.existsSync(executable)) throw new Error('请选择 Steam 安装目录中的 steam.exe。');
  const args = playbackArgs(stage);
  await new Promise((resolve, reject) => {
    const child = launch(executable, args, { cwd:path.dirname(executable), shell:false, detached:true, stdio:'ignore' });
    child.once('error', () => reject(new Error('无法启动 Steam，请检查 Steam 安装位置。')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
module.exports = { stageFiles, preparePlayback, cleanupPlayback, playbackArgs, findInLibraries, detectSteam, isCs2Running, launchPlayback };
