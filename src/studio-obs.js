const {OBSWebSocket}=require('obs-websocket-js/json');
function obsAddress(value){const u=new URL(value||'ws://127.0.0.1:4455');if(!['ws:','wss:'].includes(u.protocol)||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password||u.pathname!=='/')throw new Error('OBS 地址须为本机 WebSocket，例如 ws://127.0.0.1:4455。');return u.href;}
function createObs({factory=()=>new OBSWebSocket(),settings,secrets}){
  let client=null,connected=false,owned=false;
  async function connect(){
    if(connected)return;
    client=factory();client.on('ConnectionClosed',()=>{connected=false;});client.on('error',()=>{});
    try{await client.connect(obsAddress(settings().obsAddress),secrets().obsPassword||'',{rpcVersion:1});connected=true;}
    catch{await client.disconnect().catch(()=>{});throw new Error('无法连接 OBS。请打开 OBS 的 WebSocket 服务器并检查地址和密码。');}
  }
  async function status(){await connect();const [version,scene,record]=await Promise.all([client.call('GetVersion'),client.call('GetSceneList'),client.call('GetRecordStatus')]);return {connected:true,version:version.obsVersion,scenes:scene.scenes.map(x=>x.sceneName),scene:scene.currentProgramSceneName,recording:record.outputActive};}
  async function start(scene){await connect();if((await client.call('GetRecordStatus')).outputActive)throw new Error('OBS 已在录制，请先结束现有录制。');if(scene)await client.call('SetCurrentProgramScene',{sceneName:scene});await client.call('StartRecord');owned=true;}
  async function stop(){if(!owned)return null;owned=false;try{await connect();return await client.call('StopRecord');}catch{throw new Error('OBS 停止录制失败，请在 OBS 中检查录制状态。');}}
  async function close(){if(owned)await stop().catch(()=>{});await client?.disconnect().catch(()=>{});connected=false;}
  return {status,start,stop,close,get recording(){return owned;}};
}
module.exports={createObs,obsAddress};
