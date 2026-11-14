import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

const html = fs.readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const core = fs.readFileSync(new URL('../docs/core.js', import.meta.url), 'utf8').replace(/export /g, '');
const app = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
const syntheticConfig = {url:'https://synthetic-download.example',key:'synthetic-test-key-not-a-secret'};
const syntheticHistory = [{url:'https://youtu.be/nQlCeT4oDAw',title:'Synthetic saved link',quality:360,at:1}];
const syntheticActive = {id:'synthetic-pending-job',url:'https://www.youtube.com/watch?v=nQlCeT4oDAw',quality:360,server:'https://other-synthetic.example'};
const syntheticDraft = {url:'https://youtu.be/nQlCeT4oDAw',quality:480};

async function fixture({config,discovery=null,checkStatus=200,checkBody={ok:true},offline=false,pendingCheck=false,sessionStatus=200,checkResponses=[],active=syntheticActive,url='https://synthetic-pages.example/yt-down/'}={}) {
  const dom = new JSDOM(html, {url,runScripts:'outside-only'});
  const w = dom.window, calls = [];
  w.AbortController = AbortController; w.AbortSignal = AbortSignal;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  if (config) w.localStorage.setItem('yt-down.config', JSON.stringify(config));
  w.localStorage.setItem('yt-down.history', JSON.stringify(syntheticHistory));
  w.localStorage.setItem('yt-down.active', JSON.stringify(active));
  w.localStorage.setItem('synthetic-unrelated', 'preserve');
  w.sessionStorage.setItem('yt-down.update-state', JSON.stringify(syntheticDraft));
  let finishCheck;
  const checkWait = pendingCheck ? new Promise(resolve => { finishCheck = resolve; }) : null;
  const reply = (status,data) => ({ok:status>=200&&status<300,status,json:async()=>data});
  w.fetch = async (value,options={}) => {
    const target = new URL(value,w.location.href); calls.push({url:target.href,options});
    if (target.pathname.endsWith('/api/config')) return reply(discovery ? 200 : 404, discovery);
    if (target.pathname.endsWith('/deployment.json')) return reply(200,{app_url:null});
    if (target.pathname === '/api/session') return reply(sessionStatus,{ok:sessionStatus===200});
    if (target.pathname === '/api/check') {
      if (checkWait) await checkWait;
      if (offline) throw new w.TypeError('Synthetic network unavailable');
      const next=checkResponses.shift();
      return reply(next?.status??checkStatus,next?.body??checkBody);
    }
    if (target.pathname.startsWith('/api/jobs/')) return reply(200,{id:active.id,state:'working',message:'Synthetic preparation in progress'});
    throw new Error('Unexpected fixture network request: '+target.href);
  };
  w.eval(core+'\n'+app+'\nwindow.testBoot = boot;');
  const f = {w,calls,dom,boot:w.testBoot,q:id=>w.document.getElementById(id),finishCheck,close:()=>dom.window.close()};
  if (!pendingCheck) await f.boot;
  return f;
}
function assertSavedDataPreserved(f,config) {
  assert.equal(f.w.localStorage.getItem('yt-down.config'),config ? JSON.stringify(config) : null);
  assert.equal(f.w.localStorage.getItem('yt-down.history'),JSON.stringify(syntheticHistory));
  assert.equal(f.w.localStorage.getItem('yt-down.active'),JSON.stringify(syntheticActive));
  assert.equal(f.w.localStorage.getItem('synthetic-unrelated'),'preserve');
  assert.equal(f.q('video-url').value,syntheticDraft.url);
  assert.equal(f.q('quality').value,'480');
}

test('absent backend displays setup, preserves saved links/jobs/draft and never attempts a download', async t => {
  const f = await fixture(); t.after(f.close);
  assert.match(f.q('connection-text').textContent,/Start YT Down on your computer/);
  assert(!f.q('connection-dot').classList.contains('ready'));
  await f.q('download-form').onsubmit({preventDefault(){}});
  assert(f.q('settings').open);
  assert.match(f.q('settings-status').textContent,/run on your own computer/);
  assert(!f.calls.some(call=>call.url.includes('/api/jobs')));
  assertSavedDataPreserved(f);
  assert(f.calls.every(call=>!call.options.headers?.Authorization));
});

