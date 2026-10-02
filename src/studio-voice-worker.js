const { scanDemoVoice } = require('./studio-voice');
function execute(data, send) {
  try { send({ ok: true, value: scanDemoVoice(data.path) }); }
  catch (error) { send({ ok: false, error: String(error?.message || 'DEM 语音分析失败。') }); }
}
if (process.parentPort) process.parentPort.once('message', event => execute(event.data, value => process.parentPort.postMessage(value)));
else process.once('message', data => execute(data, value => process.send(value)));
