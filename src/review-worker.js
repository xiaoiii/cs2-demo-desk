function execute(workerData,send){try {
  const parser=require('@laihoe/demoparser2');
  if(workerData.action==='radar'){
    const tick=Math.max(0,Math.floor(Number(workerData.tick)||0));
    const ticks=Array.isArray(workerData.ticks)?workerData.ticks:[tick];
    const positions=parser.parseTicks(workerData.path,['X','Y','Z','health','yaw','team_num','user_id'],ticks);
    send({ok:true,value:{tick,positions}});
  }else{
    const header=parser.parseHeader(workerData.path),players=parser.parsePlayerInfo(workerData.path);
    const events=parser.parseEvents(workerData.path,['player_death','player_hurt','round_freeze_end','round_end','bomb_planted','bomb_defused'],[],['total_rounds_played']);
    send({ok:true,value:{header,players,events}});
  }
}catch(error){send({ok:false,error:String(error?.message||'DEM 解析失败')});}}
if(process.parentPort){process.parentPort.once('message',event=>execute(event.data,value=>process.parentPort.postMessage(value)));}
else{const {parentPort,workerData}=require('node:worker_threads');execute(workerData,value=>parentPort.postMessage(value));}
