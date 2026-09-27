function createTrayController({Tray,Menu,icon,show,action,exit}) {
  const tray=new Tray(icon);let signature='',announced=false;
  tray.on('click',()=>show());
  function update(state){
    const pending=state.items.filter(x=>x.extracting||['queued','resolving','connecting','downloading','paused'].includes(x.status));
    const paused=pending.filter(x=>x.status==='paused').length;
    const running=pending.filter(x=>x.status==='downloading').length;
    const countdown=state.automation?.phase==='countdown';
    const next=JSON.stringify([pending.length,paused,running,countdown]);if(next===signature)return;signature=next;
    tray.setToolTip(`CS2 Demo Desk${pending.length?` · ${pending.length} 个任务${paused?`，${paused} 个暂停`:''}`:' · 后台就绪'}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      {label:'打开主窗口',click:()=>show()},
      {label:`下载队列${pending.length?` (${pending.length})`:''}`,click:()=>show('downloads')},
      {label:'本地 Demo 库',click:()=>show('library')},
      {type:'separator'},
      {label:'刷新比赛',click:()=>action('refresh-all')},
      {label:'暂停正在下载的任务',enabled:running>0,click:()=>action('pause-all')},
      {label:'继续已暂停的任务',enabled:paused>0,click:()=>action('resume-all')},
      {label:'打开下载文件夹',click:()=>action('open-folder')},
      {label:'取消本次自动退出',enabled:countdown,click:()=>action('cancel-auto-quit')},
      {type:'separator'},
      {label:'退出软件',click:exit},
    ]));
  }
  function announce(){if(announced)return;announced=true;tray.displayBalloon?.({title:'Demo Desk 已转入后台',content:'下载会继续。点击右下角托盘图标可恢复窗口，右键菜单可退出软件。'});}
  return {update,announce,destroy:()=>tray.destroy()};
}
module.exports={createTrayController};
