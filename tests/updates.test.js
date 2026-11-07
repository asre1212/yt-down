import test from 'node:test';
import assert from 'node:assert/strict';
import {AppUpdates} from '../docs/updates.js';
const emit = (target, name) => target.dispatchEvent(new Event(name));
function fixture(controlled = true) {
  const sw = new EventTarget(); sw.controller = controlled ? {} : null;
  const reg = new EventTarget(); reg.waiting = null; reg.installing = null;
  reg.update = async () => reg; sw.register = async () => reg;
  let safe = true, saved = true, reloads = 0, snapshots = 0;
  const messages = [];
  const updates = new AppUpdates({serviceWorker:sw, isSafe:() => safe,
    beforeReload:() => { snapshots++; return saved; }, reload:() => reloads++, notify:m => messages.push(m)});
  const worker = () => { const w = new EventTarget(); w.state = 'installed'; w.messages = []; w.postMessage = m => w.messages.push(m); return w; };
  return {sw,reg,updates,messages,worker,setSafe:v=>safe=v,setSaved:v=>saved=v,get reloads(){return reloads;},get snapshots(){return snapshots;}};
}
test('waiting update activates automatically after a download finishes, then snapshots once before reload', async () => {
  const f = fixture(); f.reg.waiting = f.worker(); f.setSafe(false); await f.updates.start();
  assert.deepEqual(f.reg.waiting.messages, []);
  f.setSafe(true); f.updates.resume(); f.updates.resume();
  assert.deepEqual(f.reg.waiting.messages, ['SKIP_WAITING']);
  emit(f.sw, 'controllerchange'); emit(f.sw, 'controllerchange');
  assert.equal(f.snapshots, 1); assert.equal(f.reloads, 1);
});
test('first installation claims a tab without reloading it', async () => {
  const f = fixture(false); await f.updates.start(); f.sw.controller = {};
  emit(f.sw, 'controllerchange'); assert.equal(f.reloads, 0);
  emit(f.sw, 'controllerchange'); assert.equal(f.reloads, 1);
});
test('activation by another tab cannot interrupt this tab while downloading or saving', async () => {
  const f = fixture(); await f.updates.start(); f.setSafe(false);
  emit(f.sw, 'controllerchange'); assert.equal(f.reloads, 0);
  f.setSafe(true); f.updates.resume(); assert.equal(f.reloads, 1);
});
test('cannot reload if a draft or prepared result cannot be preserved', async () => {
  const f = fixture(); await f.updates.start(); f.setSaved(false);
  emit(f.sw, 'controllerchange'); assert.equal(f.reloads, 0);
  f.setSaved(true); f.updates.resume(); assert.equal(f.reloads, 1);
});
test('manual check distinguishes installing, pending and offline states', async () => {
  const f = fixture(); await f.updates.start(); f.setSafe(false);
  f.reg.installing = f.worker(); await f.updates.check(true);
  assert.match(f.messages.at(-1), /Downloading/);
  f.reg.installing = null; f.reg.waiting = f.worker(); await f.updates.check(true);
  assert.match(f.messages.at(-1), /Update ready/);
  f.reg.update = async () => { throw new Error('offline'); }; await f.updates.check(true);
  assert.match(f.messages.at(-1), /installed version is still available/);
  assert.equal(f.reloads, 0);
});
test('update discovered while open automatically activates without another manual check', async () => {
  const f = fixture(); await f.updates.start(); const w = f.worker();
  f.reg.installing = w; emit(f.reg, 'updatefound');
  f.reg.installing = null; f.reg.waiting = w; emit(w, 'statechange');
  assert.deepEqual(w.messages, ['SKIP_WAITING']);
});