test('saved backend stays non-ready until its authenticated check succeeds', async t => {
  const f = await fixture({config:syntheticConfig,pendingCheck:true}); t.after(f.close);
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(f.q('connection-text').textContent,/Checking/);
  assert(!f.q('connection-dot').classList.contains('ready'));
  f.finishCheck(); await f.boot;
  assert.equal(f.q('connection-text').textContent,'Download server connected');
  assert(f.q('connection-dot').classList.contains('ready'));
  const checked=f.calls.find(call=>call.url===syntheticConfig.url+'/api/check');
  assert.equal(checked.options.headers.Authorization,'Bearer '+syntheticConfig.key);
  assertSavedDataPreserved(f,syntheticConfig);
});

test('unreachable saved backend reports failure, retains its credentials, and shows the reason in settings', async t => {
  const f = await fixture({config:syntheticConfig,offline:true}); t.after(f.close);
  assert.equal(f.q('connection-text').textContent,'Cannot reach the download server');
  assert(f.q('connection-dot').classList.contains('error'));
  assert(!f.q('connection-dot').classList.contains('ready'));
  await f.q('settings-open').onclick();
  assert.match(f.q('settings-status').textContent,/Cannot reach/);
  assert.equal(f.q('server-url').value,syntheticConfig.url);
  assert.equal(f.q('server-key').value,syntheticConfig.key);
  assertSavedDataPreserved(f,syntheticConfig);
});

test('401 saved backend requests attention to the key without discarding any configuration', async t => {
  const f = await fixture({config:syntheticConfig,checkStatus:401,checkBody:{detail:'Unlock the app with your private access key.'}}); t.after(f.close);
  assert.equal(f.q('connection-text').textContent,'Access key needs attention');
  assert(!f.q('connection-dot').classList.contains('ready'));
  await f.q('settings-open').onclick();
  assert.match(f.q('settings-status').textContent,/private access key/);
  assertSavedDataPreserved(f,syntheticConfig);
});

for (const missing of ['configured','tools_ready']) test('integrated host missing '+missing+' explains setup and does not offer a misleading unlock/download flow', async t => {
  const discovery={app:'yt-down',integrated:true,unlocked:true,configured:true,tools_ready:true,[missing]:false};
  const f = await fixture({config:syntheticConfig,discovery,url:'https://synthetic-host.example/'}); t.after(f.close);
  assert.equal(f.q('connection-text').textContent,'Download server needs setup');
  assert(!f.q('connection-dot').classList.contains('ready'));
  await f.q('download-form').onsubmit({preventDefault(){}});
  assert(f.q('settings').open);
  assert(f.q('connect-button').hidden); assert(f.q('access-key-field').hidden);
  assert.match(f.q('settings-status').textContent,missing==='configured' ? /private access key/ : /missing FFmpeg or Deno/);
  assert(!f.calls.some(call=>call.url.includes('/api/check')||call.url.includes('/api/jobs')));
  assertSavedDataPreserved(f,syntheticConfig);
});

test('integrated unlocked host verifies its session without overwriting saved legacy server settings', async t => {
  const f = await fixture({config:syntheticConfig,discovery:{app:'yt-down',integrated:true,unlocked:true,configured:true,tools_ready:true},url:'https://synthetic-host.example/'}); t.after(f.close);
  assert.equal(f.q('connection-text').textContent,'Download server built in');
  assert(f.q('connection-dot').classList.contains('ready'));
  const checked=f.calls.find(call=>call.url==='https://synthetic-host.example/api/check');
  assert(checked); assert.equal(checked.options.credentials,'same-origin');
  assert(!('Authorization' in checked.options.headers));
  assertSavedDataPreserved(f,syntheticConfig);
});

