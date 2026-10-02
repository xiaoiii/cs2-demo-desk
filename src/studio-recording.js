const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const path=require('node:path');
const fs=require('node:fs');
const http=require('node:http');
const {randomBytes}=require('node:crypto');
const {atomicSave}=require('./core');
const {stageFiles}=require('./playback');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function gameCommand(text){await promisify(execFile)('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'game-console.ps1').replace('app.asar','app.asar.unpacked'),'-CommandBase64',Buffer.from(text,'utf8').toString('base64')],{windowsHide:true,timeout:15000});}
function playerCommand(player){
  const name=String(player.name||'');if(!name||/[";\\\r\n]/.test(name))throw new Error('该玩家昵称含控制字符，无法安全自动切换视角。');
  const steam=BigInt(player.id),account=steam-76561197960265728n;if(account<0n||account>4294967295n)throw new Error('玩家 SteamID 无效。');
  return `spec_player "${name}"; spec_lock_to_accountid ${account}`;
}
function createRecording({obs,launch,gameExe,directory,consoleCommand=gameCommand,wait=pause}){
  const index=path.join(directory,'recordings.json');let clips=[];try{clips=JSON.parse(fs.readFileSync(index,'utf8')).items||[];}catch{}
  let task=null,abort=false;
  const persist=()=>atomicSave(index,{items:clips});
  async function execute({demo,player,segments,scene}){
    if(task&&['launching','waiting','recording'].includes(task.phase))throw new Error('已有录制任务正在进行。');
    if(!Array.isArray(segments)||!segments.length||segments.length>30)throw new Error('请选择 1–30 个录制片段。');
    for(const segment of segments)if(!Number.isFinite(segment.startTick)||!Number.isFinite(segment.endTick)||segment.endTick<=segment.startTick)throw new Error('录制 Tick 范围无效。');
    const pov=playerCommand(player);if((await obs.status()).recording)throw new Error('OBS 已在录制，请先结束现有录制。');
    task={phase:'launching',message:'正在通过 Steam 启动录像',done:0,total:segments.length};abort=false;
    let server,config,ownedConfig=false;
    try{
      const token=randomBytes(24).toString('hex');let observed='';
      server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>{body+=chunk;if(body.length>65536)req.destroy();});req.on('end',()=>{try{const payload=JSON.parse(body);if(payload.auth?.token===token)observed=String(payload.player?.steamid||'');}catch{}res.end('ok');});});
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
      const folder=path.resolve(path.dirname(gameExe()),'../../csgo/cfg');config=path.join(folder,'gamestate_integration_demodesk_studio.cfg');
      if(fs.existsSync(config))throw new Error('录制校验配置已存在，请先结束其他 Demo Desk 录制。');
      await fs.promises.writeFile(config,`"Demo Desk Recording"\n{\n"uri" "http://127.0.0.1:${server.address().port}"\n"timeout" "2"\n"buffer" "0.1"\n"throttle" "0.2"\n"heartbeat" "1"\n"auth" { "token" "${token}" }\n"data" { "provider" "1" "player_id" "1" "player_state" "1" }\n}\n`,{flag:'wx'});
      ownedConfig=true;
      const stage=await launch(demo);
      task.phase='waiting';task.message='等待 CS2 启动；如 Steam 弹出确认，请点击启动';
      let ready=false;
      for(let i=0;i<120&&!abort;i++){
        if(stage){let log='';try{log=fs.readFileSync(stageFiles(stage.gameExe,stage.id).log,'utf8');}catch{}if(!/CSGO_GAME_UI_STATE_LOADINGSCREEN -> CSGO_GAME_UI_STATE_INGAME/.test(log)){await wait(1000);continue;}}
        try{await consoleCommand('demo_pause');ready=true;break;}catch{}await wait(1000);
      }
      if(abort)return;if(!ready)throw new Error('未能控制 CS2 窗口，请检查 Steam 启动确认、游戏权限和控制台按键。');
      for(const segment of segments){
        if(abort)break;
        task.phase='waiting';task.message=`定位 ${segment.label||'片段'} 并校验玩家视角`;
        observed='';await consoleCommand(`demo_pause; demo_gototick ${Math.floor(segment.startTick)} 0 1; demo_timescale 1`);await wait(1500);await consoleCommand(pov);
        let verified=false;for(let i=0;i<20&&!abort;i++){if(observed===String(player.id)){verified=true;break;}await wait(500);}
        if(abort)break;if(!verified)throw new Error('游戏未确认所选玩家视角，已停止录制。请检查控制台按键为默认 ~，或重新载入录像。');
        await consoleCommand('demo_resume');await wait(200);await obs.start(scene);
        task.phase='recording';task.message=`正在录制 ${segment.label||'片段'}`;
        const duration=(segment.endTick-segment.startTick)/64*1000;
        for(let elapsed=0;elapsed<duration&&!abort;elapsed+=250)await wait(Math.min(250,duration-elapsed));
        const saved=await obs.stop();await consoleCommand('demo_pause');
        if(saved?.outputPath){clips.unshift({id:randomBytes(12).toString('hex'),path:saved.outputPath,name:segment.label||'POV 片段',player:player.name,playerId:player.id,reviewId:demo.id,sourceClipId:segment.id||'',created:Date.now(),startTick:segment.startTick,endTick:segment.endTick,complete:!abort});persist();}
        task.done++;
      }
      task.phase=abort?'cancelled':'done';task.message=abort?'录制已取消':'录制完成，素材已进入剪辑列表';
    }catch(error){task.phase='error';task.message=error.message;throw error;}
    finally{await obs.stop().catch(()=>{});await new Promise(resolve=>server?.close(resolve)||resolve());if(ownedConfig)await fs.promises.unlink(config).catch(()=>{});if(abort&&task.phase!=='error'){task.phase='cancelled';task.message='录制已取消';}}
  }
  function cancel(){abort=true;}
  return {execute,cancel,status:()=>({task,clips}),get busy(){return !!task&&['launching','waiting','recording'].includes(task.phase);}};
}
module.exports={createRecording,playerCommand,gameCommand};
