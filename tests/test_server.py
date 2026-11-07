import asyncio
import importlib
import json
import os
import shutil
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

os.environ['API_KEY'] = 'test-key-only-not-a-real-secret-12345'
os.environ['DOWNLOAD_DIR'] = tempfile.mkdtemp(prefix='yt-down-test-')
server = importlib.import_module('server.app')
from fastapi.testclient import TestClient

AUTH = {'Authorization': 'Bearer ' + os.environ['API_KEY']}
LINK = 'https://www.youtube.com/watch?v=nQlCeT4oDAw'


class DownloadTests(unittest.TestCase):
    def setUp(self):
        server.JOBS.clear()
        server.LOGIN_ATTEMPTS.clear()
        self.context = TestClient(server.app, base_url='https://testserver')
        self.client = self.context.__enter__()

    def tearDown(self):
        self.context.__exit__(None, None, None)
        server.JOBS.clear()

    def wait_for(self, job_id, terminal=('ready','error','cancelled')):
        for _ in range(100):
            data = self.client.get('/api/jobs/' + job_id, headers=AUTH).json()
            if data['state'] in terminal:
                return data
            time.sleep(.01)
        self.fail('Job never completed')

    def test_auth_missing_key_and_origin(self):
        self.assertEqual(self.client.get('/api/check').status_code, 401)
        with patch.object(server, 'API_KEY', ''):
            self.assertEqual(self.client.post('/api/jobs', json={'url':LINK}).status_code, 503)
        good = self.client.options('/api/jobs', headers={'Origin':'https://asre1212.github.io','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type'})
        self.assertEqual(good.status_code, 200)
        bad = self.client.options('/api/jobs', headers={'Origin':'https://evil.test','Access-Control-Request-Method':'POST'})
        self.assertNotIn('access-control-allow-origin', bad.headers)

    def test_url_validation(self):
        for url in ['https://127.0.0.1/x','file:///etc/passwd','https://youtube.com.evil.test/watch?v=nQlCeT4oDAw','https://www.youtube.com/playlist?list=abc','https://youtube.com@localhost/watch?v=nQlCeT4oDAw']:
            self.assertEqual(self.client.post('/api/jobs', json={'url':url}, headers=AUTH).status_code, 422)
        self.assertEqual(self.client.post('/api/jobs', json={'url':LINK,'quality':999}, headers=AUTH).status_code, 422)

    def test_integrated_discovery_unlock_cookie_and_lock(self):
        config = self.client.get('/api/config').json()
        self.assertTrue(config['integrated'])
        self.assertFalse(config['unlocked'])
        self.assertNotIn(os.environ['API_KEY'], json.dumps(config))
        self.assertEqual(self.client.post('/api/session', json={'key':'wrong'}).status_code, 401)
        response = self.client.post('/api/session', json={'key':os.environ['API_KEY']}, headers={'Origin':'https://testserver'})
        self.assertEqual(response.status_code, 200)
        cookie = response.headers['set-cookie']
        for flag in ['HttpOnly','Secure','SameSite=strict','Path=/']:
            self.assertIn(flag, cookie)
        self.assertNotIn(os.environ['API_KEY'], cookie)
        self.assertTrue(self.client.get('/api/config').json()['unlocked'])
        with patch.object(server, 'tools_ready', return_value=True):
            self.assertEqual(self.client.get('/api/check').status_code, 200)
        self.assertEqual(self.client.delete('/api/session').status_code, 200)
        self.assertFalse(self.client.get('/api/config').json()['unlocked'])
        self.assertEqual(self.client.get('/api/check').status_code, 401)

    def test_session_expiry_tamper_origin_and_rate_limit(self):
        result = self.client.post('/api/session', json={'key':os.environ['API_KEY']}, headers={'Origin':'https://evil.test'})
        self.assertEqual(result.status_code, 403)
        self.client.post('/api/session', json={'key':os.environ['API_KEY']})
        token = self.client.cookies.get(server.SESSION_COOKIE)
        self.assertTrue(server.session_valid(token))
        self.assertFalse(server.session_valid(token + 'wrong'))
        future = time.time() + server.SESSION_TTL + 1
        with patch.object(server.time, 'time', return_value=future):
            self.assertFalse(server.session_valid(token))
        self.assertEqual(self.client.get('/api/check', headers={'Origin':'https://evil.test'}).status_code, 403)
        for _ in range(12):
            self.assertEqual(self.client.post('/api/session', json={'key':'wrong'}).status_code, 401)
        self.assertEqual(self.client.post('/api/session', json={'key':'wrong'}).status_code, 429)

    def test_full_job_to_file_with_ranges_and_expiry(self):
        async def fake_command(job, args, timeout, progress=False):
            if '--dump-single-json' in args:
                return json.dumps({'title':'My / sample video','duration':12})
            self.assertIn('--no-playlist', args)
            self.assertIn('--max-filesize', args)
            (server.DATA / job['id'] / 'video.mp4').write_bytes(b'0123456789')
            return ''
        with patch.object(server, 'tools_ready', return_value=True), patch.object(server, 'command', fake_command), patch.object(server, 'inspect_file', AsyncMock()):
            response = self.client.post('/api/jobs', json={'url':LINK}, headers=AUTH)
            self.assertEqual(response.status_code, 202)
            job_id = response.json()['id']
            data = self.wait_for(job_id)
            self.assertEqual(data['state'], 'ready')
            self.assertNotIn('token', data)
            file = self.client.get(data['download_url'])
            self.assertEqual(file.content, b'0123456789')
            self.assertEqual(file.headers['cache-control'], 'no-store')
            self.assertIn('attachment', file.headers['content-disposition'])
            partial = self.client.get(data['download_url'], headers={'Range':'bytes=2-5'})
            self.assertEqual(partial.status_code, 206)
            self.assertEqual(partial.content, b'2345')
            self.assertEqual(self.client.get('/api/files/' + job_id + '/invalid').status_code, 404)
            server.JOBS[job_id]['finished'] = time.time() - server.TTL - 1
            self.assertEqual(self.client.get(data['download_url']).status_code, 404)

    def test_blocked_video_is_clear_error_without_exposing_diagnostics(self):
        async def blocked(*args, **kwargs):
            raise RuntimeError('Sign in to confirm you are not a bot. secret-url-in-log')
        with patch.object(server, 'tools_ready', return_value=True), patch.object(server, 'command', blocked):
            result = self.client.post('/api/jobs', json={'url':LINK}, headers=AUTH).json()
            data = self.wait_for(result['id'])
            self.assertEqual(data['state'], 'error')
            self.assertIn('YouTube blocked', data['error'])
            self.assertNotIn('secret-url', data['error'])
            self.assertFalse((server.DATA / result['id']).exists())

    def test_cancellation_and_expired_job(self):
        async def slow(job, *args, **kwargs):
            while not job.get('cancel'):
                await asyncio.sleep(.01)
            raise asyncio.CancelledError()
        with patch.object(server, 'tools_ready', return_value=True), patch.object(server, 'command', slow):
            job = self.client.post('/api/jobs', json={'url':LINK}, headers=AUTH).json()
            self.assertEqual(self.client.delete('/api/jobs/' + job['id'], headers=AUTH).status_code, 200)
            self.assertEqual(self.wait_for(job['id'])['state'], 'cancelled')
        self.assertEqual(self.client.get('/api/jobs/missing', headers=AUTH).json()['state'], 'expired')

    def test_static_manifest_and_no_repo_source_exposure(self):
        self.assertEqual(self.client.get('/').status_code, 200)
        self.assertEqual(self.client.get('/manifest.webmanifest').json()['display'], 'standalone')
        self.assertEqual(self.client.get('/server/app.py').status_code, 404)
        self.assertEqual(self.client.get('/.env').status_code, 404)

    @unittest.skipUnless(shutil.which('ffprobe'), 'FFprobe not installed')
    def test_html_error_page_is_not_accepted_as_video(self):
        path = server.DATA / 'not-a-video.mp4'
        path.write_text('<html>Site Unavailable</html>')
        try:
            with self.assertRaisesRegex(RuntimeError, 'Invalid media file'):
                asyncio.run(server.inspect_file(path))
        finally:
            path.unlink(missing_ok=True)


if __name__ == '__main__':
    unittest.main()