test('200 response without downloader confirmation never turns a saved server green', async t => {
  const f = await fixture({config:syntheticConfig,checkBody:{message:'Unrelated site'}}); t.after(f.close);
  assert(!f.q('connection-dot').classList.contains('ready'));
  await f.q('settings-open').onclick();
  assert.match(f.q('settings-status').textContent,/compatible download server/);
  assertSavedDataPreserved(f,syntheticConfig);
});


test('Save & connect rejects an unrelated 200 response without saving a replacement server', async t => {
  const f = await fixture({config:syntheticConfig,checkBody:{message:'Not a downloader'}}); t.after(f.close);
  await f.q('settings-open').onclick();
  f.q('server-url').value='https://new-synthetic.example'; f.q('server-key').value='synthetic-new-key';
  await f.q('settings-form').onsubmit({preventDefault(){}});
  assert(f.q('settings').open);
  assert(!f.q('connection-dot').classList.contains('ready'));
  assert.match(f.q('settings-status').textContent,/compatible download server/);
  assertSavedDataPreserved(f,syntheticConfig);
});

test('integrated unlock does not declare ready for an unrelated 200 check response', async t => {
  const f = await fixture({config:syntheticConfig,discovery:{app:'yt-down',integrated:true,unlocked:false,configured:true,tools_ready:true},checkBody:{message:'Not a downloader'},url:'https://synthetic-host.example/'}); t.after(f.close);
  await f.q('settings-open').onclick(); f.q('server-key').value='synthetic-unlock-key';
  await f.q('settings-form').onsubmit({preventDefault(){}});
  assert(f.q('settings').open);
  assert(!f.q('connection-dot').classList.contains('ready'));
  assert.match(f.q('settings-status').textContent,/compatible download server/);
  assert(f.calls.some(call=>call.url.endsWith('/api/session')));
  assertSavedDataPreserved(f,syntheticConfig);
});

test('unlocked integrated connection failures offer session retry rather than another unlock', async t => {
  const f = await fixture({config:syntheticConfig,discovery:{app:'yt-down',integrated:true,unlocked:true,configured:true,tools_ready:true},offline:true,url:'https://synthetic-host.example/'}); t.after(f.close);
  await f.q('settings-open').onclick();
  assert.match(f.q('settings-intro').textContent,/device is unlocked.*connection needs attention/);
  assert(!f.q('connect-button').hidden); assert(f.q('access-key-field').hidden);
  assert.equal(f.q('connect-button').textContent,'Retry connection');
  const previousChecks=f.calls.filter(call=>call.url.endsWith('/api/check')).length;
  await f.q('settings-form').onsubmit({preventDefault(){}});
  assert.equal(f.calls.filter(call=>call.url.endsWith('/api/check')).length,previousChecks+1);
  assert(!f.calls.some(call=>call.url.endsWith('/api/session')));
  assertSavedDataPreserved(f,syntheticConfig);
});


test('successful saved-server reconnection resumes its pending job without creating another job', async t => {
  const active={...syntheticActive,server:syntheticConfig.url};
  const f = await fixture({config:syntheticConfig,active,checkResponses:[{status:503,body:{detail:'Synthetic server waking up'}},{status:200,body:{ok:true}}]}); t.after(f.close);
  assert(!f.calls.some(call=>call.url.includes('/api/jobs')));
  await f.q('settings-open').onclick();
  await f.q('settings-form').onsubmit({preventDefault(){}});
  await new Promise(resolve=>setImmediate(resolve));
  const requests=f.calls.filter(call=>new URL(call.url).pathname.startsWith('/api/jobs'));
  assert.equal(requests.length,1); assert.equal(requests[0].url,syntheticConfig.url+'/api/jobs/'+active.id);
  assert.equal(requests[0].options.method,undefined);
  assert.equal(f.w.localStorage.getItem('yt-down.active'),JSON.stringify(active));
  assert(f.q('download').disabled);
});

