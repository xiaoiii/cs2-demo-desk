const fs=require('node:fs');
const path=require('node:path');
const {Worker}=require('node:worker_threads');
const {randomUUID}=require('node:crypto');
const {inspectFile,atomicSave}=require('./core');
const {summarize,analyzePlayer}=require('./review-analysis');

function createReviewService({directory,workerFactory=(file,options)=>new Worker(file,options)}){
  const index=path.join(directory,'review-library.json');
  let records=[];try{records=JSON.parse(fs.readFileSync(index,'utf8')).items||[];}catch{}
  const workers=new Set(),cache=new Map(),pending=new Map(),analyses=new Map();
  const persist=()=>atomicSave(index,{items:records});
  function get(id){const row=records.find(x=>x.id===id);if(!row)throw new Error('复盘库中找不到该录像。');if(!fs.existsSync(row.path))throw new Error('录像已移动或删除，请重新导入。');return row;}
  function add(filename){
    if(!path.isAbsolute(filename)||inspectFile(filename)!=='dem')throw new Error('请选择有效的 DEM 文件。');
    const real=fs.realpathSync(filename),stat=fs.statSync(real);
    let row=records.find(x=>x.path.toLowerCase()===real.toLowerCase());
    if(!row){row={id:randomUUID(),path:real,filename:path.basename(real),created:Date.now(),size:stat.size,mtime:stat.mtimeMs,status:'ready'};records.unshift(row);persist();}
    return row;
  }
  function scan(folder){if(!folder||!fs.existsSync(folder))throw new Error('请先在设置中选择录像目录。');let count=0;for(const file of fs.readdirSync(folder,{withFileTypes:true})){if(file.isFile()&&/\.dem$/i.test(file.name)){try{const before=records.length;add(path.join(folder,file.name));if(records.length>before)count++;}catch{}}}return {added:count,items:records};}
  function job(action,row,extra={}){return new Promise((resolve,reject)=>{
    const worker=workerFactory(path.join(__dirname,'review-worker.js'),{workerData:{action,path:row.path,...extra}});workers.add(worker);
    const timer=setTimeout(()=>{worker.terminate();reject(new Error('解析超时，请确认录像完整。'));},120000);
    const finish=()=>{clearTimeout(timer);workers.delete(worker);};
    worker.once('message',reply=>{finish();reply.ok?resolve(reply.value):reject(new Error(reply.error));worker.terminate();});
    worker.once('error',error=>{finish();reject(new Error(`解析失败：${error.message}`));});
    worker.once('exit',code=>{finish();if(code)reject(new Error('解析进程已退出。'));});
  });}
  async function inspect(id){
    const row=get(id),stat=fs.statSync(row.path),fingerprint=`${stat.size}:${stat.mtimeMs}`;
    if(cache.get(id)?.fingerprint===fingerprint)return cache.get(id).parsed;
    if(pending.has(id))return pending.get(id);
    const promise=(async()=>{row.status='parsing';try{const parsed=await job('inspect',row);cache.set(id,{fingerprint,parsed});for(const key of analyses.keys())if(key.startsWith(id+':'))analyses.delete(key);Object.assign(row,{meta:summarize(parsed),status:'ready',size:stat.size,mtime:stat.mtimeMs,error:''});persist();return parsed;}catch(error){row.status='error';row.error=error.message;persist();throw error;}finally{pending.delete(id);}})();pending.set(id,promise);return promise;
  }
  async function players(id){return summarize(await inspect(id));}
  async function analyze(id,playerId,options){const parsed=await inspect(id),key=id+':'+String(playerId);if(!analyses.has(key))analyses.set(key,analyzePlayer(parsed,playerId,options));return analyses.get(key);}
  async function radar(id,tick,endTick){const row=get(id);const start=Math.max(0,Math.floor(Number(tick)||0));const end=Math.max(start,Math.min(start+8192,Math.floor(Number(endTick)||start)));const ticks=[];for(let t=start;t<=end;t+=32)ticks.push(t);return job('radar',row,{tick:start,ticks});}
  function list(){return {items:records.map(row=>({...row,status:pending.has(row.id)?'parsing':row.status==='parsing'?'ready':row.status})),busy:workers.size>0};}
  async function stop(){await Promise.allSettled([...workers].map(worker=>worker.terminate()));}
  return {add,scan,get,players,analyze,radar,list,stop,get busy(){return workers.size>0;}};
}
module.exports={createReviewService};
