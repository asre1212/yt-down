"""Single-instance personal downloader. Run with one Uvicorn worker."""
import asyncio
import contextlib
import hashlib
import hmac
import json
import os
import re
import secrets
import signal
import shutil
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.getenv('DOWNLOAD_DIR', '/tmp/yt-down'))
API_KEY = os.getenv('API_KEY', '')
TTL = 1800
MAX_BYTES = int(os.getenv('MAX_FILE_MB', '512')) * 1024 * 1024
MAX_SECONDS = int(os.getenv('MAX_DURATION_SECONDS', '10800'))
JOB_TIMEOUT = 1200
JOBS = {}
WORKERS = set()
QUEUE = asyncio.Semaphore(1)
SESSION_TTL = 30 * 24 * 3600
SESSION_COOKIE = '__Host-yt_down_session'
LOGIN_ATTEMPTS = {}


def session_valid(value):
    if len(API_KEY) < 24 or not value or len(value) > 256:
        return False
    try:
        expiry, nonce, signature = value.split('.')
        if not time.time() < int(expiry) <= time.time() + SESSION_TTL + 60:
            return False
        expected = hmac.new(API_KEY.encode(), f'session:{expiry}.{nonce}'.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(signature, expected)
    except (ValueError, TypeError):
        return False


def same_origin(request):
    configured = os.getenv('PUBLIC_APP_URL') or os.getenv('RENDER_EXTERNAL_URL') or ''
    expected = configured.rstrip('/') or str(request.base_url).rstrip('/')
    origin = request.headers.get('origin')
    if request.headers.get('sec-fetch-site') == 'cross-site' or (origin and origin != expected):
        raise HTTPException(403, 'Open the download app directly to unlock it.')


def canonical_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in ('https', 'http') or parsed.username or parsed.password or parsed.port:
            raise ValueError()
        host = (parsed.hostname or '').lower()
        if host not in {'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be'}:
            raise ValueError()
        parts = parsed.path.strip('/').split('/')
        video_id = parts[0] if host.endswith('youtu.be') else parse_qs(parsed.query).get('v', [''])[0] if parts[0] == 'watch' else parts[1] if len(parts) == 2 and parts[0] in ('shorts', 'live', 'embed') else ''
        if not re.fullmatch(r'[A-Za-z0-9_-]{11}', video_id):
            raise ValueError()
        return 'https://www.youtube.com/watch?v=' + video_id
    except (ValueError, IndexError):
        raise HTTPException(422, 'Use a single youtube.com or youtu.be video link.')


def authorize(request: Request, authorization: str = Header(default='')):
    if len(API_KEY) < 24:
        raise HTTPException(503, 'The server needs a private access key before downloads can start.')
    if authorization:
        if hmac.compare_digest(authorization, 'Bearer ' + API_KEY):
            return
    elif session_valid(request.cookies.get(SESSION_COOKIE)):
        same_origin(request)
        return
    raise HTTPException(401, 'Unlock the app with your private access key.')


def tools_ready():
    return bool(shutil.which('ffmpeg') and shutil.which('ffprobe') and shutil.which('deno'))


def folder_bytes(path):
    total = 0
    for p in path.glob('*'):
        try:
            total += p.stat().st_size
        except FileNotFoundError:
            pass
    return total


def remove_job(job_id):
    job = JOBS.pop(job_id, None)
    if job:
        shutil.rmtree(DATA / job_id, ignore_errors=True)


async def reaper():
    while True:
        await asyncio.sleep(30)
        now = time.time()
        for job_id, job in list(JOBS.items()):
            if job['state'] not in {'queued', 'working'} and now - job.get('finished', job['created']) > TTL:
                remove_job(job_id)


@asynccontextmanager
async def lifespan(_app):
    DATA.mkdir(parents=True, exist_ok=True)
    # No download survives a restart: remove only our random-ID working directories.
    for entry in DATA.iterdir():
        if entry.is_dir() and re.fullmatch(r'[a-f0-9]{32}', entry.name):
            shutil.rmtree(entry, ignore_errors=True)
    cleanup = asyncio.create_task(reaper())
    yield
    cleanup.cancel()
    for task in list(WORKERS):
        task.cancel()
    await asyncio.gather(cleanup, *WORKERS, return_exceptions=True)


app = FastAPI(title='YT Down', docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
origins = [v.strip() for v in os.getenv('ALLOWED_ORIGINS', 'https://asre1212.github.io').split(',') if v.strip()]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=['GET', 'POST', 'DELETE'], allow_headers=['Authorization', 'Content-Type'], expose_headers=['Content-Disposition'], max_age=600)


@app.middleware('http')
async def security_headers(request: Request, call_next):
    if request.method == 'POST':
        length = request.headers.get('content-length', '')
        if not length.isdigit() or int(length) > 4096:
            return JSONResponse({'detail': 'Request body is too large or missing a length.'}, 413)
    response = await call_next(request)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['X-Frame-Options'] = 'DENY'
    if request.url.path.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-store'
    elif request.url.path.endswith(('sw.js', 'index.html', '/')):
        response.headers['Cache-Control'] = 'no-cache'
    return response


@app.get('/api/health')
async def health():
    return {'ok': True, 'configured': len(API_KEY) >= 24, 'tools_ready': tools_ready()}


@app.get('/api/config')
async def app_config(request: Request):
    return {'app': 'yt-down', 'integrated': True, 'configured': len(API_KEY) >= 24,
            'unlocked': session_valid(request.cookies.get(SESSION_COOKIE)), 'tools_ready': tools_ready()}


class UnlockRequest(BaseModel):
    key: str = Field(min_length=1, max_length=1024)


@app.post('/api/session')
async def unlock(body: UnlockRequest, request: Request, response: Response):
    same_origin(request)
    now = time.time()
    address = request.client.host if request.client else 'unknown'
    for client, attempts in list(LOGIN_ATTEMPTS.items()):
        recent = [stamp for stamp in attempts if now - stamp < 900]
        if recent:
            LOGIN_ATTEMPTS[client] = recent
        else:
            del LOGIN_ATTEMPTS[client]
    if len(LOGIN_ATTEMPTS.get(address, [])) >= 12 or len(LOGIN_ATTEMPTS) > 1024:
        raise HTTPException(429, 'Too many unlock attempts. Try again in 15 minutes.')
    if len(API_KEY) < 24:
        raise HTTPException(503, 'The private access key has not been configured on this host.')
    if not hmac.compare_digest(body.key, API_KEY):
        LOGIN_ATTEMPTS.setdefault(address, []).append(now)
        raise HTTPException(401, 'The access key is incorrect.')
    LOGIN_ATTEMPTS.pop(address, None)
    payload = f'{int(now) + SESSION_TTL}.{secrets.token_hex(16)}'
    signature = hmac.new(API_KEY.encode(), ('session:' + payload).encode(), hashlib.sha256).hexdigest()
    response.set_cookie(SESSION_COOKIE, payload + '.' + signature, max_age=SESSION_TTL, secure=True, httponly=True, samesite='strict', path='/')
    return {'ok': True}


@app.delete('/api/session')
async def lock(request: Request, response: Response):
    same_origin(request)
    response.delete_cookie(SESSION_COOKIE, secure=True, httponly=True, samesite='strict', path='/')
    return {'ok': True}


@app.get('/api/check', dependencies=[Depends(authorize)])
async def check():
    if not tools_ready():
        raise HTTPException(503, 'The server is missing FFmpeg or Deno. Redeploy using the included Dockerfile.')
    return {'ok': True}


class DownloadRequest(BaseModel):
    url: str = Field(max_length=2048)
    quality: int = 720


def public_job(job):
    return {key: job[key] for key in ['id', 'state', 'title', 'message', 'progress', 'error', 'size', 'filename', 'download_url'] if key in job}


def safe_error(text):
    lower = text.lower()
    if 'invalid media' in lower or 'invalid data' in lower:
        return 'The server did not receive a playable video. The host or network may have blocked the media download. No file was prepared.'
    if 'sign in' in lower or 'bot' in lower or '403' in lower:
        return 'YouTube blocked this server or requires sign-in for this video. No file was prepared. Try another video or use a server on your home network.'
    if 'private' in lower or 'members-only' in lower or 'premium' in lower:
        return 'This video requires account access and cannot be downloaded here.'
    if 'not available' in lower or 'removed' in lower or 'unavailable' in lower:
        return 'This video is unavailable to the download server.'
    if 'requested format' in lower:
        return 'An iPhone-compatible MP4 is unavailable at this quality. Try a lower quality.'
    if 'too large' in lower or 'maximum' in lower or 'max-filesize' in lower or 'larger than' in lower:
        return 'The video exceeds the server’s size limit. Try a lower quality.'
    if 'timed out' in lower:
        return 'Video preparation timed out. Try again or choose a lower quality.'
    return 'The video could not be prepared. Try another video or update yt-dlp on the server.'


async def command(job, args, timeout, progress=False):
    process = await asyncio.create_subprocess_exec(sys.executable, '-m', 'yt_dlp', *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, limit=8 * 1024 * 1024, start_new_session=True)
    output, errors = [], []

    async def drain(stream, chunks):
        seen = 0
        while line := await stream.readline():
            seen += len(line)
            if seen < 8 * 1024 * 1024:
                chunks.append(line.decode('utf-8', 'replace'))
            if progress and line.startswith(b'PROGRESS:'):
                try:
                    info = json.loads(line[len(b'PROGRESS:'):])
                    total = info.get('total_bytes') or info.get('total_bytes_estimate')
                    if total:
                        job['progress'] = min(95, round(info.get('downloaded_bytes', 0) / total * 95))
                    job['message'] = 'Downloading video and audio… Keep this app open.' if info.get('status') != 'finished' else 'Combining video and sound…'
                except (ValueError, TypeError):
                    pass

    readers = [asyncio.create_task(drain(process.stdout, output)), asyncio.create_task(drain(process.stderr, errors))]
    start = time.monotonic()
    try:
        while process.returncode is None:
            if job.get('cancel'):
                raise asyncio.CancelledError()
            if time.monotonic() - start > timeout:
                raise RuntimeError('Preparation timed out')
            if folder_bytes(DATA / job['id']) > MAX_BYTES * 2 + 32 * 1024 * 1024:
                raise RuntimeError('Video too large')
            await asyncio.sleep(.25)
        await asyncio.gather(*readers)
        if process.returncode:
            raise RuntimeError(''.join(errors)[-6000:])
        return ''.join(output)
    finally:
        if process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            await process.wait()
        for reader in readers:
            if not reader.done():
                reader.cancel()
        await asyncio.gather(*readers, return_exceptions=True)


async def inspect_file(path):
    process = await asyncio.create_subprocess_exec('ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', str(path), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        output, _ = await asyncio.wait_for(process.communicate(), 20)
        if process.returncode:
            raise RuntimeError('Invalid media file')
        streams = json.loads(output).get('streams', [])
        if not any(s.get('codec_type') == 'video' and s.get('codec_name') == 'h264' for s in streams) or not any(s.get('codec_type') == 'audio' and s.get('codec_name') == 'aac' for s in streams):
            raise RuntimeError('Invalid media file')
    finally:
        if process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            await process.wait()


async def prepare(job):
    folder = DATA / job['id']
    try:
        async with QUEUE:
            if job.get('cancel'):
                raise asyncio.CancelledError()
            job.update(state='working', message='Reading video details…')
            folder.mkdir(parents=True, exist_ok=True)
            base = ['--ignore-config', '--no-playlist', '--no-cache-dir', '--no-warnings', '--socket-timeout', '20', '--retries', '2', '--fragment-retries', '2', '--js-runtimes', 'deno', '--no-check-formats']
            raw = await command(job, [*base, '--dump-single-json', '--skip-download', '--', job['url']], 90)
            info = json.loads(raw)
            if info.get('_type') in {'playlist', 'multi_video'} or info.get('is_live') or info.get('live_status') in {'is_live','is_upcoming'}:
                raise ValueError('Live streams and playlists are not supported. Use a finished video.')
            if info.get('duration', 0) and info['duration'] > MAX_SECONDS:
                raise ValueError(f'This video exceeds the server’s {MAX_SECONDS // 3600}-hour limit.')
            job['title'] = str(info.get('title', 'YouTube video'))[:200]
            q = job['quality']
            fmt = f'bv[vcodec^=avc1][ext=mp4][height<={q}]+ba[ext=m4a]/b[vcodec^=avc1][ext=mp4][height<={q}]'
            job.update(message='Downloading video and sound…', progress=None)
            await command(job, [*base, '-f', fmt, '--merge-output-format', 'mp4', '--max-filesize', str(MAX_BYTES), '--newline', '--progress', '--progress-template', 'download:PROGRESS:%(progress)j', '--postprocessor-args', 'Merger+ffmpeg_o:-movflags +faststart', '-o', str(folder / 'video.%(ext)s'), '--', job['url']], JOB_TIMEOUT, progress=True)
            path = folder / 'video.mp4'
            if not path.is_file() or path.stat().st_size == 0:
                raise RuntimeError('No output file; maximum size may have been exceeded')
            if path.stat().st_size > MAX_BYTES:
                raise RuntimeError('Video too large')
            await inspect_file(path)
            if job.get('cancel'):
                raise asyncio.CancelledError()
            safe_name = re.sub(r'[\x00-\x1f<>:"/\\|?*]', '', job['title']).strip(' .')[:120] or 'YouTube video'
            token = secrets.token_urlsafe(32)
            job.update(state='ready', progress=100, size=path.stat().st_size, filename=safe_name + '.mp4', token=token, download_url=f'/api/files/{job["id"]}/{token}', message='Ready to save')
    except asyncio.CancelledError:
        job.update(state='cancelled', error='Download cancelled.')
    except ValueError as exc:
        job.update(state='error', error=str(exc) if not isinstance(exc, json.JSONDecodeError) else 'YouTube returned an unreadable response. Try updating the server.')
    except Exception as exc:
        job.update(state='error', error=safe_error(str(exc)))
    finally:
        job['finished'] = time.time()
        if job['state'] != 'ready':
            shutil.rmtree(folder, ignore_errors=True)


@app.post('/api/jobs', status_code=202, dependencies=[Depends(authorize)])
async def create_job(body: DownloadRequest):
    url = canonical_url(body.url)
    if body.quality not in {360, 480, 720, 1080}:
        raise HTTPException(422, 'Choose 360p, 480p, 720p, or 1080p.')
    if not tools_ready():
        raise HTTPException(503, 'The server is missing FFmpeg or Deno. Redeploy using the included Dockerfile.')
    pending = [job for job in JOBS.values() if job['state'] in {'queued', 'working'}]
    for job in pending:
        if job['url'] == url and job['quality'] == body.quality and not job.get('cancel'):
            return public_job(job)
    if len(pending) >= 2:
        raise HTTPException(429, 'The server is busy. Wait for your current download to finish.')
    # Retain at most four completed files, bounding disk usage as well as memory.
    completed = sorted((job for job in JOBS.values() if job['state'] not in {'queued', 'working'}), key=lambda job: job['created'])
    while len(JOBS) >= 4 and completed:
        remove_job(completed.pop(0)['id'])
    job_id = secrets.token_hex(16)
    job = {'id':job_id, 'url':url, 'quality':body.quality, 'state':'queued', 'created':time.time(), 'message':'Waiting for the download server…'}
    JOBS[job_id] = job
    task = asyncio.create_task(prepare(job)); WORKERS.add(task); task.add_done_callback(WORKERS.discard)
    return public_job(job)


@app.get('/api/jobs/{job_id}', dependencies=[Depends(authorize)])
async def get_job(job_id: str):
    if job_id not in JOBS:
        return {'id':job_id, 'state':'expired', 'error':'This download expired or the server restarted. Prepare the video again.'}
    return public_job(JOBS[job_id])


@app.delete('/api/jobs/{job_id}', dependencies=[Depends(authorize)])
async def cancel_job(job_id: str):
    job = JOBS.get(job_id)
    if job and job['state'] in {'queued', 'working'}:
        job['cancel'] = True
    elif job:
        remove_job(job_id)
    return {'ok': True}


@app.get('/api/files/{job_id}/{token}')
async def download_file(job_id: str, token: str):
    job = JOBS.get(job_id)
    if not job or job['state'] != 'ready' or not hmac.compare_digest(token, job.get('token', '')) or time.time() - job.get('finished', 0) > TTL:
        raise HTTPException(404, 'This download is unavailable or expired. Prepare the video again.')
    path = DATA / job_id / 'video.mp4'
    if not path.is_file():
        raise HTTPException(404, 'The file is no longer available. Prepare the video again.')
    # Stream from disk; do not load a full video into server or iPhone JavaScript memory.
    return FileResponse(path, media_type='video/mp4', filename=job['filename'], content_disposition_type='attachment')


app.mount('/', StaticFiles(directory=ROOT / 'docs', html=True), name='app')
