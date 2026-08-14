const http = require('http');

const PORT = Number(process.env.PORT || 8080);
const SECRET = String(process.env.AUDIO_BOT_SECRET || '').trim();

function send(res, status, body) {
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
    req.on('data', chunk => {
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/') {
    return send(res, 200, {
      ok: true,
      service: 'matrix-call-audio-bot-test',
      mode: 'http-smoke-test',
      endpoints: ['/health', '/play'],
    });
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, {
      ok: true,
      service: 'matrix-call-audio-bot-test',
      uptime: Math.round(process.uptime()),
      now: new Date().toISOString(),
    });
  }

  if (req.method === 'POST' && url.pathname === '/play') {
    if (!authorized(req)) return send(res, 401, { ok: false, error: 'unauthorized' });
    try {
      const body = await readJson(req);
      const text = String(body.text || 'Back4app audio bot test').trim();
      const roomId = String(body.roomId || '').trim();
      console.log(JSON.stringify({ event: 'play-test', text, roomId, at: new Date().toISOString() }));
      return send(res, 200, {
        ok: true,
        accepted: true,
        text,
        roomId,
        message: 'Back4app container received the test task. Audio playback is not enabled in this smoke-test build yet.',
      });
    } catch (e) {
      return send(res, 400, { ok: false, error: String(e.message || e) });
    }
  }

  send(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`matrix-call-audio-bot-test listening on 0.0.0.0:${PORT}`);
});
