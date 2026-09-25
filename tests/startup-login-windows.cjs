const {_electron:electron}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(root,'test-results','login-setting-'));
const executable=path.join(profile,'startup-fixture.exe');fs.writeFileSync(executable,'test-only');
(async()=>{
 const env={...process.env,DEMODESK_TEST:'1',DEMODESK_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
 const app=await electron.launch({args:[root],env});
 try{
  const result=await app.evaluate(({app},options)=>{
   let enabled,disabled;
   try { app.setLoginItemSettings({...options,openAtLogin:true});enabled=app.getLoginItemSettings({path:options.path,args:options.args}); }
   finally { app.setLoginItemSettings({...options,openAtLogin:false});disabled=!app.getLoginItemSettings({path:options.path,args:options.args}).openAtLogin; }
   return {enabled,disabled,options};
  },{name:'DemoDesk-Temporary-Test-'+randomUUID(),path:executable,args:[]});
  assert.equal(require('../src/startup-settings').loginEnabled(result.enabled,result.options),true);assert.equal(result.disabled,true);console.log('Windows login item write/read/remove verified using a unique temporary test entry. No reboot performed.');
 }finally{await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
