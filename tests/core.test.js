import test from 'node:test';
import assert from 'node:assert/strict';
import {youtubeURL, serverURL} from '../docs/core.js';
const expected = 'https://www.youtube.com/watch?v=nQlCeT4oDAw';
test('normalizes mobile, Shorts, watch and shared links without tracking or playlist parameters', () => {
  for (const link of ['https://youtu.be/nQlCeT4oDAw?si=test','youtube.com/watch?v=nQlCeT4oDAw&list=unwanted','https://m.youtube.com/shorts/nQlCeT4oDAw','https://www.youtube.com/live/nQlCeT4oDAw','A video https://youtu.be/nQlCeT4oDAw']) assert.equal(youtubeURL(link), expected);
});
test('rejects unrelated domains, unsafe schemes, credentials, malformed IDs and playlist-only links', () => {
  for (const link of ['https://youtube.com.evil.test/watch?v=nQlCeT4oDAw','https://evilyoutube.com/watch?v=nQlCeT4oDAw','https://youtube.com@evil.test/watch?v=nQlCeT4oDAw','https://127.0.0.1/watch?v=nQlCeT4oDAw','javascript:alert(1)','https://youtube.com/playlist?list=abc','https://youtube.com/watch?v=short','https://user@youtube.com/watch?v=nQlCeT4oDAw']) assert.throws(() => youtubeURL(link),undefined,link);
});
test('requires HTTPS, permits localhost development and rejects credentials and query tokens', () => {
  assert.equal(serverURL('https://example.com/'),'https://example.com');
  assert.equal(serverURL('http://localhost:8080'),'http://localhost:8080');
  for (const value of ['http://example.com','https://user:pass@example.com','https://example.com/path','https://example.com?key=secret','javascript:test','']) assert.throws(() => serverURL(value));
});
