import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
const source = await readFile(new URL('../docs/sw.js', import.meta.url), 'utf8');
async function fixture(corrupt = false) {
  const events = {}, stores = new Map([['yt-down-shell-old',new Map([['old','working']])], ['other-app',new Map()]]);
  let claims = 0;
  const scope = 'https://example.com/yt-down/';
  const cache = name => { if (!stores.has(name)) stores.set(name, new Map()); const map = stores.get(name); return {put:async (key,value)=>map.set(key,value), match:async key=>map.get(typeof key === 'string' ? key : key.url)}; };
  const context = {URL,Promise,Uint8Array,crypto:webcrypto,
    self:{registration:{scope},addEventListener:(name,handler)=>events[name]=handler,clients:{claim:async ()=>claims++}},
    caches:{open:async name=>cache(name),keys:async ()=>[...stores.keys()],delete:async name=>stores.delete(name)},
    fetch:async url=>new Response(corrupt && url.endsWith('/core.js') ? 'mixed version' : await readFile(new URL('../docs/'+url.slice(scope.length), import.meta.url)))};
  vm.runInNewContext(source, context);
  const run = async name => { let work; events[name]({waitUntil:p=>work=p}); await work; };
  return {stores,run,get claims(){return claims;}};
}
test('a mixed or incomplete deployment keeps the old offline shell intact', async () => {
  const f = await fixture(true); await assert.rejects(f.run('install'), /still deploying/);
  assert.deepEqual([...f.stores.keys()], ['yt-down-shell-old','other-app']);
  assert.equal(f.claims, 0);
});
test('a complete release caches verified assets and only removes this app’s old cache', async () => {
  const f = await fixture(); await f.run('install'); assert.equal(f.stores.size, 3);
  await f.run('activate'); assert.equal(f.stores.size, 2); assert.ok(f.stores.has('other-app'));
  assert.equal(f.claims, 1);
  const shell = [...f.stores.entries()].find(([name])=>name.startsWith('yt-down-shell-'))[1];
  assert.ok(shell.has('https://example.com/yt-down/updates.js'));
  assert.ok(![...shell.keys()].some(url=>url.includes('/api/')));
});
