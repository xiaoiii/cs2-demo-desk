const fs=require('node:fs');
const {atomicSave}=require('./core');
function createStudioSecrets({filename,safeStorage}){
  let secrets={};
  try{if(fs.existsSync(filename)){const saved=JSON.parse(fs.readFileSync(filename,'utf8'));secrets=JSON.parse(safeStorage.decryptString(Buffer.from(saved.data,'base64')));}}catch{}
  function save(values){
    if(!safeStorage.isEncryptionAvailable())throw new Error('Windows 本机加密不可用，无法保存 OBS 或 AI 密钥。');
    const next={...secrets,...values};
    const encrypted=safeStorage.encryptString(JSON.stringify(next));
    atomicSave(filename,{data:encrypted.toString('base64')});secrets=next;
  }
  return {get:()=>({...secrets}),save,status:()=>({obsPasswordSaved:!!secrets.obsPassword,aiKeySaved:!!secrets.aiKey})};
}
module.exports={createStudioSecrets};
