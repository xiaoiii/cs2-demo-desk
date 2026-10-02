const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {atomicSave}=require('./core');
const {pathToFileURL}=require('node:url');
function normalizeSegment(segment){
  if(!segment||typeof segment.path!=='string'||!path.isAbsolute(segment.path)||!fs.existsSync(segment.path)||!fs.statSync(segment.path).isFile())throw new Error('素材文件不存在。');
  const start=Number(segment.start)||0,end=Number(segment.end),speed=Number(segment.speed)||1,volume=segment.volume===undefined?1:Number(segment.volume);
  if(start<0||!Number.isFinite(end)||end<=start||end-start>7200||!Number.isFinite(speed)||speed<0.5||speed>2||!Number.isFinite(volume)||volume<0||volume>2)throw new Error('裁剪时间、速度或音量无效。');
  const filename=fs.realpathSync(segment.path);return {id:String(segment.id||randomUUID()),path:filename,preview:pathToFileURL(filename).href,start,end,speed,volume,title:String(segment.title||'').replace(/[\r\n]/g,' ').slice(0,100),look:['original','cinema','mono'].includes(segment.look)?segment.look:'original',fade:segment.fade===true,noAudio:segment.noAudio===true};
}
function exportArgs(segment,output,titleFile){
  let filters=`setpts=PTS/${segment.speed},scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=60`;
  if(segment.look==='cinema')filters+=',eq=contrast=1.1:saturation=1.12:brightness=-0.02';if(segment.look==='mono')filters+=',hue=s=0';
  if(segment.fade){const duration=(segment.end-segment.start)/segment.speed;const fade=Math.min(0.3,duration/3);filters+=`,fade=t=in:st=0:d=${fade},fade=t=out:st=${Math.max(0,duration-fade)}:d=${fade}`;}
  if(titleFile){const escape=value=>value.replace(/\\/g,'/').replace(/:/g,'\\:').replace(/'/g,"'\\''");const font=path.join(process.env.WINDIR||'C:\\Windows','Fonts','msyh.ttc');filters+=`,drawtext=fontfile='${escape(font)}':textfile='${escape(titleFile)}':fontsize=36:fontcolor=white:box=1:boxcolor=black@0.4:x=40:y=40`;}
  return ['-hide_banner','-nostdin','-y','-ss',String(segment.start),'-t',String(segment.end-segment.start),'-i',segment.path,...(segment.noAudio?['-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000','-map','0:v:0','-map','1:a:0']:[]),'-t',String((segment.end-segment.start)/segment.speed),'-vf',filters,'-af',`atempo=${segment.speed},volume=${segment.volume}`,'-c:v','libx264','-preset','veryfast','-crf','20','-c:a','aac','-ar','48000','-ac','2',output];
}
function createEditor({directory,ffmpeg,spawnImpl=spawn}){
  const index=path.join(directory,'studio-projects.json');let projects=[];try{projects=JSON.parse(fs.readFileSync(index,'utf8')).items||[];}catch{}
  let job=null,child=null,cancelled=false;
  const persist=()=>atomicSave(index,{items:projects});
  function save({id,name,segments}){if(!Array.isArray(segments)||segments.length>100)throw new Error('剪辑项目最多 100 个片段。');const body={id:id||randomUUID(),name:String(name||'我的剪辑').trim().slice(0,100),segments:segments.map(normalizeSegment),updated:Date.now()};const existing=projects.findIndex(p=>p.id===body.id);if(existing<0)projects.unshift(body);else projects[existing]=body;persist();return body;}
  function execute(args){return new Promise((resolve,reject)=>{let tail='';child=spawnImpl(ffmpeg,args,{windowsHide:true,stdio:['ignore','ignore','pipe']});child.stderr?.on('data',b=>{tail=(tail+b.toString()).slice(-3000);});child.once('error',()=>reject(new Error('无法启动内置视频处理工具。')));child.once('exit',code=>{child=null;code===0?resolve():reject(new Error(cancelled?'导出已取消':`视频处理失败，请检查素材是否包含有效画面和音频。${tail.includes('No space left')?'磁盘空间不足。':''}`));});});}
  async function exportProject(id,output){
    if(job?.phase==='exporting')throw new Error('已有视频正在导出。');const project=projects.find(p=>p.id===id);if(!project?.segments.length)throw new Error('请先保存至少一个剪辑片段。');if(!path.isAbsolute(output)||path.extname(output).toLowerCase()!=='.mp4')throw new Error('请选择 MP4 输出位置。');
    const segments=project.segments.map(normalizeSegment);if(segments.some(s=>path.resolve(s.path).toLowerCase()===path.resolve(output).toLowerCase()))throw new Error('输出不能覆盖原始素材。');if(fs.existsSync(output))throw new Error('输出文件已存在，请选择新的文件名。');
    const work=path.join(directory,'exports',randomUUID());fs.mkdirSync(work,{recursive:true});cancelled=false;job={phase:'exporting',done:0,total:segments.length,message:'正在导出',output};let ownedOutput=false;
    try{const files=[];for(const [i,s]of segments.entries()){if(cancelled)throw new Error('导出已取消');const filename=path.join(work,`${i}.mp4`);let title;if(s.title){title=path.join(work,`${i}-title.txt`);fs.writeFileSync(title,s.title,'utf8');}await execute(exportArgs(s,filename,title));files.push(filename);job.done++;}
      const list=path.join(work,'concat.txt');fs.writeFileSync(list,files.map(f=>`file '${f.replace(/\\/g,'/')}'`).join('\n'));
      const staged=path.join(work,'result.mp4');await execute(['-hide_banner','-nostdin','-y','-f','concat','-safe','0','-i',list,'-c','copy','-movflags','+faststart',staged]);
      await fs.promises.copyFile(staged,output,fs.constants.COPYFILE_EXCL);ownedOutput=true;job.phase='done';job.message='导出完成';return {output};
    }catch(error){job.phase=cancelled?'cancelled':'error';job.message=error.message;if(ownedOutput)await fs.promises.unlink(output).catch(()=>{});throw error;}
    finally{await fs.promises.rm(work,{recursive:true,force:true}).catch(()=>{});}
  }
  function cancel(){cancelled=true;child?.kill();}
  return {list:()=>({projects,job}),save,exportProject,cancel,get busy(){return job?.phase==='exporting';}};
}
module.exports={createEditor,normalizeSegment,exportArgs};
