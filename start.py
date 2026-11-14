#!/usr/bin/env python3
"""Start YT Down on your own computer: python start.py

First run creates a private .venv here and installs yt-dlp, FFmpeg, Deno and the web server
(all free, from PyPI; no admin rights, Homebrew or Docker needed). Later runs update yt-dlp,
then print the addresses to open on this computer and on your iPhone.

Options:
  --port 8080      port to listen on
  --local-only     only this computer can connect (no iPhone on Wi-Fi)
  --tunnel         also open a free temporary HTTPS address (needs `cloudflared` installed)
  --no-browser     do not open the app in a browser automatically
  --no-update      skip the yt-dlp update check
"""
import argparse
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import venv
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VENV = ROOT / '.venv'
KEY_FILE = ROOT / '.yt-down-key'
PACKAGES = ['-r', str(ROOT / 'requirements.txt'), 'deno', 'static-ffmpeg', 'qrcode']


def venv_python():
    return VENV / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')


def run(args, **kw):
    return subprocess.run([str(a) for a in args], **kw)


def ensure_env(update):
    if sys.version_info < (3, 10):
        sys.exit('YT Down needs Python 3.10 or newer: https://www.python.org/downloads/')
    py = venv_python()
    marker = VENV / '.yt-down-installed'
    if not py.exists():
        print('First run: setting up YT Down in', VENV, '(one-time, about a minute)…')
        venv.EnvBuilder(with_pip=True).create(VENV)
    if not marker.exists():
        if run([py, '-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-U', 'pip']).returncode:
            print('Warning: could not update pip; continuing.')
        if run([py, '-m', 'pip', 'install', '--disable-pip-version-check', '-q', *PACKAGES]).returncode:
            sys.exit('Could not install YT Down requirements. Check your internet connection and try again.')
        marker.write_text('ok')
    elif update:
        print('Checking for a newer yt-dlp (YouTube changes often)…')
        if run([py, '-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-U', 'yt-dlp[default]']).returncode:
            print('Warning: yt-dlp update failed; using the installed version.')
    return py


def tool_paths(py):
    """Folders holding ffmpeg/ffprobe/deno, preferring ones already installed on this computer."""
    folders = [str(py.parent)]
    if not (shutil.which('ffmpeg') and shutil.which('ffprobe')):
        found = run([py, '-c', 'import static_ffmpeg.run as r, os; print(os.path.dirname(r.get_or_fetch_platform_executables_else_raise()[0]))'], capture_output=True, text=True)
        if found.returncode:
            sys.exit('Could not prepare FFmpeg:\n' + found.stderr[-2000:])
        folders.append(found.stdout.strip().splitlines()[-1])
    return folders


def access_key():
    if KEY_FILE.exists():
        key = KEY_FILE.read_text().strip()
        if len(key) >= 24:
            return key
    key = secrets.token_urlsafe(32)
    KEY_FILE.write_text(key)
    with __import__('contextlib').suppress(OSError):
        os.chmod(KEY_FILE, 0o600)
    return key


def lan_address():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(('192.0.2.1', 80))  # no packet is sent; this just picks the Wi-Fi/Ethernet interface
            return s.getsockname()[0]
        except OSError:
            return None


def show_qr(py, text):
    run([py, '-c', 'import qrcode,sys; q=qrcode.QRCode(border=1); q.add_data(sys.argv[1]); q.print_ascii(invert=True)', text])


def start_tunnel(port, key, py):
    exe = shutil.which('cloudflared')
    if not exe:
        print('\n--tunnel needs cloudflared (free, no account): https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/')
        return None
    proc = subprocess.Popen([exe, 'tunnel', '--no-autoupdate', '--url', f'http://127.0.0.1:{port}'], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)

    def watch():
        for line in proc.stderr:
            match = re.search(r'https://[a-z0-9-]+\.trycloudflare\.com', line)
            if match:
                url = f'{match.group(0)}/#key={key}'
                print('\nHTTPS address (works away from home; changes every time):\n  ', url)
                show_qr(py, url)
                break
        for _ in proc.stderr:
            pass
    threading.Thread(target=watch, daemon=True).start()
    return proc


def main():
    sys.stdout.reconfigure(line_buffering=True)
    parser = argparse.ArgumentParser(description='Run YT Down on this computer.')
    parser.add_argument('--port', type=int, default=int(os.getenv('PORT', '8080')))
    parser.add_argument('--local-only', action='store_true')
    parser.add_argument('--tunnel', action='store_true')
    parser.add_argument('--no-browser', action='store_true')
    parser.add_argument('--no-update', action='store_true')
    args = parser.parse_args()

    py = ensure_env(update=not args.no_update)
    key = access_key()
    env = dict(os.environ)
    env['PATH'] = os.pathsep.join([*tool_paths(py), env.get('PATH', '')])
    env['API_KEY'] = key
    env.setdefault('ALLOWED_ORIGINS', 'https://asre1212.github.io')
    env.setdefault('DOWNLOAD_DIR', str(Path(os.getenv('TMPDIR') or os.getenv('TEMP') or '/tmp') / 'yt-down'))
    env['PYTHONUNBUFFERED'] = '1'
    host = '127.0.0.1' if args.local_only else '0.0.0.0'
    server = subprocess.Popen([str(py), '-m', 'uvicorn', 'server.app:app', '--host', host, '--port', str(args.port), '--workers', '1', '--no-access-log', '--proxy-headers', '--forwarded-allow-ips', '127.0.0.1', '--log-level', 'warning'], cwd=ROOT, env=env)

    local = f'http://localhost:{args.port}/#key={key}'
    for _ in range(60):
        if server.poll() is not None:
            sys.exit(f'The server stopped. Is port {args.port} already in use? Try: python start.py --port 8090')
        try:
            socket.create_connection(('127.0.0.1', args.port), timeout=.5).close()
            break
        except OSError:
            time.sleep(.5)
    print('\nYT Down is running. Keep this window open; press Ctrl+C to stop.\n')
    print('On this computer:\n  ', local)
    ip = None if args.local_only else lan_address()
    if ip:
        phone = f'http://{ip}:{args.port}/#key={key}'
        print('\nOn your iPhone (same Wi-Fi): scan this or open in Safari:\n  ', phone)
        show_qr(py, phone)
    print('\nThese links contain your private access key. Do not share them.')
    tunnel = start_tunnel(args.port, key, py) if args.tunnel else None
    if not args.no_browser:
        webbrowser.open(local)
    try:
        server.wait()
    except KeyboardInterrupt:
        pass
    finally:
        for proc in (server, tunnel):
            if proc and proc.poll() is None:
                proc.terminate()
        print('\nYT Down stopped.')


if __name__ == '__main__':
    main()