test('successful integrated session retry resumes only the job from its own server', async t => {
  const origin='https://synthetic-host.example';
  const active={...syntheticActive,server:origin};
  const f = await fixture({config:syntheticConfig,active,discovery:{app:'yt-down',integrated:true,unlocked:true,configured:true,tools_ready:true},checkResponses:[{status:503,body:{detail:'Synthetic server waking up'}},{status:200,body:{ok:true}}],url:origin+'/'}); t.after(f.close);
  await f.q('settings-open').onclick();
  await f.q('settings-form').onsubmit({preventDefault(){}});
  await new Promise(resolve=>setImmediate(resolve));
  const requests=f.calls.filter(call=>new URL(call.url).pathname.startsWith('/api/jobs'));
  assert.equal(requests.length,1); assert.equal(requests[0].url,origin+'/api/jobs/'+active.id);
  assert.equal(requests[0].options.method,undefined);
  assert(!f.calls.some(call=>call.url.endsWith('/api/session')));
  assert.equal(f.w.localStorage.getItem('yt-down.active'),JSON.stringify(active));
});

test('successful integrated unlock resumes an existing matching job without posting a duplicate', async t => {
  const origin='https://synthetic-host.example';
  const active={...syntheticActive,server:origin};
  const f = await fixture({config:syntheticConfig,active,discovery:{app:'yt-down',integrated:true,unlocked:false,configured:true,tools_ready:true},url:origin+'/'}); t.after(f.close);
  await f.q('settings-open').onclick(); f.q('server-key').value='synthetic-unlock-key';
  await f.q('settings-form').onsubmit({preventDefault(){}});
  await new Promise(resolve=>setImmediate(resolve));
  const requests=f.calls.filter(call=>new URL(call.url).pathname.startsWith('/api/jobs'));
  assert.equal(requests.length,1); assert.equal(requests[0].url,origin+'/api/jobs/'+active.id);
  assert.equal(requests[0].options.method,undefined);
  assert.equal(f.w.localStorage.getItem('yt-down.active'),JSON.stringify(active));
});

test('successful reconnection never polls a pending job saved for a different server', async t => {
  const f = await fixture({config:syntheticConfig,checkResponses:[{status:503,body:{detail:'Synthetic server waking up'}},{status:200,body:{ok:true}}]}); t.after(f.close);
  await f.q('settings-open').onclick();
  await f.q('settings-form').onsubmit({preventDefault(){}});
  await new Promise(resolve=>setImmediate(resolve));
  assert(!f.calls.some(call=>new URL(call.url).pathname.startsWith('/api/jobs')));
  assertSavedDataPreserved(f,syntheticConfig);
});

test('start.py address unlocks a plain-HTTP home-network host from the #key fragment and removes the key from the address bar', async t => {
  const f = await fixture({discovery:{app:'yt-down',integrated:true,unlocked:false,configured:true,tools_ready:true},url:'http://192.168.1.20:8080/#key=synthetic-fragment-key-not-a-secret'}); t.after(f.close);
  const unlock=f.calls.find(call=>call.url==='http://192.168.1.20:8080/api/session');
  assert(unlock); assert.equal(JSON.parse(unlock.options.body).key,'synthetic-fragment-key-not-a-secret');
  assert.equal(f.w.location.hash,'');
  assert.equal(f.q('connection-text').textContent,'Download server built in');
  assert(f.q('connection-dot').classList.contains('ready'));
  assert(!f.w.localStorage.getItem('yt-down.config')?.includes('synthetic-fragment-key'));
});

test('a rejected #key leaves the device locked and explains why', async t => {
  const f = await fixture({discovery:{app:'yt-down',integrated:true,unlocked:false,configured:true,tools_ready:true},sessionStatus:401,url:'http://192.168.1.20:8080/#key=wrong'}); t.after(f.close);
  assert.equal(f.w.location.hash,'');
  assert.equal(f.q('connection-text').textContent,'Unlock this device to download');
  assert(!f.calls.some(call=>call.url.includes('/api/check')));
});
