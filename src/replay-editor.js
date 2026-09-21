let replayDraft;
function replayEditorHTML() {
  replayDraft ||= structuredClone(state.settings.replayControls || ReplayControls.defaults());
  const commands = [...new Set([...ReplayControls.presets.map(x=>x[2]),'demo_pause','demo_resume','demo_timescale 0.25','demo_timescale 8'])];
  return `<div class="settings-card"><h2>回放快捷键</h2><p>修改后点击保存，软件会自动更新 CFG，并在下一次一键播放时加载。</p><p>绑定会替换游戏中同名按键的原有功能，且可能被游戏保存。建议使用闲置按键；取消绑定或关闭此功能不会恢复游戏原有按键。</p><label class="toggle-label"><input id="replayEnabled" type="checkbox" ${replayDraft.enabled ? 'checked' : ''}>一键播放时加载回放快捷键</label></div>
  <div class="settings-card"><div class="replay-table"><div class="replay-row replay-head"><span>操作名称</span><span>绑定按键</span><span>播放指令</span><span></span></div>${replayDraft.bindings.map((row,i)=>`<div class="replay-row" data-binding="${i}"><input aria-label="操作名称 ${i+1}" data-field="label" maxlength="40" value="${escape(row.label)}"><select aria-label="绑定按键 ${i+1}" data-field="key">${ReplayControls.keys.map(key=>`<option value="${key}" ${key===row.key?'selected':''}>${key || '不绑定'}</option>`).join('')}</select><select aria-label="播放指令 ${i+1}" data-field="command">${commands.map(cmd=>`<option value="${cmd}" ${cmd===row.command?'selected':''}>${cmd}</option>`).join('')}</select><button class="icon-button" data-remove-binding="${i}" aria-label="移除操作 ${i+1}">×</button></div>`).join('')}</div><div class="replay-actions"><button id="addBinding" class="button subtle small">＋ 添加操作</button><button id="resetBindings" class="button subtle small">恢复默认配置</button><button id="saveBindings" class="button primary">保存并更新 CFG</button></div><p id="replaySaveStatus" role="status">${replayDraft.dirty ? '有未保存的修改' : '保存后，下次一键播放自动生效'}</p><details><summary>查看生成的 CFG</summary><pre id="replayPreview" class="path-box"></pre></details></div>`;
}
function bindReplayEditor() {
  const preview = () => {
    try { $('#replayPreview').textContent = ReplayControls.cfg(replayDraft); }
    catch(e) { $('#replayPreview').textContent = e.message; }
  };
  const dirty = () => { replayDraft.dirty=true; $('#replaySaveStatus').textContent='有未保存的修改'; preview(); };
  $('#replayEnabled').addEventListener('change',e=>{replayDraft.enabled=e.target.checked;dirty();});
  document.querySelectorAll('[data-binding] [data-field]').forEach(el=>el.addEventListener('change',()=>{
    replayDraft.bindings[Number(el.closest('[data-binding]').dataset.binding)][el.dataset.field]=el.value;dirty();
  }));
  document.querySelectorAll('[data-remove-binding]').forEach(el=>el.addEventListener('click',()=>{
    replayDraft.bindings.splice(Number(el.dataset.removeBinding),1);replayDraft.dirty=true;renderPage();
  }));
  $('#addBinding').addEventListener('click',()=>{
    if(replayDraft.bindings.length>=40){toast('最多添加 40 项操作。');return;}
    replayDraft.bindings.push({label:'新操作',key:'',command:'demo_togglepause'});replayDraft.dirty=true;renderPage();
  });
  $('#resetBindings').addEventListener('click',()=>{replayDraft={...ReplayControls.defaults(),dirty:true};renderPage();});
  $('#saveBindings').addEventListener('click',async()=>{
    const button=$('#saveBindings');button.disabled=true;
    try {
      const config=ReplayControls.normalize(replayDraft);
      const result=await call('replay-controls-save',config);
      replayDraft={...config,dirty:false};
      if(page==='replay') { $('#replaySaveStatus').textContent=result.installed ? '已保存并更新游戏 CFG，下次一键播放生效。' : '已保存在本机，下次一键播放时自动写入游戏目录。'; }
    } catch(e) { if(page==='replay') $('#replaySaveStatus').textContent=e.message; }
    finally {button.disabled=false;}
  });
  preview();
}
