# DIGUZ render server

Runs the app's FFmpeg edit pipeline (concat kept segments → composite overlays →
mix music → trim) **on a server** instead of the phone. The phone uploads the
clip + overlay/music files + an edit-spec JSON and gets back the finished MP4.
No on-device transcoding, so it works identically on every phone.

## Endpoint

`POST /render` — multipart form:
- `video` — the source clip
- `ov0, ov1, …` — overlay PNGs (text) / photos, referenced by `field` in the spec
- `mus0, mus1, …` — music files, referenced by `field` in the spec
- `spec` — JSON:

```json
{
  "segments": [[0,2],[4,6]],
  "originalVolume": 1.0,
  "overlays": [{"field":"ov0","isPhoto":true,"widthPx":320,"posX":0.5,"posY":0.3,"start":0.5,"end":3.5}],
  "music":    [{"field":"mus0","srcOffset":0,"finalStart":0.5,"duration":3,"volume":0.7}]
}
```
`segments` are SOURCE seconds; overlay/music times are OUTPUT (packed) seconds.
Returns `video/mp4`. `GET /health` → `ok`.

Optional auth: set `RENDER_KEY` env var; the app must then send header `X-Render-Key`.

## Deploy — Option A: Fly.io (CLI already installed, no GitHub needed)

```
cd render_server
fly launch --copy-config --no-deploy   # creates the app from fly.toml
fly deploy                             # build + ship
# (optional) lock down the endpoint:
fly secrets set RENDER_KEY=some-long-random-string
```
Machines **auto-stop when idle** → near-zero cost; set a hard cap in the Fly
dashboard (Billing → spending limit) so it can never surprise-bill.

## Deploy — Option B: Render.com (flat price, needs a Git repo)

Push this folder to a GitHub repo, then in Render: **New → Web Service → Docker**,
pick the repo. Choose a flat instance (Starter/Standard). Set `RENDER_KEY` in the
Environment tab. Flat monthly price — no metered billing.

## Local run

```
FFMPEG_PATH=/path/to/ffmpeg FFPROBE_PATH=/path/to/ffprobe PORT=8080 node server.js
```
