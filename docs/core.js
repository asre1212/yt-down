export const VERSION = '1.2.0';
const ID = /^[A-Za-z0-9_-]{11}$/;
export function youtubeURL(input) {
  const match = String(input).trim().match(/(?:^|\s)((?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\/[^\s<>]+)/i);
  let text = match ? match[1] : String(input).trim();
  if (!/^https?:\/\//i.test(text)) text = 'https://' + text;
  let url; try { url = new URL(text); } catch { throw new Error('Paste a valid YouTube video link.'); }
  const host = url.hostname.toLowerCase();
  if (!['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com','youtu.be','www.youtu.be'].includes(host) || url.username || url.password || url.port) throw new Error('Use a youtube.com or youtu.be video link.');
  const parts = url.pathname.split('/').filter(Boolean);
  const id = host.endsWith('youtu.be') ? parts[0] : parts[0] === 'watch' ? url.searchParams.get('v') : ['shorts','live','embed'].includes(parts[0]) ? parts[1] : null;
  if (!ID.test(id || '')) throw new Error('Use a single video link, including Shorts. Playlists are not supported.');
  return `https://www.youtube.com/watch?v=${id}`;
}
export function serverURL(value) {
  let parsed; try { parsed = new URL(value); } catch { throw new Error('Enter the full https:// download server address.'); }
  const local = ['localhost','127.0.0.1','[::1]'].includes(parsed.hostname);
  if ((parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) || parsed.username || parsed.password || parsed.search || parsed.hash || !['','/'].includes(parsed.pathname)) throw new Error('Use an HTTPS server address without a path or sign-in details.');
  return parsed.origin;
}
export function readStore(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
export function writeStore(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } }
