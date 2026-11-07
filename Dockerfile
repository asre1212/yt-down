FROM denoland/deno:bin-2.6.6 AS deno
FROM python:3.12-slim
COPY --from=deno /deno /usr/local/bin/deno
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server ./server
COPY docs ./docs
RUN useradd --create-home --uid 10001 downloader && mkdir -p /tmp/yt-down && chown downloader:downloader /tmp/yt-down
USER downloader
ENV PORT=8080 PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["sh", "-c", "exec uvicorn server.app:app --host 0.0.0.0 --port ${PORT:-8080} --workers 1 --no-access-log"]
