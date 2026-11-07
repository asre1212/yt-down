import {VERSION, youtubeURL, serverURL, readStore, writeStore} from './core.js';
import {AppUpdates} from './updates.js';
const $ = id => document.getElementById(id);
let config = readStore('yt-down.config', {});
let history = readStore('yt-down.history', []);
if (!Array.isArray(history)) history = [];
if (!config || typeof config !== 'object') config = {};
let active = readStore('yt-down.active', null);
let busy = false, polling = false, pollTimer, updates, bootComplete = false, readyJob = null, savingFile = false;
let resumeState = null;
try { resumeState = JSON.parse(sessionStorage.getItem('yt-down.update-state')); sessionStorage.removeItem('yt-down.update-state'); } catch {}
if (resumeState && typeof resumeState.url === 'string') $('video-url').value = resumeState.url;
if ([360,480,720,1080].includes(Number(resumeState?.quality))) $('quality').value = resumeState.quality;
if (!active && resumeState?.ready?.id) active = resumeState.ready;
function saveUpdateState() {
  try { sessionStorage.setItem('yt-down.update-state', JSON.stringify({url:$('video-url').value,quality:$('quality').value,ready:readyJob})); return true; }
  catch { return !$('video-url').value && !readyJob; }
}
function resumeUpdates() { setTimeout(() => updates?.resume(), 0); }
let integrated = false, unlocked = false;
const params = new URLSearchParams(location.search);
const shared = params.get('url') || params.get('text');
if (shared) { try { $('video-url').value = youtubeURL(shared); } catch {} window.history.replaceState({}, '', location.pathname); }
$('version').textContent = VERSION;
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, 4200); }
function setConnection(text, kind = '') { $('connection-text').textContent = text; $('connection-dot').className = 'connection-dot ' + kind; }
function panel(title, detail, state = 'working') {
  $('job-panel').hidden = false; $('job-title').textContent = title; $('job-detail').textContent = detail;
  $('status-dot').style.background = state === 'error' ? '#d75a41' : '#829466';
  $('save-file').hidden = state !== 'ready'; $('save-help').hidden = state !== 'ready';
  $('cancel').hidden = state !== 'working' || !active; $('check-again').hidden = state !== 'paused' || !active;
  $('progress').hidden = !['working', 'paused'].includes(state);
  $('progress').removeAttribute('value');
}
function setBusy(value) { busy = value; $('download').disabled = value; $('download').querySelector('span').textContent = value ? 'Preparing your video…' : 'Prepare download'; $('quality').disabled = value; $('video-url').readOnly = value; resumeUpdates(); }
async function openSettings() {
  await boot;
  $('server-address').hidden = integrated;
  $('setup-help').hidden = integrated;
  $('access-key-field').hidden = integrated && unlocked;
  $('connect-button').hidden = integrated && unlocked;
  $('lock-app').hidden = !integrated || !unlocked;
  $('settings-intro').textContent = integrated ? (unlocked ? 'Your download server is built in and ready.' : 'Your download server is built in. Unlock this device once.') : 'Connect once. Then just paste and save.';
  $('key-help').textContent = integrated ? 'Your key is exchanged for a secure device session. It is not saved in browser storage.' : 'Saved only in this browser on this device. Never added to GitHub.';
  $('connect-button').textContent = integrated ? 'Unlock app' : 'Save & connect';
  $('server-url').value = config.url || (location.hostname.endsWith('.github.io') ? '' : location.origin);
  $('server-key').value = config.key || ''; $('settings-status').textContent = '';
  $('settings').showModal();
}
$('settings-open').onclick = openSettings; $('connection').onclick = openSettings;
$('settings-close').onclick = () => $('settings').close();
$('settings').addEventListener('close', resumeUpdates);
document.addEventListener('focusout', resumeUpdates);
async function api(path, options = {}, chosen = config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 65000);
  try {
    const response = await fetch(chosen.url + path, {...options, headers:{...(chosen.mode === 'session' ? {} : {'Authorization':`Bearer ${chosen.key}`}), ...(options.body ? {'Content-Type':'application/json'} : {}), ...options.headers}, signal:controller.signal, cache:'no-store', credentials:chosen.mode === 'session' ? 'same-origin' : 'omit', redirect:'error'});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { if (response.status === 401 && integrated) { unlocked = false; setConnection('Unlock this device to download'); } throw new Error(typeof data.detail === 'string' ? data.detail : `Server error (${response.status}). Try again.`); }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('The server is taking too long to respond. Try again in a moment.');
    if (e instanceof TypeError) throw new Error('Cannot reach the download server. Check its address or wait for it to wake up.');
    throw e;
  } finally { clearTimeout(timeout); }
}
$('settings-form').onsubmit = async event => {
  event.preventDefault();
  await boot;
  if (busy) { $('settings-status').textContent = 'Cancel the current download before changing servers.'; return; }
  const key = $('server-key').value.trim();
  if (integrated) {
    if (!key) { $('settings-status').textContent = 'Enter your private access key.'; return; }
    $('connect-button').disabled = true;
    try {
      await api('/api/session', {method:'POST', body:JSON.stringify({key})});
      await api('/api/check'); unlocked = true;
      $('server-key').value = ''; $('settings').close(); setConnection('Download server built in', 'ready'); toast('Unlocked. Paste a link to download.');
    } catch (e) { $('settings-status').textContent = e.message; }
    finally { $('connect-button').disabled = false; }
    return;
  }
  let chosen; try { chosen = {url:serverURL($('server-url').value.trim()), key}; if (!key) throw new Error('Enter your server access key.'); } catch (e) { $('settings-status').textContent = e.message; return; }
  $('connect-button').disabled = true; $('settings-status').textContent = 'Connecting… A sleeping server may take a minute.';
  try {
    await api('/api/check', {}, chosen); config = chosen;
    if (!writeStore('yt-down.config', config)) toast('Connected for this session. This browser cannot save settings.');
    setConnection('Download server connected', 'ready'); $('settings').close(); toast('Connected. Ready to download.');
  } catch (e) { $('settings-status').textContent = e.message; setConnection('Server needs attention', 'error'); }
  finally { $('connect-button').disabled = false; }
};
$('lock-app').onclick = async () => {
  if (busy) return toast('Finish or cancel the current download first.');
  try { await api('/api/session', {method:'DELETE'}); unlocked = false; $('settings').close(); setConnection('Unlock this device to download'); toast('This device is locked.'); }
  catch (e) { toast(e.message); }
};
$('paste').onclick = async () => { try { $('video-url').value = await navigator.clipboard.readText(); $('video-url').focus(); } catch { $('video-url').focus(); toast('Touch and hold the link field, then tap Paste.'); } };
function clearActive() { active = null; writeStore('yt-down.active', null); clearTimeout(pollTimer); }
function addHistory(job) {
  history = [{url:active.url,title:job.title || 'YouTube video',at:Date.now(),quality:active.quality}, ...history.filter(item => item.url !== active.url)].slice(0,8);
  writeStore('yt-down.history', history); renderHistory();
}
function renderHistory() {
  $('history').replaceChildren(); $('recent-section').hidden = !history.length;
  for (const item of history) {
    const li = document.createElement('li'); const button = document.createElement('button'); button.className = 'history-link';
    button.innerHTML = '<span class="history-play"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7Z"/></svg></span><span class="history-info"><strong></strong><small></small></span><span class="history-arrow" aria-hidden="true">↗</span>';
    button.querySelector('strong').textContent = item.title; button.querySelector('small').textContent = `${item.quality}p · ${new Date(item.at).toLocaleDateString(undefined,{month:'short',day:'numeric'})}`;
    button.onclick = () => { if (busy) return toast('Finish or cancel the current download first.'); $('video-url').value = item.url; $('quality').value = item.quality; $('video-url').focus(); window.scrollTo({top:0,behavior:'smooth'}); };
    li.append(button); $('history').append(li);
  }
}
$('clear-history').onclick = () => { history = []; writeStore('yt-down.history', []); renderHistory(); };
async function poll() {
  if (!active || polling) return;
  polling = true;
  const id = active.id;
  try {
    const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
    if (!active || active.id !== id) return;
    if (job.state === 'ready') {
      const link = new URL(job.download_url, config.url);
      if (link.origin !== new URL(config.url).origin || !link.pathname.startsWith('/api/files/')) throw new Error('The server returned an invalid download address.');
      const size = Math.round(job.size / 1024 / 1024);
      panel(job.title || 'Your video is ready', `${size} MB · MP4 with sound. Tap below to save.`, 'ready');
      $('save-file').href = link.href; $('save-file').download = job.filename || 'video.mp4';
      readyJob = {...active}; addHistory(job); clearActive(); setBusy(false); return;
    }
    if (['error','cancelled','expired'].includes(job.state)) { panel('Couldn’t prepare this video', job.error || 'This download is no longer available. Please try again.', 'error'); clearActive(); setBusy(false); return; }
    panel(job.title || 'Preparing your video', job.message || 'Getting the video ready. Keep this app open.');
    if (Number.isFinite(job.progress)) $('progress').value = job.progress;
    pollTimer = setTimeout(poll, 1600);
  } catch (e) {
    if (active && active.id === id) { panel('Connection interrupted', e.message + ' Your download may still be running.', 'paused'); pollTimer = setTimeout(poll, 8000); }
  } finally { polling = false; }
}
$('download-form').onsubmit = async event => {
  event.preventDefault(); if (busy) return;
  await boot;
  let url; try { url = youtubeURL($('video-url').value); } catch (e) { panel('Check your link', e.message, 'error'); return; }
  if (!navigator.onLine) return panel('You’re offline', 'Reconnect to prepare this download.', 'error');
  if (!config.url || (integrated ? !unlocked : !config.key)) { $('job-panel').hidden = true; await openSettings(); $('settings-status').textContent = integrated ? 'Unlock this device to download.' : 'Hosting has not been connected yet.'; return; }
  readyJob = null; savingFile = false; setBusy(true); panel('Preparing your video', 'Connecting to your server… This can take a minute if it is asleep.');
  const quality = Number($('quality').value);
  try {
    const job = await api('/api/jobs', {method:'POST',body:JSON.stringify({url,quality})});
    active = {id:job.id,url,quality,server:config.url}; writeStore('yt-down.active', active); await poll();
  } catch (e) { panel('Couldn’t start the download', e.message, 'error'); setBusy(false); }
};
$('cancel').onclick = async () => {
  if (!active) return;
  $('cancel').disabled = true;
  try { await api(`/api/jobs/${encodeURIComponent(active.id)}`, {method:'DELETE'}); clearActive(); setBusy(false); panel('Download cancelled', 'Paste another link whenever you’re ready.', 'cancelled'); }
  catch (e) { toast(e.message); } finally { $('cancel').disabled = false; }
};
$('check-again').onclick = () => { clearTimeout(pollTimer); poll(); };
function connectivity() { $('offline').hidden = navigator.onLine; if (navigator.onLine && active) { clearTimeout(pollTimer); poll(); } }
window.addEventListener('online', connectivity); window.addEventListener('offline', connectivity);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (active) { clearTimeout(pollTimer); poll(); }
  updates?.resume(); updates?.check();
});
window.addEventListener('online', () => { updates?.resume(); updates?.check(); });
$('save-file').onclick = () => { savingFile = true; toast('Your browser will open the download. Choose Save to Files.'); };
$('update').onclick = () => updates ? updates.check(true) : toast('Updates require a secure connection. Reopen the app online.');
if ('serviceWorker' in navigator) {
  updates = new AppUpdates({
    serviceWorker:navigator.serviceWorker,
    isSafe:() => bootComplete && !busy && !savingFile && !$('settings').open && !document.hidden && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName),
    beforeReload:saveUpdateState, reload:() => location.reload(), notify:toast
  });
  updates.start().catch(() => {});
  setInterval(() => { if (!document.hidden && navigator.onLine) { updates.resume(); updates.check(); } }, 15 * 60 * 1000);
}
async function discover() {
  // Only trust the current app's same-origin configuration; never send a key during discovery.
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(new URL('./api/config', location.href), {cache:'no-store', credentials:'same-origin', signal:controller.signal});
    const data = response.ok ? await response.json() : null;
    if (data?.app === 'yt-down' && data.integrated === true) {
      integrated = true; unlocked = data.unlocked === true;
      config = {url:location.origin,mode:'session'}; writeStore('yt-down.config', config);
      setConnection(unlocked ? 'Download server built in' : 'Unlock this device to download', unlocked ? 'ready' : '');
      if (!data.configured || !data.tools_ready) setConnection('Download service is being configured');
    }
  } catch {} finally { clearTimeout(timeout); }
  if (!integrated) {
    try {
      const response = await fetch('./deployment.json', {cache:'no-store',signal:AbortSignal.timeout(4000)});
      const deployment = response.ok ? await response.json() : null;
      if (deployment?.app_url) {
        const url = new URL(serverURL(deployment.app_url));
        if (url.origin !== location.origin) {
          if ($('video-url').value) url.searchParams.set('url', $('video-url').value);
          location.replace(url.href); return;
        }
      }
    } catch {}
    if (config.url && config.key) setConnection('Download server saved', 'ready');
    else setConnection('Download hosting is not connected yet');
  }
  if (config.url && (unlocked || config.key)) {
    if (active?.id && active.server === config.url) { setBusy(true); poll(); }
    else clearActive();
  }
}
const boot = discover().finally(() => { bootComplete = true; resumeUpdates(); });
renderHistory(); $('offline').hidden = navigator.onLine;
