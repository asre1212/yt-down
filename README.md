# YT Down

Paste a YouTube link → get an **MP4 with sound** (H.264 + AAC, up to 1080p) on your computer or iPhone. Free: no hosting bill, no account, no credit card.

**App page:** https://asre1212.github.io/yt-down/ · Use it for videos you own or have permission to download.

## How it works (and why)

YouTube refuses to serve videos to cloud/datacenter servers ("Sign in to confirm you're not a bot"). This was tested on November 14, 2026: GitHub Actions runners (Linux x64, Linux ARM, Windows, macOS) were blocked on every attempt, including with yt-dlp's alternative player clients. Free cloud hosts (Render, Railway, Hugging Face, Cloudflare) run in the same kind of datacenter and also need a card or a paid plan. So the app does not depend on a cloud server.

Instead, **your own computer prepares the video**. `start.py` runs a small server (yt-dlp + FFmpeg) on your Mac/PC. It hosts the app too, so you open its address on the computer, or on your iPhone over the same Wi-Fi. Everything it installs is free and lives inside this folder (`.venv`). No admin rights, Homebrew, or Docker are needed.

## Setup

One-time, on a Mac, Windows, or Linux computer:

1. Install **Python 3.10+** if you don't have it: https://www.python.org/downloads/ (on Windows, tick "Add python.exe to PATH").
2. Download this project: **Code → Download ZIP** on GitHub and unzip it, or run `git clone https://github.com/asre1212/yt-down.git`.

Each time you want to download:

3. Open a terminal in the project folder and run:
   ```sh
   python3 start.py        # Windows: py start.py
   ```
   The first run takes about a minute while it installs yt-dlp, FFmpeg, and Deno into `.venv`. After that it starts in seconds and updates yt-dlp automatically.
4. Your browser opens YT Down. Paste a link, choose a quality, tap **Prepare download**, then **Save video**. On a computer the file goes to your Downloads folder.
5. **iPhone:** keep the computer on the same Wi-Fi and scan the QR code shown in the terminal with the Camera, or type the `http://192.168.…` address into Safari. The link unlocks your phone automatically. Tap **Save video** → **Download** and the MP4 goes to Files → Downloads. To put it in Photos, open it in Files → Share → **Save Video**.

Leave the terminal window open while you use the app. Press Ctrl+C to stop.

If your computer asks whether Python may accept incoming network connections, click **Allow** so the iPhone can reach it. Use `python3 start.py --local-only` if you only use the computer.

### Options

| Command | What it does |
|---|---|
| `python3 start.py --port 8090` | Use another port if 8080 is busy |
| `python3 start.py --local-only` | Only this computer can connect |
| `python3 start.py --no-browser` | Don't open a browser tab |
| `python3 start.py --tunnel` | Also prints a temporary **HTTPS** address that works away from home. This needs the free [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (no account). The address changes on every start. *Not yet verified end to end: the build machine's network blocks Cloudflare's tunnel port.* |

### Privacy and security

- `start.py` creates a random private access key in `.yt-down-key`. This file is git-ignored and never committed. The printed links carry the key after `#`, which browsers don't send to servers. The app swaps it for a 30-day HttpOnly session cookie and removes it from the address bar. Don't share these links. Delete `.yt-down-key` to issue a new key; that signs out all devices.
- On home Wi-Fi the connection is plain HTTP, like most home devices. Use `--local-only` on untrusted networks.
- Your downloads, links, and key never touch GitHub or any cloud service. History stays on each device.

## Limits

| Setting | Default |
|---|---|
| Output | H.264 MP4 + AAC, up to 360/480/720/1080p |
| File size | 512 MB (`MAX_FILE_MB`) |
| Video length | 3 hours (`MAX_DURATION_SECONDS`) |
| Prepared files | 30-minute expiry, at most 4 kept; temp folder cleared on restart |

Private, members-only, paid, region-restricted, live, or removed videos can fail. The app never bypasses sign-in, DRM, or YouTube's bot checks, and it doesn't import account cookies. If downloads start failing after a YouTube change, restart `start.py` to update yt-dlp.

## The GitHub Pages app

https://asre1212.github.io/yt-down/ is the same app, installable as an iPhone Home Screen web app. It cannot download by itself. If you started your computer with `--tunnel`, you can enter that HTTPS address and the access key under Settings. Otherwise, use the address printed by `start.py`. Pages publishes `main` → `/docs` (Settings → Pages → Deploy from a branch → main → /docs).

## Docker (optional, for an always-on home server)

```sh
docker build --pull -t yt-down .
python3 -c 'import secrets; print("API_KEY=" + secrets.token_urlsafe(32))' > .env
docker run --rm --init --env-file .env -p 8080:8080 yt-down
```

Open `http://<that machine's IP>:8080/#key=<the key from .env>`. Run it on a home network. A cloud VPS IP is likely to be blocked by YouTube.

## Development

```sh
npm ci && npm run build && npm test
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt httpx
.venv/bin/python -m unittest discover -s tests -v
```

For every frontend change, run `npm run build` and commit the regenerated `docs/sw.js`. CI rejects a stale one. Real-download check against a running server (not run in CI):

```sh
YT_DOWN_API_KEY="$(cat .yt-down-key)" python3 scripts/verify-download.py --server http://localhost:8080 \
  --url 'https://www.youtube.com/watch?v=jNQXAC9IVRw' --quality 360 --output trial.mp4
```

### Verification log (November 14, 2026)

- GitHub Actions as a backend: **blocked** by YouTube on all 4 runner OSes, 2 videos, 4 player clients (32/32 "Sign in to confirm you're not a bot").
- `python3 start.py` on a non-datacenter Linux machine: "Me at the zoo" (`jNQXAC9IVRw`) at 360p came out as an H.264 320×240 + AAC MP4, 19 s, 744 KB. Big Buck Bunny (`aqz-KE-bpKQ`) at 720p came out as an H.264 1280×720 + AAC MP4, 10:34, 182 MB, in about 15 s. Both passed an ffprobe check.
- UI flow in Chrome with an iPhone viewport over the plain-HTTP network address: the `#key` link unlocked the device, the Shorts link was prepared, and **Save video** downloaded a playable MP4 with sound.
- Not yet verified: a physical iPhone, Windows/macOS hosts, and `--tunnel`.
