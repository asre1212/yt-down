import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root = new URL('../', import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const paths = ['index.html','style.css','app.js','core.js','updates.js','manifest.webmanifest','icon.svg','icons/icon-192.png','icons/icon-512.png','icons/apple-touch-icon.png'];
const assets = await Promise.all(paths.map(async path => ['./' + path, hash(await readFile(new URL('docs/' + path, root)))]));
const template = await readFile(new URL('scripts/sw.template.js', root), 'utf8');
const build = hash(JSON.stringify(assets) + template).slice(0, 16);
const output = template.replace('__BUILD__', build).replace('__ASSETS__', JSON.stringify(assets));
const target = new URL('docs/sw.js', root);
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8') !== output) throw new Error('Run npm run build and commit docs/sw.js with the changed app files.');
} else await writeFile(target, output);
console.log(`PWA release ${build} ${process.argv.includes('--check') ? 'verified' : 'built'}`);
