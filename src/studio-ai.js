function endpoint(value){const url=new URL(value||'');if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))throw new Error('AI 地址必须为 HTTPS，或本机 HTTP 服务。');if(url.username||url.password)throw new Error('AI 地址不能包含账号密码。');url.pathname=url.pathname.replace(/\/$/,'')+'/chat/completions';return url.href;}
async function reviewWithAI({settings,key,analysis,fetchImpl=fetch}){
  if(!key&&!(settings.aiBase||'').startsWith('http://127.0.0.1'))throw new Error('请先保存 AI 接口地址、模型和密钥。');
  const summary={player:analysis.player,rounds:analysis.meta.totalRounds,map:analysis.meta.map,clips:analysis.clips.filter(x=>x.kind==='highlight').map(x=>({id:x.id,round:x.round,kills:x.kills,events:x.events,score:x.score}))};
  let response;try{response=await fetchImpl(endpoint(settings.aiBase),{method:'POST',headers:{'content-type':'application/json',...(key?{authorization:`Bearer ${key}`}:{})},signal:AbortSignal.timeout(90000),body:JSON.stringify({model:String(settings.aiModel||''),temperature:0.3,messages:[{role:'system',content:'你是 CS2 复盘教练。仅依据给定的事件数据点评，不推测不存在的战术、站位或经济。返回 JSON 对象，包含 commentary 中文简短点评，以及 clipIds 数组（按适合精彩集锦的顺序排列真实片段 id）。不要编造 id。'},{role:'user',content:JSON.stringify(summary)}]})});}catch{throw new Error('AI 请求失败，请检查网络与接口地址。');}
  if(!response.ok)throw new Error(`AI 服务拒绝请求（HTTP ${response.status}），请检查配置。`);
  const json=await response.json(),content=String(json.choices?.[0]?.message?.content||'').replace(/^```(?:json)?\s*|\s*```$/g,'');let result;
  try{result=JSON.parse(content);}catch{return {commentary:content.slice(0,6000),clipIds:[]};}
  const valid=new Set(summary.clips.map(x=>x.id));return {commentary:String(result.commentary||'').slice(0,6000),clipIds:[...new Set((Array.isArray(result.clipIds)?result.clipIds:[]).filter(x=>valid.has(x)))]};
}
module.exports={endpoint,reviewWithAI};
