const test=require('node:test'),assert=require('node:assert/strict');
const {createTrayController}=require('../src/tray-controller');
test('Tray supports navigation, task-sensitive controls, cancellation and explicit exit',()=>{
 let instance,exits=0;const actions=[],pages=[];
 class Tray{constructor(){instance=this;this.events={};this.balloons=0;}on(n,fn){this.events[n]=fn;}setToolTip(s){this.tip=s;}setContextMenu(menu){this.menu=menu;}displayBalloon(){this.balloons++;}destroy(){this.destroyed=true;}}
 const t=createTrayController({Tray,Menu:{buildFromTemplate:x=>x},icon:'icon.ico',show:p=>pages.push(p),action:a=>actions.push(a),exit:()=>exits++});
 const s={items:[{status:'downloading'},{status:'paused'}],automation:{phase:'countdown'}};t.update(s);
 assert.match(instance.tip,/2 个任务/);instance.events.click();instance.menu.find(x=>x.label.startsWith('下载队列')).click();assert.deepEqual(pages,[undefined,'downloads']);
 for(const label of ['暂停正在下载的任务','继续已暂停的任务','取消本次自动退出']){const item=instance.menu.find(x=>x.label===label);assert.equal(item.enabled,true);item.click();}
 assert.deepEqual(actions,['pause-all','resume-all','cancel-auto-quit']);instance.menu.find(x=>x.label==='退出软件').click();assert.equal(exits,1);
 t.announce();t.announce();assert.equal(instance.balloons,1);s.items=[];s.automation={};t.update(s);assert.equal(instance.menu.find(x=>x.label==='继续已暂停的任务').enabled,false);t.destroy();assert.equal(instance.destroyed,true);
});
