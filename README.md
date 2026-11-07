# YT Down

A small iPhone Home Screen PWA: paste a YouTube link, choose quality, prepare an MP4 with sound, then save to Files.

**App:** https://asre1212.github.io/yt-down/

The frontend works on GitHub Pages. **Actual video downloads require the included server to be deployed and connected.** The app never pretends a link has downloaded if a server is absent. This cannot promise *any* YouTube video: private, paid, region-restricted, live, removed, or YouTube-blocked content can fail. Use it for videos you own or have permission to download.

## iPhone

1. Open the app in Safari → Share → **Add to Home Screen** → **Open as Web App** if shown → Add.
2. Connect the server once in Settings using its HTTPS address and private access key.
3. Paste a video or Shorts link, select a maximum quality, and tap **Prepare download**.
4. Keep the app open while it prepares, then tap **Save video**. If iOS opens a player, use Share → Save to Files. To save to Photos, open the MP4 in Files → Share → Save Video.

The app shell works offline; preparing new videos needs internet. iOS may pause a background web app. Reopening resumes status checks for the most recent job. Large videos stream directly to the browser instead of being held in JavaScript memory. History stores links, not video files. Native share-target support varies by browser; copying and pasting is the supported iPhone flow.

## Download server

### Option A: deploy the included Docker service

[Deploy on Render](https://render.com/deploy?repo=https://github.com/asre1212/yt-down)

The Blueprint selects Render’s free web-service plan and generates a private `API_KEY`. Review the provider’s current limits before deploying. This repository does not provision a paid service automatically.

1. Deploy the Blueprint from this repository.
2. In the deployed service’s Environment settings, copy the generated `API_KEY`.
3. Open YT Down Settings, paste the service’s HTTPS URL and key, and tap **Save & connect**. You can also open the service URL itself; it hosts the same app.

**Reliability:** YouTube can block datacenter IP addresses. A successful deployment does not establish that YouTube downloads will work from that host. This is a deployment option, not a promise of a working bypass. A server on your home network can be a more suitable location when datacenter access is blocked. The app does not bypass sign-in, payment, DRM, or geographic restrictions.

Free services can sleep or restart, and their disk is ephemeral. Jobs and prepared files are lost on restart. Keep the app open; re-prepare the video if a file expires. See [Render free-service limits](https://render.com/docs/free).

### Option B: Docker on your own computer/server

```sh
docker build --pull -t yt-down .
# Generate a private key, then put it in a local .env file (ignored by Git).
python -c 'import secrets; print(secrets.token_urlsafe(32))'
# .env must contain API_KEY=<generated key>
docker run --rm --init --env-file .env -p 8080:8080 yt-down
```

Serve it behind an HTTPS reverse proxy for iPhone use. Allow the PWA’s exact origin in `ALLOWED_ORIGINS` (default `https://asre1212.github.io`). Same-origin hosting also works. Never place a key in a public config, a GitHub issue, a URL, or committed source. A server key is stored only in that browser’s local storage; do not connect untrusted servers or use a shared browser profile.

### Limits and maintenance

| Setting | Default |
|---|---|
| Output | H.264 MP4 + AAC, up to 360/480/720/1080p |
| File size | 512 MB (`MAX_FILE_MB`) |
| Video duration | 3 hours (`MAX_DURATION_SECONDS`) |
| Preparation deadline | 20 minutes |
| Parallel preparation | 1; at most 2 pending jobs |
| Prepared files | At most 4 total jobs retained, 30-minute expiry |
| Temporary storage | `/tmp/yt-down`; purged on restart |

FFmpeg merges audio/video; Deno and `yt-dlp[default]` provide YouTube extraction support. Rebuild with `--pull --no-cache` or use Render’s clear-cache redeploy to update yt-dlp when YouTube changes. Dependencies intentionally permit current yt-dlp rather than freezing an extractor that quickly becomes stale. Do not run more than one Uvicorn worker or service replica: job state is in memory.

Jobs require a bearer access key; file links use separate random, short-lived download tokens so the server key never appears in a download URL. Access logs are disabled to avoid logging file tokens. API responses/files are never service-worker cached. Only canonical YouTube hosts/video IDs are accepted, and subprocesses use argument arrays, not a shell. Bot/sign-in failures are surfaced clearly. No account-cookie import is provided.

## GitHub Pages and updates

In repository Settings → Pages, select **Deploy from a branch**, **main**, **/docs**, then Save. No frontend build is needed. `/docs` contains only public PWA assets.

The app checks for a new service worker on opening and returning to the foreground. Bump `VERSION` in `docs/core.js` and the cache version in `docs/sw.js` together whenever cached assets change. Updates wait while a download is active; use Settings → Check for updates afterward. Device settings/history are preserved. No analytics or third-party UI assets are loaded.

## Development and checks

```sh
pip install -r requirements.txt httpx
npm test
python -m unittest discover -s tests -v
# Set API_KEY to a random string of at least 24 characters first.
uvicorn server.app:app --host 127.0.0.1 --port 8080 --workers 1
```

Automated tests cover URL validation, authorization, CORS, blocked-video errors, cancellation, file expiry, range downloads, rejection of HTML error pages posing as video, and the complete job/file API using a simulated extractor. FFprobe checks for H.264 video and AAC audio before a real job is marked ready. These tests do **not** prove live YouTube availability. Confirm a real video download from your deployed host and save it on an actual iPhone before relying on the service.

Build verification on November 7, 2026: automated checks passed and the published frontend was opened successfully. A real YouTube metadata request succeeded, but media-file requests from the build environment returned a network “Site Unavailable” page; the end-to-end real-video test did not pass. The Docker image and physical iPhone saving still need deployment/device verification. No download server has been provisioned by this repository alone.

## Technical references reviewed

- [GitHub Pages: static hosting and publishing](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)
- [Apple: turn a website into an iPhone app](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios)
- [yt-dlp: external JavaScript requirements](https://github.com/yt-dlp/yt-dlp/wiki/EJS)
- [Render Blueprint reference](https://render.com/docs/blueprint-spec)
- [FastAPI file responses](https://fastapi.tiangolo.com/advanced/custom-response/)
