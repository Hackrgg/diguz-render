// DIGUZ render server. One endpoint, POST /render:
//   multipart body = the source video + overlay PNGs/photos + music files + a
//   `spec` JSON describing the edit (segments, overlays, music, volume).
// It concatenates the kept segments (dropping deleted gaps), composites the
// overlays and mixes the music, and streams back the finished MP4. All heavy
// FFmpeg work happens HERE, on the server — the phone does none of it.

const express = require('express');
const multer = require('multer');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { buildTrim, buildConcat, hasAudioStream, runFfmpeg } = require('./ffmpeg');

const app = express();
const PORT = process.env.PORT || 8080;
const RENDER_KEY = process.env.RENDER_KEY || ''; // optional shared secret

// Per-request temp job dir; multer drops uploads straight to disk (videos are big).
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => cb(null, req._jobDir),
    filename: (_req, file, cb) => cb(null, file.fieldname + path.extname(file.originalname || '')),
  }),
  limits: { fileSize: 600 * 1024 * 1024 }, // 600MB per file
});

function makeJobDir(req, _res, next) {
  req._jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diguz_job_'));
  next();
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

app.get('/health', (_req, res) => res.status(200).send('ok'));

app.post('/render', makeJobDir, upload.any(), async (req, res) => {
  const jobDir = req._jobDir;
  const fail = (code, msg) => { cleanup(jobDir); res.status(code).json({ error: msg }); };

  try {
    if (RENDER_KEY && req.get('X-Render-Key') !== RENDER_KEY) return fail(401, 'bad key');

    const spec = JSON.parse(req.body.spec || '{}');
    const files = {};
    (req.files || []).forEach((f) => { files[f.fieldname] = f.path; });
    const videoPath = files['video'];
    if (!videoPath) return fail(400, 'no video');

    const segments = (spec.segments || []).map((s) => [Number(s[0]), Number(s[1])]);
    if (segments.length === 0) return fail(400, 'no segments');
    const total = segments.reduce((a, s) => a + (s[1] - s[0]), 0);
    const origVol = spec.originalVolume == null ? 1.0 : Number(spec.originalVolume);

    // Resolve overlay/music specs to their uploaded file paths.
    const overlays = (spec.overlays || [])
      .filter((o) => files[o.field])
      .map((o) => ({
        file: files[o.field], isPhoto: !!o.isPhoto, widthPx: o.widthPx || 0,
        posX: Number(o.posX), posY: Number(o.posY),
        start: Number(o.start), end: Number(o.end),
      }));
    const music = (spec.music || [])
      .filter((m) => files[m.field])
      .map((m) => ({
        file: files[m.field], srcOffset: Number(m.srcOffset || 0),
        finalStart: Number(m.finalStart || 0), duration: Number(m.duration),
        volume: m.volume == null ? 0.6 : Number(m.volume),
      }));

    const timeout = Math.max(120000, Math.round(total * 10000)); // generous, server is fast

    // 1) Multiple kept segments → concat into one continuous file first.
    let workVideo = videoPath;
    let inPt = 0, outPt = total;
    if (segments.length === 1) {
      inPt = segments[0][0]; outPt = segments[0][1];
    } else {
      const hasAudio = await hasAudioStream(videoPath);
      const catOut = path.join(jobDir, 'cat.mp4');
      const ok = await runFfmpeg(buildConcat(videoPath, segments, hasAudio, catOut), timeout);
      if (!ok || !fs.existsSync(catOut)) return fail(500, 'concat failed');
      workVideo = catOut;
    }

    // 2) Composite overlays + music and trim to the final clip.
    const out = path.join(jobDir, 'out.mp4');
    let ok = await runFfmpeg(
      buildTrim(workVideo, inPt, outPt, overlays, music, origVol, out), timeout);
    // Same safety net as the app: if compositing failed, fall back to a plain trim
    // so an export never dies entirely (just loses overlays/music).
    if ((!ok || !fs.existsSync(out)) && (overlays.length || music.length)) {
      ok = await runFfmpeg(buildTrim(workVideo, inPt, outPt, [], [], origVol, out), timeout);
    }
    if (!ok || !fs.existsSync(out)) return fail(500, 'render failed');

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="diguz_export.mp4"');
    const stream = fs.createReadStream(out);
    stream.on('close', () => cleanup(jobDir));
    stream.on('error', () => cleanup(jobDir));
    stream.pipe(res);
  } catch (e) {
    fail(500, String(e && e.message ? e.message : e));
  }
});

app.listen(PORT, () => console.log(`DIGUZ render server on :${PORT}`));
