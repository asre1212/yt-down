import {VERSION, youtubeURL, serverURL, readStore, writeStore} from './core.js';
const $ = id => document.getElementById(id);
let config = readStore('yt-down.config', {});
let history = readStore('yt-down.history', []);
if (!Array.isArray(history)) history = [];
if (!config || typeof config !== 'object') config = {};
let active = readStore('yt-down.active', null);
let busy = false, polling = false, pollTimer, registration, updatePending = false;
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
function setBusy(value) { busy = value; $('download').disabled = value; $('download').querySelector('span').textContent = value ? 'Preparing your video…' : 'Prepare download'; $('quality').disabled = value; $('video-url').readOnly = value; }
function openSettings() {
  $('server-url').value = config.url || (location.hostname.endsWith('.github.io') ? '' : location.origin);
  $('server-key').value = config.key || ''; $('settings-status').textContent = '';
  $('settings').showModal();
}
$('settings-open').onclick = openSettings; $('connection').onclick = openSettings;
$('settings-close').onclick = () => $('settings').close();
async function api(path, options = {}, chosen = config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 65000);
  try {
    const response = await fetch(chosen.url + path, {...options, headers:{'Authorization':`Bearer ${chosen.key}`, ...(options.body ? {'Content-Type':'application/json'} : {}), ...options.headers}, signal:controller.signal, cache:'no-store', credentials:'omit', redirect:'error'});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `Server error (${response.status}). Try again.`);
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('The server is taking too long to respond. Try again in a moment.');
    if (e instanceof TypeError) throw new Error('Cannot reach the download server. Check its address or wait for it to wake up.');
    throw e;
  } finally { clearTimeout(timeout); }
}
$('settings-form').onsubmit = async event => {
  event.preventDefault();
  if (busy) { $('settings-status').textContent = 'Cancel the current download before changing servers.'; return; }
  const key = $('server-key').value.trim();
  let chosen; try { chosen = {url:serverURL($('server-url').value.trim()), key}; if (!key) throw new Error('Enter your server access key.'); } catch (e) { $('settings-status').textContent = e.message; return; }
  $('connect-button').disabled = true; $('settings-status').textContent = 'Connecting… A sleeping server may take a minute.';
  try {
    await api('/api/check', {}, chosen); config = chosen;
    if (!writeStore('yt-down.config', config)) toast('Connected for this session. This browser cannot save settings.');
    setConnection('Download server connected', 'ready'); $('settings').close(); toast('Connected. Ready to download.');
  } catch (e) { $('settings-status').textContent = e.message; setConnection('Server needs attention', 'error'); }
  finally { $('connect-button').disabled = false; }
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
      addHistory(job); clearActive(); setBusy(false); return;
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
  let url; try { url = youtubeURL($('video-url').value); } catch (e) { panel('Check your link', e.message, 'error'); return; }
  if (!navigator.onLine) return panel('You’re offline', 'Reconnect to prepare this download.', 'error');
  if (!config.url || !config.key) { $('job-panel').hidden = true; openSettings(); $('settings-status').textContent = 'Connect your server once to enable downloads.'; return; }
  setBusy(true); panel('Preparing your video', 'Connecting to your server… This can take a minute if it is asleep.');
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
document.addEventListener('visibilitychange', () => { if (!document.hidden && active) { clearTimeout(pollTimer); poll(); } if (!document.hidden) registration?.update().catch(() => {}); });
$('save-file').onclick = () => toast('Your browser will open the download. Choose Save to Files.');
$('update').onclick = async () => {
  if (busy) return toast('Finish this download before updating.');
  if (!registration) return toast('Updates require a secure connection. Reopen the app online.');
  try { await registration.update(); if (registration.waiting) registration.waiting.postMessage('SKIP_WAITING'); else if (updatePending) location.reload(); else toast('You have the latest installed version.'); } catch { toast('Could not check for updates. Try again online.'); }
};
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js', {scope:'./', updateViaCache:'none'}).then(reg => { registration = reg; reg.update().catch(() => {}); if (reg.waiting && !busy) reg.waiting.postMessage('SKIP_WAITING'); reg.addEventListener('updatefound', () => { const worker = reg.installing; worker?.addEventListener('statechange', () => { if (worker.state === 'installed' && navigator.serviceWorker.controller) { if (!busy) worker.postMessage('SKIP_WAITING'); else toast('An app update is ready after this download.'); } }); }); }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (busy) { updatePending = true; return; } if (navigator.serviceWorker.controller) location.reload(); });
}
renderHistory(); connectivity();
if (config.url && config.key) { setConnection('Download server saved', 'ready'); if (active?.id && active.server === config.url) { setBusy(true); poll(); } else { clearActive(); } }
