#!/usr/bin/env python3
"""Opt-in live acceptance test. Never run this as a mocked CI download test."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Do not forward bearer credentials to redirects or follow file-token URLs off-host.
        return None


def server_origin(value):
    parsed = urlsplit(value)
    local = parsed.hostname in {'localhost', '127.0.0.1', '::1'}
    if (not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path not in {'', '/'} or parsed.scheme not in {'https', 'http'}
            or (parsed.scheme == 'http' and not local)):
        raise ValueError('Use an HTTPS server origin, or HTTP localhost for development.')
    return value.rstrip('/')


def verify(server, video, quality, output, key, timeout=1300):
    if len(key) < 24:
        raise ValueError('Set YT_DOWN_API_KEY to the private server key; do not pass it in a URL or command argument.')
    if not shutil.which('ffprobe'):
        raise ValueError('Install FFmpeg/ffprobe before verifying a real download.')
    origin = server_origin(server)
    output = Path(output)
    if output.exists():
        raise ValueError('The output path already exists. Choose a new path to preserve existing files.')
    opener = build_opener(NoRedirect())

    def api(path, body=None):
        headers = {'Authorization': 'Bearer ' + key, 'Accept': 'application/json'}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers['Content-Type'] = 'application/json'
        try:
            with opener.open(Request(origin + path, data=data, headers=headers), timeout=70) as response:
                return json.load(response)
        except HTTPError as exc:
            # Never print request headers, bearer keys, file tokens, or untrusted response bodies.
            raise RuntimeError(f'Download service returned HTTP {exc.code}. Check server configuration/access.') from None
        except URLError:
            raise RuntimeError('Cannot reach the download service.') from None

    health = api('/api/health')
    if not health.get('configured') or not health.get('tools_ready'):
        raise RuntimeError('The server is missing its private key or FFmpeg/Deno tools.')
    api('/api/check')
    job = api('/api/jobs', {'url': video, 'quality': quality})
    job_id = job.get('id', '')
    if len(job_id) != 32 or any(c not in '0123456789abcdef' for c in job_id):
        raise RuntimeError('The server returned an invalid job identifier.')
    states, deadline = [], time.monotonic() + timeout
    while True:
        state = job.get('state')
        if not states or states[-1] != state:
            states.append(state)
            print('Job:', state, flush=True)
        if state == 'ready':
            break
        if state in {'error', 'cancelled', 'expired'}:
            raise RuntimeError('Real video preparation failed. Check the app job message; no playable download was verified.')
        if time.monotonic() >= deadline:
            raise RuntimeError('Timed out waiting for the real download. No playable file was verified.')
        time.sleep(2)
        job = api('/api/jobs/' + job_id)
    route = job.get('download_url', '')
    if not route.startswith('/api/files/' + job_id + '/') or urlsplit(route).scheme or urlsplit(route).netloc or '?' in route or '#' in route:
        raise RuntimeError('The server returned an invalid file link.')
    with tempfile.TemporaryDirectory(prefix='yt-down-acceptance-') as directory:
        candidate = Path(directory) / 'trial.mp4'
        # Download tokens suffice for file requests; the private server key is never sent here.
        try:
            with opener.open(Request(origin + route), timeout=90) as response, candidate.open('xb') as handle:
                if response.headers.get_content_type() != 'video/mp4':
                    raise RuntimeError('The file endpoint did not return an MP4 video.')
                shutil.copyfileobj(response, handle)
        except (HTTPError, URLError):
            raise RuntimeError('The prepared file could not be downloaded.') from None
        if candidate.stat().st_size != job.get('size') or candidate.stat().st_size == 0:
            raise RuntimeError('Downloaded media size did not match the prepared file.')
        probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries',
            'format=duration:stream=codec_type,codec_name', '-of', 'json', str(candidate)], capture_output=True, text=True, timeout=30)
        if probe.returncode:
            raise RuntimeError('FFprobe rejected the downloaded media.')
        media = json.loads(probe.stdout)
        streams = media.get('streams', [])
        if not any(s.get('codec_type') == 'video' and s.get('codec_name') == 'h264' for s in streams):
            raise RuntimeError('Downloaded file is missing H.264 video.')
        if not any(s.get('codec_type') == 'audio' and s.get('codec_name') == 'aac' for s in streams):
            raise RuntimeError('Downloaded file is missing AAC sound.')
        # Exclusive creation preserves any file created after the initial existence check.
        with output.open('xb') as target, candidate.open('rb') as source:
            shutil.copyfileobj(source, target)
        report = {'verified': True, 'server_origin': origin, 'video_url': video,
            'quality_limit': quality, 'states': states, 'bytes': output.stat().st_size,
            'streams': streams, 'duration_seconds': media.get('format', {}).get('duration')}
        print(json.dumps(report, indent=2))
        return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server', required=True)
    parser.add_argument('--url', required=True, help='A public YouTube video you may download')
    parser.add_argument('--quality', type=int, choices=[360, 480, 720, 1080], default=360)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        verify(args.server, args.url, args.quality, args.output, os.getenv('YT_DOWN_API_KEY', ''))
    except (ValueError, RuntimeError, OSError, subprocess.TimeoutExpired) as exc:
        print('NOT VERIFIED:', exc, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
