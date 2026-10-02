const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const path=require('node:path');
const fs=require('node:fs');
const http=require('node:http');
const {randomBytes}=require('node:crypto');
const {atomicSave}=require('./core');
const {stageFiles}=require('./playback');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const executeGameCommand=promisify(execFile);
async function gameCommand(text,execute=executeGameCommand){
  try{
    // A cold PowerShell launch also compiles the input helper. Give slower
    // machines time to finish while CS2 is loading instead of killing it early.
    await execute('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'game-console.ps1').replace('app.asar','app.asar.unpacked'),'-CommandBase64',Buffer.from(text,'utf8').toString('base64')],{windowsHide:true,timeout:60000});
  }catch(error){
    // execFile's message includes the full shell command and encoded game
    // input. Match known helper errors, returning only our own UI messages.
    const stderr=String(error?.stderr||'');
    if(error?.killed||error?.code==='ETIMEDOUT'||error?.signal==='SIGTERM')throw new Error('等待 CS2 控制指令超时（60 秒）。请等待游戏加载完成后重试。');
    if(error?.code==='ENOENT')throw new Error('找不到 Windows PowerShell，无法控制 CS2 录像。');
    if(stderr.includes('Cannot focus CS2'))throw new Error('无法将 CS2 切到前台。请确认游戏已加载，并让 OBS、Demo Desk 与 CS2 使用相同权限运行。');
    if(stderr.includes('CS2 window is not available'))throw new Error('找不到 CS2 游戏窗口。请先通过 Steam 启动录像。');
    if(stderr.includes('Cannot send game input'))throw new Error('无法向 CS2 输入控制指令。请确认游戏已加载，并让游戏与 Demo Desk 使用相同权限运行。');
    if(stderr.includes('Invalid game command'))throw new Error('CS2 控制指令无效，已停止录制。');
    throw new Error('无法向 CS2 发送控制指令。请确认控制台按键为默认 ~，并让游戏与 Demo Desk 使用相同权限运行。');
  }
}
function playerAccount(player){
  let steam;try{steam=BigInt(player.id);}catch{throw new Error('玩家 SteamID 无效。');}
  const account=steam-76561197960265728n;if(account<0n||account>4294967295n)throw new Error('玩家 SteamID 无效。');
  return account;
}
function playerCommand(player,observerSlot){
  const account=playerAccount(player);let selector;
  if(observerSlot!==undefined){
    if(!Number.isSafeInteger(observerSlot)||observerSlot<0||observerSlot>63)throw new Error('玩家观察槽位无效。');
    selector=String(observerSlot);
  }else{
    const name=String(player.name||'');if(!name||/[";\\\r\n]/.test(name))throw new Error('该玩家昵称含控制字符，无法安全自动切换视角。');
    selector=`"${name}"`;
  }
  return `spec_autodirector 0; spec_mode 1; spec_player ${selector}; spec_lock_to_accountid ${account}`;
}
// Read only appended complete lines from this launch's own console log.
function createLogReader(filename){
  let offset=0,pending='';
  function reset(){try{offset=fs.statSync(filename).size;}catch{offset=0;}pending='';}
  function read(){
    let fd;try{
      const size=fs.statSync(filename).size;if(size<offset){offset=0;pending='';}
      if(size===offset)return '';
      const length=Math.min(size-offset,262144),buffer=Buffer.alloc(length);fd=fs.openSync(filename,'r');
      const count=fs.readSync(fd,buffer,0,length,offset);offset+=count;
      const text=pending+buffer.subarray(0,count).toString('utf8'),last=text.lastIndexOf('\n');
      if(last<0){pending=text.slice(-65536);return '';}
      pending=text.slice(last+1);return text.slice(0,last+1);
    }catch{return '';}finally{if(fd!==undefined)fs.closeSync(fd);}
  }
  return {read,reset};
}
function logEvents(text){
  const events=[];
  for(const line of String(text).split(/\r?\n/)){
    let match;
    // Exact messages are present in the installed Steam CS2 engine2.dll.
    if((match=line.match(/Currently playing (\d+) of (\d+) ticks\./)))events.push({kind:'position',tick:Number(match[1])});
    if((match=line.match(/(?:ReachedPausedTick\s+|Demo paused at engine time [\d.e+-]+, demo tick\s+)(\d+)/)))events.push({kind:'pause',tick:Number(match[1])});
    if(/Demo Skipping: skipping |Demo Skipping finished at tick|Going to tick \d+/.test(line))events.push({kind:'seek'});
    if(/Demo playback finished|NETWORK_DISCONNECT_EXITING|Not currently playing back a demo/.test(line))events.push({kind:'ended'});
    if(/Unknown command.*(?:demo_|spec_)|Missing\/invalid pause tick|Bad number of step ticks/.test(line))events.push({kind:'unsupported'});
  }
  return events;
}
function createRecording({obs,launch,gameExe,directory,consoleCommand=gameCommand,wait=pause,now=Date.now}){
  const index=path.join(directory,'recordings.json');let clips=[];try{clips=JSON.parse(fs.readFileSync(index,'utf8')).items||[];}catch{}
  let task=null,abort=false,running=false;
  const persist=()=>atomicSave(index,{items:clips});
  async function execute({demo,player,segments,scene}){
    if(running)throw new Error('已有录制任务正在进行。');
    if(!Array.isArray(segments)||!segments.length||segments.length>30)throw new Error('请选择 1–30 个录制片段。');
    for(const segment of segments)if(!Number.isSafeInteger(segment.startTick)||!Number.isSafeInteger(segment.endTick)||segment.startTick<0||segment.endTick>2147483647||segment.endTick<=segment.startTick)throw new Error('录制 Tick 范围无效。');
    playerAccount(player);
    // Claim before awaiting OBS so concurrent clicks cannot launch two tasks.
    running=true;abort=false;task={phase:'launching',message:'正在通过 Steam 启动录像',done:0,total:segments.length};
    let server,config,configText='',ownedConfig=false,controlled=false,activeSegment=null,recordingStarted=false,monitor;
    let observed='',observedAt=-Infinity,observedSerial=0,observedSlot,consoleLogInitialized=false,targetSlot,targetSlotAt=-Infinity;
    const stoppedSegment=async complete=>{
      if(!recordingStarted)return;
      const saved=await obs.stop();
      recordingStarted=false;
      if(saved?.outputPath&&activeSegment){
        clips.unshift({id:randomBytes(12).toString('hex'),path:saved.outputPath,name:activeSegment.label||'POV 片段',player:player.name,playerId:player.id,reviewId:demo.id,sourceClipId:activeSegment.id||'',created:Date.now(),startTick:activeSegment.startTick,endTick:activeSegment.endTick,complete});persist();
      }
    };
    const freshPOV=()=>observed===String(player.id)&&now()-observedAt<=5000;
    const acknowledgement=async command=>{
      if(abort)return '';
      monitor.reset();const marker=`DEMODESK_ACK_${randomBytes(12).toString('hex')}`;
      // CS2's Console channel otherwise displays echo only on screen. Enable
      // this launch's file acknowledgement before the first control command.
      await consoleCommand(`${consoleLogInitialized?'':'log_flags Console -ConsoleOnly; '}${command}; echo ${marker}`);consoleLogInitialized=true;let output='';
      for(let elapsed=0;elapsed<10000&&!abort;elapsed+=250){
        output+=monitor.read();
        // A console input echo is not execution proof.
        if(output.split(/\r?\n/).some(line=>line.trim().endsWith(marker)&&!line.includes('echo ')))return output;
        await wait(250);
      }
      if(!abort)throw new Error('CS2 未确认控制指令，已停止录制。请检查控制台按键、游戏权限或日志写入。');
      return '';
    };
    try{
      if((await obs.status()).recording)throw new Error('OBS 已在录制，请先结束现有录制。');
      if(abort)return;
      const token=randomBytes(24).toString('hex');
      server=http.createServer((req,res)=>{
        if(req.method!=='POST'){res.writeHead(405);res.end();return;}
        let body='',oversized=false;req.on('data',chunk=>{body+=chunk;if(Buffer.byteLength(body)>65536){oversized=true;req.destroy();}});
        req.on('error',()=>{});req.on('end',()=>{
          if(oversized)return;
          let accepted=false;try{const payload=JSON.parse(body);if(payload.auth?.token===token){accepted=true;const id=String(payload.player?.steamid||'');if(/^\d{17}$/.test(id)){observed=id;observedAt=now();observedSerial++;const currentSlot=payload.player?.observer_slot;observedSlot=Number.isSafeInteger(currentSlot)&&currentSlot>=0&&currentSlot<=63?currentSlot:undefined;}const slot=payload.allplayers?.[String(player.id)]?.observer_slot;if(Number.isSafeInteger(slot)&&slot>=0&&slot<=63){targetSlot=slot;targetSlotAt=now();}}}catch{}
          res.writeHead(accepted?204:403);res.end();
        });
      });
      server.requestTimeout=3000;server.headersTimeout=3000;
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
      const folder=path.resolve(path.dirname(gameExe()),'../../csgo/cfg');config=path.join(folder,'gamestate_integration_demodesk_studio.cfg');
      if(fs.existsSync(config))throw new Error('录制校验配置已存在，请先结束其他 Demo Desk 录制。');
      configText=`"Demo Desk Recording"\n{\n"uri" "http://127.0.0.1:${server.address().port}"\n"timeout" "2"\n"buffer" "0.1"\n"throttle" "0.2"\n"heartbeat" "1"\n"auth" { "token" "${token}" }\n"data" { "provider" "1" "player_id" "1" "player_state" "1" "allplayers_id" "1" }\n}\n`;
      await fs.promises.writeFile(config,configText,{flag:'wx'});ownedConfig=true;
      if(abort)return;
      const stage=await launch(demo);
      let files;try{files=stageFiles(stage.gameExe,stage.id);}catch{throw new Error('缺少本次录像的独立播放日志，无法确认真实 Tick，已停止自动录制。');}
      monitor=createLogReader(files.log);
      task.phase='waiting';task.message='等待 CS2 启动；如 Steam 弹出确认，请点击启动';
      let ready=false;
      for(let i=0;i<120&&!abort;i++){
        let log='';try{log=fs.readFileSync(files.log,'utf8');}catch{}
        if(!/CSGO_GAME_UI_STATE_LOADINGSCREEN -> CSGO_GAME_UI_STATE_INGAME/.test(log)){await wait(1000);continue;}
        await acknowledgement('demo_pause');controlled=!abort;ready=!abort;break;
      }
      if(abort)return;
      if(!ready)throw new Error('未能确认 CS2 录像已进入游戏，请检查 Steam 启动确认、录像兼容性和日志写入。');
      for(const segment of segments){
        if(abort)break;
        task.phase='waiting';task.message=`定位 ${segment.label||'片段'} 并校验玩家视角`;
        await acknowledgement(`demo_pause; demo_gototick ${segment.startTick} 0 1; demo_timescale 1`);
        if(abort)break;
        // Seeking is asynchronous. Query the real current tick before recording.
        let located=false;
        for(let attempt=0;attempt<20&&!abort;attempt++){
          await wait(500);const output=await acknowledgement('demo_gototick');
          const position=logEvents(output).filter(event=>event.kind==='position').at(-1);
          if(position&&Math.abs(position.tick-segment.startTick)<=1){located=true;break;}
        }
        if(abort)break;
        if(!located)throw new Error('CS2 未确认片段起始 Tick，已停止录制，避免录下错误时间段。');
        // Match the authenticated game's observer slot by SteamID. Display
        // names can be anonymized or duplicated, so never match roster names.
        const slot=now()-targetSlotAt<=5000?targetSlot:undefined;
        let selectionSerial;
        const selectPOV=async candidate=>{
          observed='';observedAt=-Infinity;observedSlot=undefined;selectionSerial=observedSerial;
          await acknowledgement(`${playerCommand(player,candidate)}; demoui false`);
          for(let i=0;i<20&&!abort;i++){if(observedSerial>selectionSerial&&freshPOV())return true;await wait(500);}
          return false;
        };
        let verified=await selectPOV(slot);
        // Command indices and GSI observer slots can differ. Calibrate once
        // from the actual fresh result, never from an assumed +/-1 offset.
        if(!verified&&!abort&&slot!==undefined&&observedSerial>selectionSerial&&now()-observedAt<=5000&&now()-targetSlotAt<=5000&&observedSlot!==undefined){
          const candidate=slot+targetSlot-observedSlot;
          if(Number.isSafeInteger(candidate)&&candidate>=0&&candidate<=63&&candidate!==slot){
            task.message='重新校准所选玩家观察槽位并校验 SteamID';
            verified=await selectPOV(candidate);
          }
        }
        if(abort)break;
        if(!verified)throw new Error(slot===undefined?'游戏未提供所选玩家的 SteamID 视角映射，昵称切换也未通过身份校验。请重新载入录像后再试。':'游戏未确认所选玩家 SteamID 对应的视角，已停止录制。请关闭自动导播或重新载入录像。');
        activeSegment=segment;
        // OBS captures before the first demo frame advances.
        await obs.start(scene);recordingStarted=true;
        if(abort)break;
        if(!freshPOV())throw new Error('所选玩家视角已失效，已停止录制。');
        monitor.reset();await consoleCommand(`demo_step_tick ${segment.endTick-segment.startTick}`);
        task.phase='recording';task.message=`正在录制 ${segment.label||'片段'}`;
        let completed=false;
        const limit=Math.max(30000,(segment.endTick-segment.startTick)/64*4000+30000);
        for(let elapsed=0;elapsed<limit&&!abort;elapsed+=250){
          if(!freshPOV())throw new Error(observed&&observed!==String(player.id)?'游戏切换到了其他玩家视角，已停止录制，素材标记为未完成。':'游戏状态校验超过 5 秒未更新，已停止录制，素材标记为未完成。');
          const events=logEvents(monitor.read());
          if(events.some(event=>event.kind==='seek'))throw new Error('录制期间录像被跳转，已停止录制，素材标记为未完成。');
          if(events.some(event=>event.kind==='unsupported'))throw new Error('当前 CS2 不支持所需录像控制指令，已停止录制。');
          if(events.some(event=>event.kind==='ended'))throw new Error('录像或游戏提前结束，素材标记为未完成。');
          const paused=events.filter(event=>event.kind==='pause').at(-1);
          if(paused){
            if(Math.abs(paused.tick-segment.endTick)<=1){completed=true;break;}
            throw new Error(`录像在 Tick ${paused.tick} 提前暂停，素材标记为未完成。`);
          }
          await wait(250);
        }
        if(!abort&&!completed)throw new Error('等待录像目标 Tick 超时，已停止录制，素材标记为未完成。');
        await stoppedSegment(completed&&!abort);
        if(completed&&!abort)task.done++;
      }
      task.phase=abort?'cancelled':'done';task.message=abort?'录制已取消':'录制完成，素材已进入剪辑列表';
    }catch(error){task.phase='error';task.message=error.message;throw error;}
    finally{
      let cleanupError;
      // Preserve partial files, stopping only the OBS recording this task began.
      try{await stoppedSegment(false);}catch(error){cleanupError=error;}
      if(controlled)try{await consoleCommand('demo_pause; spec_lock_to_accountid 0');}catch{}
      if(server){await new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();});}
      if(ownedConfig)try{if(await fs.promises.readFile(config,'utf8')===configText)await fs.promises.unlink(config);}catch{}
      running=false;
      if(abort&&task.phase!=='error'){task.phase='cancelled';task.message='录制已取消';}
      if(cleanupError&&task.phase!=='error'){task.phase='error';task.message=cleanupError.message;throw cleanupError;}
    }
  }
  function cancel(){if(running)abort=true;}
  return {execute,cancel,status:()=>({task,clips}),get busy(){return running;}};
}
module.exports={createRecording,playerCommand,gameCommand,createLogReader,logEvents};
