// FFmpeg command builders — a direct port of the app's VideoExportService filter
// graphs (exportTrim / concatSegments / _overlayCompose / _audioCompose), but as
// spawn ARG ARRAYS (no shell quoting) and SOFTWARE-only (no Android mediacodec).
// On a server CPU libx264 is fast and has none of the mobile codec-pool limits
// that froze the phone, so 4K in / 1080p out is a few seconds.

const { spawn } = require('child_process');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// Scale to <=1920 long edge, keep even dimensions, force yuv420p (same as the app).
const BASE_VF =
  'scale=w=1920:h=1920:force_original_aspect_ratio=decrease:flags=fast_bilinear,' +
  'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p';

// Overlay compositing filter. inputIndex maps overlay i → ffmpeg input (1-based,
// input 0 is always the source video). Photos are scaled to widthPx; text PNGs
// are used as-is. Each overlay is centred at fractional (posX,posY) and shown
// only during [start,end]. Returns { inputs, fc, vlabel }.
function overlayCompose(overlays) {
  let fc = `[0:v]${BASE_VF}[base]`;
  const inputs = [];
  let prev = 'base';
  overlays.forEach((o, i) => {
    inputs.push('-i', o.file);
    let olbl = `${i + 1}:v`;
    if (o.isPhoto) {
      fc += `;[${olbl}]scale=${o.widthPx}:-1[p${i}]`;
      olbl = `p${i}`;
    }
    fc +=
      `;[${prev}][${olbl}]overlay=x=W*${o.posX.toFixed(4)}-w/2:` +
      `y=H*${o.posY.toFixed(4)}-h/2:` +
      `enable='between(t,${o.start.toFixed(3)},${o.end.toFixed(3)})'[v${i}]`;
    prev = `v${i}`;
  });
  return { inputs, fc, vlabel: prev };
}

// Audio mix filter: original audio at origVol + each music clip (delayed to its
// finalStart, at its own volume), amixed. overlayCount offsets the input index
// (music inputs come after the source + overlay inputs). Returns { inputs, afc, alabel }.
function audioCompose(music, origVol, overlayCount) {
  const inputs = [];
  let f = `[0:a]volume=${origVol.toFixed(3)}[abase]`;
  let labels = '[abase]';
  music.forEach((m, k) => {
    inputs.push('-ss', (m.srcOffset || 0).toFixed(3),
      '-t', m.duration.toFixed(3), '-i', m.file);
    const idx = 1 + overlayCount + k;
    const delay = Math.max(0, Math.round((m.finalStart || 0) * 1000));
    f += `;[${idx}:a]adelay=${delay}:all=1,volume=${(m.volume ?? 0.6).toFixed(3)}[mc${k}]`;
    labels += `[mc${k}]`;
  });
  f += `;${labels}amix=inputs=${music.length + 1}` +
    `:duration=first:dropout_transition=0:normalize=0[aout]`;
  return { inputs, afc: f, alabel: 'aout' };
}

// exportTrim: trim [inPt,outPt] of source, composite overlays + music, encode
// <=1080p H.264. Returns the ffmpeg arg array.
function buildTrim(source, inPt, outPt, overlays, music, origVol, out) {
  const dur = Math.max(0.1, outPt - inPt);
  const { inputs: ovInputs, fc: vfc, vlabel } = overlayCompose(overlays);
  const hasMusic = music.length > 0;
  const { inputs: mInputs, afc, alabel } = hasMusic
    ? audioCompose(music, origVol, overlays.length)
    : { inputs: [], afc: '', alabel: '' };
  const useFilter = overlays.length > 0 || hasMusic;

  const args = ['-y', '-ss', inPt.toFixed(3), '-i', source, ...ovInputs, ...mInputs,
    '-t', dur.toFixed(3)];
  if (!useFilter) {
    args.push('-vf', BASE_VF);
  } else {
    args.push('-filter_complex', [vfc, hasMusic ? afc : null].filter(Boolean).join(';'),
      '-map', `[${vlabel}]`, '-map', hasMusic ? `[${alabel}]` : '0:a?');
  }
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out);
  return args;
}

// concatSegments: concat the kept source-second ranges into one continuous file
// (drops deleted gaps), <=1080p H.264. Returns the ffmpeg arg array.
function buildConcat(source, segs, hasAudio, out) {
  const scale = 'scale=w=1920:h=1920:force_original_aspect_ratio=decrease:flags=fast_bilinear,' +
    'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p';
  let fc = '';
  let join = '';
  segs.forEach((s, i) => {
    const a = s[0].toFixed(3), b = s[1].toFixed(3);
    fc += `[0:v]trim=${a}:${b},setpts=PTS-STARTPTS,${scale}[v${i}];`;
    if (hasAudio) fc += `[0:a]atrim=${a}:${b},asetpts=PTS-STARTPTS[a${i}];`;
    join += hasAudio ? `[v${i}][a${i}]` : `[v${i}]`;
  });
  fc += `${join}concat=n=${segs.length}:v=1:a=${hasAudio ? 1 : 0}[v]${hasAudio ? '[a]' : ''}`;

  const args = ['-y', '-i', source, '-filter_complex', fc, '-map', '[v]'];
  if (hasAudio) args.push('-map', '[a]'); else args.push('-an');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23');
  if (hasAudio) args.push('-c:a', 'aac', '-b:a', '128k');
  args.push('-movflags', '+faststart', out);
  return args;
}

// Probe: does the source have an audio stream? (concat filter must match.)
function hasAudioStream(source) {
  return new Promise((resolve) => {
    const p = spawn(process.env.FFPROBE_PATH || 'ffprobe',
      ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index',
        '-of', 'csv=p=0', source]);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => resolve(out.trim().length > 0));
    p.on('error', () => resolve(true)); // assume audio on probe failure (safe default)
  });
}

// Run ffmpeg with the given args, killing it after timeoutMs. Resolves true on rc 0.
function runFfmpeg(args, timeoutMs = 180000, onLog) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, args);
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} finish(false); }, timeoutMs);
    p.stderr.on('data', (d) => { if (onLog) onLog(d.toString()); });
    p.on('close', (code) => { clearTimeout(timer); finish(code === 0); });
    p.on('error', () => { clearTimeout(timer); finish(false); });
  });
}

module.exports = { buildTrim, buildConcat, hasAudioStream, runFfmpeg };
