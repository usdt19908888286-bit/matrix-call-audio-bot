const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const SECRET = String(process.env.AUDIO_BOT_SECRET || '').trim();
const AUDIO_DIR = String(process.env.AUDIO_DIR || '/app/audio');
const jobs = new Map();

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function authorized(req) {
  if (!SECRET) return true;
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${SECRET}` || req.headers['x-audio-bot-secret'] === SECRET;
}

function makeTestWav({ seconds = 2, frequency = 880, sampleRate = 16000 } = {}) {
  const channels = 1;
  const bitsPerSample = 16;
  const totalSamples = Math.max(1, Math.floor(seconds * sampleRate));
  const dataSize = totalSamples * channels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < totalSamples; i++) {
    const fade = Math.min(1, i / 400, (totalSamples - i) / 400);
    const sample = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.28 * fade;
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }
  return buffer;
}

function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

function normalizeAudioName(value) {
  const name = String(value || '').trim().toLowerCase();
  return /^[a-z0-9_-]{1,64}$/.test(name) ? name : '';
}

function audioFilePath(name) {
  return path.join(AUDIO_DIR, `${name}.wav`);
}

function serveWavFile(res, name) {
  const file = audioFilePath(name);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return sendJson(res, 404, { ok: false, error: 'audio not found' });
  }
  if (!stat.isFile()) return sendJson(res, 404, { ok: false, error: 'audio not found' });

  res.writeHead(200, {
    'content-type': 'audio/wav',
    'content-length': stat.size,
    'cache-control': 'public, max-age=300',
    'content-disposition': `inline; filename="${name}.wav"`,
  });
  return fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/') {
    return sendJson(res, 200, {
      ok: true,
      service: 'matrix-call-audio-bot-test',
      mode: 'standalone-api-test',
      audioDir: AUDIO_DIR,
      endpoints: {
        health: 'GET /health',
        audio: 'GET /audio/:name.wav',
        createJob: 'POST /play',
        jobStatus: 'GET /jobs/:id',
      },
    });
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'matrix-call-audio-bot-test',
      uptime: Math.round(process.uptime()),
      jobs: jobs.size,
      audioDir: AUDIO_DIR,
      now: new Date().toISOString(),
    });
  }

  if (req.method === 'GET' && url.pathname === '/audio/test.wav') {
    const wav = makeTestWav();
    res.writeHead(200, {
      'content-type': 'audio/wav',
      'content-length': wav.length,
      'cache-control': 'public, max-age=300',
      'content-disposition': 'inline; filename="test.wav"',
    });
    return res.end(wav);
  }

  if (req.method === 'GET' && url.pathname.startsWith('/audio/') && url.pathname.endsWith('.wav')) {
    const rawName = decodeURIComponent(url.pathname.slice('/audio/'.length, -'.wav'.length));
    const name = normalizeAudioName(rawName);
    if (!name) return sendJson(res, 400, { ok: false, error: 'invalid audio name' });
    return serveWavFile(res, name);
  }

  if (req.method === 'POST' && url.pathname === '/play') {
    if (!authorized(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    try {
      const body = await readJson(req);
      const audio = normalizeAudioName(body.audio || 'test');
      const repeat = Math.max(1, Math.min(10, Number(body.repeat || 1)));
      if (!audio) return sendJson(res, 400, { ok: false, error: 'invalid audio name' });

      if (audio !== 'test') {
        const file = audioFilePath(audio);
        try {
          if (!fs.statSync(file).isFile()) throw new Error('not a file');
        } catch {
          return sendJson(res, 404, { ok: false, error: `audio not found: ${audio}.wav` });
        }
      }

      const id = crypto.randomUUID();
      const now = Date.now();
      const job = {
        id,
        status: 'audio_ready',
        audio,
        repeat,
        createdAt: now,
        updatedAt: now,
        note: 'Audio file validated and ready. Matrix/LiveKit playback is not connected yet.',
      };
      jobs.set(id, job);

      console.log(JSON.stringify({ event: 'play-job-created', id, audio, repeat, at: new Date(now).toISOString() }));
      return sendJson(res, 202, {
        ok: true,
        accepted: true,
        job,
        audioUrl: `${requestOrigin(req)}/audio/${audio}.wav`,
        statusUrl: `${requestOrigin(req)}/jobs/${id}`,
      });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: String(e.message || e) });
    }
  }

  if (req.method === 'GET' && url.pathname.startsWith('/jobs/')) {
    const id = decodeURIComponent(url.pathname.slice('/jobs/'.length));
    const job = jobs.get(id);
    if (!job) return sendJson(res, 404, { ok: false, error: 'job not found' });
    return sendJson(res, 200, { ok: true, job });
  }

  return sendJson(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`matrix-call-audio-bot-test listening on 0.0.0.0:${PORT}`);
  console.log(`audio directory: ${AUDIO_DIR}`);
});
