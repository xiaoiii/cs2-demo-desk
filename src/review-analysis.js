const { createHash } = require('node:crypto');
const sid = value => String(value || '');
const display = value => String(value || '').trim();

function summarize({header={},players=[],events=[]}) {
  const roster=new Map();
  for(const p of players){if(p.steamid)roster.set(sid(p.steamid),{id:sid(p.steamid),name:display(p.name),team:Number(p.team_number)||0,kills:0,deaths:0,assists:0,headshots:0,damage:0});}
  const ensure=(id,name)=>{id=sid(id);if(!id||id==='0')return null;if(!roster.has(id))roster.set(id,{id,name:display(name),team:0,kills:0,deaths:0,assists:0,headshots:0,damage:0});return roster.get(id);};
  const rounds=[];let maxTick=0;
  for(const e of events){
    maxTick=Math.max(maxTick,Number(e.tick)||0);
    const attacker=ensure(e.attacker_steamid,e.attacker_name),victim=ensure(e.user_steamid,e.user_name);
    if(e.event_name==='player_death'){
      if(victim)victim.deaths++;
      if(attacker&&attacker.id!==victim?.id){attacker.kills++;if(e.headshot)attacker.headshots++;}
      const assister=ensure(e.assister_steamid,e.assister_name);if(assister)assister.assists++;
    }
    if(e.event_name==='player_hurt'&&attacker&&attacker.id!==victim?.id)attacker.damage+=Math.max(0,Math.min(100,Number(e.dmg_health)||0));
    if(e.event_name==='round_end')rounds.push({round:Number(e.round)||Number(e.total_rounds_played)||rounds.length+1,tick:Number(e.tick),winner:e.winner,reason:e.reason});
  }
  const totalRounds=Math.max(0,...rounds.map(x=>x.round));
  return {map:header.map_name||'',server:header.server_name||'',tickRate:64,endTick:maxTick,totalRounds,rounds,players:[...roster.values()].map(p=>({...p,kd:p.deaths?Math.round(p.kills/p.deaths*100)/100:p.kills,adr:totalRounds?Math.round(p.damage/totalRounds):0,hs:p.kills?Math.round(p.headshots/p.kills*100):0})).sort((a,b)=>b.kills-a.kills)};
}

function analyzePlayer(parsed,playerId,{before=4,after=3}={}) {
  const meta=summarize(parsed),player=meta.players.find(x=>x.id===sid(playerId));
  if(!player)throw new Error('录像中找不到所选玩家。');
  const rate=meta.tickRate,groups=new Map();
  const roundOf=e=>Math.max(1,(Number(e.total_rounds_played)||0)+(e.event_name==='round_end'?0:1));
  for(const e of parsed.events){const round=roundOf(e);if(!groups.has(round))groups.set(round,{round,start:0,end:0,kills:[],deaths:[],utility:[]});const group=groups.get(round);
    if(e.event_name==='round_freeze_end')group.start=Number(e.tick);
    if(e.event_name==='round_end')group.end=Number(e.tick);
    if(e.event_name==='player_death'){
      if(sid(e.attacker_steamid)===player.id&&sid(e.user_steamid)!==player.id)group.kills.push(e);
      if(sid(e.user_steamid)===player.id)group.deaths.push(e);
    }
    if(['bomb_planted','bomb_defused'].includes(e.event_name)&&sid(e.user_steamid)===player.id)group.utility.push(e);
  }
  const clips=[],timeline=[];
  const clip=(kind,label,round,first,last,extra={})=>({id:createHash('sha256').update(`${player.id}:${kind}:${round}:${first}:${last}`).digest('hex').slice(0,24),kind,label,round,startTick:Math.max(0,Number(first)-before*rate),endTick:Math.min(meta.endTick,Number(last)+after*rate),playerId:player.id,...extra});
  for(const g of groups.values()){
    if(!g.start&&g.kills.length)g.start=Math.max(0,g.kills[0].tick-10*rate);
    if(!g.end)g.end=meta.endTick;
    if(g.start&&g.end>g.start)clips.push(clip('round',`第 ${g.round} 回合 POV`,g.round,g.start,g.end,{kills:g.kills.length,score:g.kills.length*25}));
    if(g.kills.length)clips.push(clip('highlight',`${g.kills.length} 杀${g.kills.some(e=>e.headshot)?' · 爆头':''}`,g.round,g.kills[0].tick,g.kills.at(-1).tick,{kills:g.kills.length,score:g.kills.length*25+g.kills.filter(e=>e.headshot).length*5,events:g.kills.map(e=>({tick:e.tick,weapon:e.weapon,victim:display(e.user_name),headshot:!!e.headshot}))}));
    for(const e of g.deaths){clips.push(clip('death','死亡复盘',g.round,e.tick,e.tick,{score:0,killer:display(e.attacker_name)}));timeline.push({kind:'death',round:g.round,tick:e.tick,label:`被 ${display(e.attacker_name)} 击杀`});}
    for(const e of g.kills)timeline.push({kind:'kill',round:g.round,tick:e.tick,label:`${e.weapon} → ${display(e.user_name)}${e.headshot?' · 爆头':''}`});
    for(const e of g.utility)timeline.push({kind:'objective',round:g.round,tick:e.tick,label:e.event_name==='bomb_defused'?'拆弹':'下包'});
  }
  return {player,meta,clips:clips.sort((a,b)=>a.round-b.round||a.startTick-b.startTick),timeline:timeline.sort((a,b)=>a.tick-b.tick)};
}
module.exports={summarize,analyzePlayer};
