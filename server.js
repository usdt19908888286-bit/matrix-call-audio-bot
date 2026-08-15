const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const SECRET = String(process.env.AUDIO_BOT_SECRET || '').trim();
const AUDIO_DIR = String(process.env.AUDIO_DIR || '/app/audio');
const MATRIX_HOMESERVER = String(process.env.MATRIX_HOMESERVER || '').replace(/\/$/, '');
const MATRIX_USER_ID = String(process.env.MATRIX_USER_ID || '').trim();
const MATRIX_PASSWORD = String(process.env.MATRIX_PASSWORD || '');
const MATRIX_ACCESS_TOKEN = String(process.env.MATRIX_ACCESS_TOKEN || '').trim();
const MATRIX_DEVICE_ID = String(process.env.MATRIX_DEVICE_ID || 'AUDIOBOT01').trim() || 'AUDIOBOT01';
const MATRIX_RTC_SLOT_ID = String(process.env.MATRIX_RTC_SLOT_ID || 'm.call#ROOM').trim() || 'm.call#ROOM';
const MATRIX_RTC_MEMBER_ID = String(process.env.MATRIX_RTC_MEMBER_ID || '').trim() || `${MATRIX_DEVICE_ID}-${crypto.randomUUID()}`;

const jobs = new Map();
let matrixSession = null;

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

function matrixConfigured() {
  return Boolean(MATRIX_HOMESERVER && MATRIX_USER_ID && (MATRIX_ACCESS_TOKEN || MATRIX_PASSWORD));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = {};
  if (text) {
    try { body = JSON.parse(text); }
    catch { body = { raw: text }; }
  }
  if (!response.ok) {
    const message = body?.error || body?.errcode || body?.raw || `HTTP ${response.status}`;
    const error = new Error(`${message} (HTTP ${response.status})`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function matrixRequest(method, pathname, body, accessToken) {
  if (!MATRIX_HOMESERVER) throw new Error('MATRIX_HOMESERVER is not configured');
  const headers = { accept: 'application/json' };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const options = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  return fetchJson(`${MATRIX_HOMESERVER}${pathname}`, options);
}

async function ensureMatrixSession() {
  if (!matrixConfigured()) {
    throw new Error('Matrix is not configured. Set MATRIX_HOMESERVER, MATRIX_USER_ID and MATRIX_PASSWORD or MATRIX_ACCESS_TOKEN.');
  }

  if (matrixSession?.accessToken) {
    try {
      const who = await matrixRequest('GET', '/_matrix/client/v3/account/whoami', undefined, matrixSession.accessToken);
      if (who.user_id) {
        matrixSession.userId = who.user_id;
        matrixSession.deviceId = who.device_id || matrixSession.deviceId || MATRIX_DEVICE_ID;
        return matrixSession;
      }
    } catch {
      matrixSession = null;
    }
  }

  if (MATRIX_ACCESS_TOKEN) {
    const who = await matrixRequest('GET', '/_matrix/client/v3/account/whoami', undefined, MATRIX_ACCESS_TOKEN);
    matrixSession = {
      accessToken: MATRIX_ACCESS_TOKEN,
      userId: who.user_id || MATRIX_USER_ID,
      deviceId: who.device_id || MATRIX_DEVICE_ID,
      source: 'access_token',
      loggedInAt: Date.now(),
    };
    return matrixSession;
  }

  const login = await matrixRequest('POST', '/_matrix/client/v3/login', {
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user: MATRIX_USER_ID },
    password: MATRIX_PASSWORD,
    device_id: MATRIX_DEVICE_ID,
    initial_device_display_name: 'Matrix Audio Bot',
  });

  if (!login.access_token) throw new Error('Matrix login succeeded without access_token');

  matrixSession = {
    accessToken: login.access_token,
    userId: login.user_id || MATRIX_USER_ID,
    deviceId: login.device_id || MATRIX_DEVICE_ID,
    source: 'password_login',
    loggedInAt: Date.now(),
  };
  return matrixSession;
}

function matrixServerName(userId) {
  const text = String(userId || '');
  const pos = text.indexOf(':');
  if (pos >= 0 && pos + 1 < text.length) return text.slice(pos + 1);
  return MATRIX_HOMESERVER.replace(/^https?:\/\//, '').split('/')[0];
}

async function discoverMatrixRtcFocus(userId) {
  const serverName = matrixServerName(userId);
  const wellKnown = await fetchJson(`https://${serverName}/.well-known/matrix/client`, {
    headers: { accept: 'application/json' },
  });

  const foci = wellKnown['m.rtc_foci'] || wellKnown['org.matrix.msc4143.rtc_foci'] || [];
  if (!Array.isArray(foci) || !foci.length) {
    throw new Error('No MatrixRTC focus found in .well-known/matrix/client');
  }

  const focus = foci.find((item) => item?.type === 'livekit') || foci[0];
  if (!focus?.livekit_service_url) throw new Error('MatrixRTC focus has no livekit_service_url');
  return { serverName, focus, foci };
}

async function matrixRoomMembership(session, roomId) {
  const room = encodeURIComponent(roomId);
  const user = encodeURIComponent(session.userId);
  return matrixRequest(
    'GET',
    `/_matrix/client/v3/rooms/${room}/state/m.room.member/${user}`,
    undefined,
    session.accessToken,
  );
}

async function matrixPendingInvites(session) {
  const data = await matrixRequest('GET', '/_matrix/client/v3/sync?timeout=0', undefined, session.accessToken);
  const invite = data?.rooms?.invite;
  return invite && typeof invite === 'object' ? Object.keys(invite) : [];
}

async function matrixJoinRoom(session, roomId) {
  return matrixRequest(
    'POST',
    `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
    {},
    session.accessToken,
  );
}

async function matrixAutoJoinInvites(session) {
  const inviteRoomIds = await matrixPendingInvites(session);
  const joined = [];
  const failed = [];

  for (const roomId of inviteRoomIds) {
    try {
      const result = await matrixJoinRoom(session, roomId);
      joined.push(result.room_id || roomId);
    } catch (e) {
      failed.push({ roomId, error: String(e.message || e) });
    }
  }

  return { invited: inviteRoomIds.length, joined, failed };
}

async function matrixJoinedRooms(session) {
  const data = await matrixRequest('GET', '/_matrix/client/v3/joined_rooms', undefined, session.accessToken);
  return Array.isArray(data.joined_rooms) ? data.joined_rooms : [];
}

async function matrixRoomState(session, roomId) {
  const room = encodeURIComponent(roomId);
  const state = await matrixRequest('GET', `/_matrix/client/v3/rooms/${room}/state`, undefined, session.accessToken);
  return Array.isArray(state) ? state : [];
}

async function matrixJoinedMembers(session, roomId) {
  const room = encodeURIComponent(roomId);
  const data = await matrixRequest('GET', `/_matrix/client/v3/rooms/${room}/joined_members`, undefined, session.accessToken);
  return data && typeof data.joined === 'object' && data.joined ? data.joined : {};
}

function activeRtcEvents(state) {
  const now = Date.now();
  return state.filter((event) => {
    if (!event || !['org.matrix.msc3401.call.member', 'm.call.member'].includes(event.type)) return false;
    const content = event.content;
    if (!content || typeof content !== 'object' || !Object.keys(content).length) return false;
    if (content.application && content.application !== 'm.call') return false;
    const expires = Number(content.expires || 0);
    const origin = Number(event.origin_server_ts || 0);
    if (expires > 0 && origin > 0 && origin + expires < now) return false;
    return Boolean(content.focus_active || content.foci_preferred || content.membershipID || content.device_id);
  });
}

async function matrixRoomSummary(session, roomId, includeMembers = false) {
  const state = await matrixRoomState(session, roomId);
  const nameEvent = state.find((e) => e?.type === 'm.room.name' && e?.content?.name);
  const aliasEvent = state.find((e) => e?.type === 'm.room.canonical_alias' && e?.content?.alias);
  const rtcEvents = activeRtcEvents(state);
  const summary = {
    roomId,
    name: nameEvent?.content?.name || '',
    alias: aliasEvent?.content?.alias || '',
    rtcActive: rtcEvents.length > 0,
    rtcMemberCount: rtcEvents.length,
  };

  if (includeMembers) {
    const joined = await matrixJoinedMembers(session, roomId);
    summary.joinedMemberCount = Object.keys(joined).length;
    summary.joinedUserIds = Object.keys(joined);
  }
  return summary;
}

async function discoverJoinedRoom(session, { roomId = '', targetUserId = '' } = {}) {
  const explicit = String(roomId || '').trim();
  if (explicit) {
    if (!explicit.startsWith('!') || !explicit.includes(':')) {
      const error = new Error('invalid Matrix roomId');
      error.status = 400;
      throw error;
    }
    await matrixRoomMembership(session, explicit);
    return { roomId: explicit, selectedBy: 'explicit_room_id', candidates: [] };
  }

  const joinedRooms = await matrixJoinedRooms(session);
  if (!joinedRooms.length) {
    const error = new Error('audio-bot has not joined any Matrix rooms');
    error.status = 409;
    throw error;
  }

  const target = String(targetUserId || '').trim();
  const summaries = [];
  for (const id of joinedRooms) {
    try {
      summaries.push(await matrixRoomSummary(session, id, Boolean(target)));
    } catch (e) {
      summaries.push({ roomId: id, error: String(e.message || e), rtcActive: false, rtcMemberCount: 0 });
    }
  }

  if (target) {
    const matches = summaries.filter((r) => Array.isArray(r.joinedUserIds) && r.joinedUserIds.includes(target));
    if (matches.length === 1) return { roomId: matches[0].roomId, selectedBy: 'target_user', candidates: summaries };
    if (matches.length > 1) {
      const activeMatches = matches.filter((r) => r.rtcActive);
      if (activeMatches.length === 1) return { roomId: activeMatches[0].roomId, selectedBy: 'target_user_active_rtc', candidates: summaries };
      const error = new Error(`multiple joined rooms contain target user ${target}`);
      error.status = 409;
      error.candidates = matches;
      throw error;
    }
  }

  const active = summaries.filter((r) => r.rtcActive);
  if (active.length === 1) return { roomId: active[0].roomId, selectedBy: 'active_rtc_room', candidates: summaries };
  if (active.length > 1) {
    const error = new Error('multiple active MatrixRTC rooms found');
    error.status = 409;
    error.candidates = active;
    throw error;
  }

  if (summaries.length === 1) return { roomId: summaries[0].roomId, selectedBy: 'only_joined_room', candidates: summaries };

  const error = new Error('unable to choose one Matrix room automatically; no active RTC room was found');
  error.status = 409;
  error.candidates = summaries;
  throw error;
}

async function requestMatrixOpenId(session) {
  const user = encodeURIComponent(session.userId);
  return matrixRequest(
    'POST',
    `/_matrix/client/v3/user/${user}/openid/request_token`,
    {},
    session.accessToken,
  );
}

async function matrixRtcJwtHealth(focus) {
  const base = String(focus.livekit_service_url || '').replace(/\/$/, '');
  if (!base) return { ok: false, error: 'missing livekit_service_url' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${base}/healthz`, { method: 'GET', signal: controller.signal });
    return { ok: response.ok, status: response.status };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function requestModernLiveKitToken(focus, session, roomId, openId, options = {}) {
  const base = String(focus.livekit_service_url || '').replace(/\/$/, '');
  if (!base) throw new Error('missing livekit_service_url');

  const slotId = String(options.slotId || MATRIX_RTC_SLOT_ID).trim() || MATRIX_RTC_SLOT_ID;
  const memberId = String(options.memberId || MATRIX_RTC_MEMBER_ID).trim() || MATRIX_RTC_MEMBER_ID;

  const response = await fetchJson(`${base}/get_token`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      room_id: roomId,
      slot_id: slotId,
      openid_token: openId,
      member: {
        id: memberId,
        claimed_user_id: session.userId,
        claimed_device_id: session.deviceId,
      },
    }),
  });

  if (!response?.url || !response?.jwt) {
    throw new Error('MatrixRTC authorization service returned no LiveKit url/jwt');
  }

  return {
    url: response.url,
    jwt: response.jwt,
    mode: 'msc4195_get_token',
    slotId,
    memberId,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/') {
    return sendJson(res, 200, {
      ok: true,
      service: 'matrix-call-audio-bot-test',
      mode: 'matrix-rtc-stage-1-auto-room',
      audioDir: AUDIO_DIR,
      endpoints: {
        health: 'GET /health',
        audio: 'GET /audio/:name.wav',
        createJob: 'POST /play',
        jobStatus: 'GET /jobs/:id',
        matrixStatus: 'GET /matrix/status',
        matrixRooms: 'GET /matrix/rooms',
        matrixPrepare: 'POST /matrix/prepare',
        matrixToken: 'POST /matrix/token',
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
      matrixConfigured: matrixConfigured(),
      now: new Date().toISOString(),
    });
  }

  if (req.method === 'GET' && url.pathname === '/matrix/status') {
    if (!authorized(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    try {
      const session = await ensureMatrixSession();
      const autoJoin = await matrixAutoJoinInvites(session);
      const rtc = await discoverMatrixRtcFocus(session.userId);
      const jwtServiceHealth = await matrixRtcJwtHealth(rtc.focus);
      const joinedRooms = await matrixJoinedRooms(session);

      return sendJson(res, 200, {
        ok: true,
        status: 'matrix_connected',
        matrix: {
          homeserver: MATRIX_HOMESERVER,
          userId: session.userId,
          deviceId: session.deviceId,
          authSource: session.source,
          serverName: rtc.serverName,
          joinedRoomCount: joinedRooms.length,
          autoJoin,
        },
        rtc: {
          focus: {
            type: rtc.focus.type,
            livekit_service_url: rtc.focus.livekit_service_url,
          },
          focusCount: rtc.foci.length,
          jwtServiceHealth,
        },
      });
    } catch (e) {
      return sendJson(res, 502, { ok: false, error: String(e.message || e) });
    }
  }

  if (req.method === 'GET' && url.pathname === '/matrix/rooms') {
    if (!authorized(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    try {
      const session = await ensureMatrixSession();
      const autoJoin = await matrixAutoJoinInvites(session);
      const joinedRooms = await matrixJoinedRooms(session);
      const rooms = [];
      for (const roomId of joinedRooms) {
        try {
          rooms.push(await matrixRoomSummary(session, roomId, true));
        } catch (e) {
          rooms.push({ roomId, error: String(e.message || e) });
        }
      }
      return sendJson(res, 200, {
        ok: true,
        autoJoin,
        count: rooms.length,
        rooms,
      });
    } catch (e) {
      return sendJson(res, 502, { ok: false, error: String(e.message || e) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/matrix/prepare') {
    if (!authorized(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    try {
      const body = await readJson(req);
      const session = await ensureMatrixSession();
      const autoJoin = await matrixAutoJoinInvites(session);
      const selected = await discoverJoinedRoom(session, {
        roomId: body.roomId,
        targetUserId: body.targetUserId,
      });
      const membership = await matrixRoomMembership(session, selected.roomId);
      const rtc = await discoverMatrixRtcFocus(session.userId);
      const openId = await requestMatrixOpenId(session);

      return sendJson(res, 200, {
        ok: true,
        status: 'matrix_rtc_ready',
        roomId: selected.roomId,
        selectedBy: selected.selectedBy,
        matrix: {
          userId: session.userId,
          deviceId: session.deviceId,
          membership: membership.membership || null,
        },
        rtc: {
          focus: {
            type: rtc.focus.type,
            livekit_service_url: rtc.focus.livekit_service_url,
          },
        },
        openId: {
          ready: Boolean(openId.access_token),
          expires_in: openId.expires_in,
          matrix_server_name: openId.matrix_server_name,
          token_type: openId.token_type,
        },
        note: 'Room was discovered automatically. Matrix auth, membership, RTC focus discovery and OpenID are ready. LiveKit join is the next stage.',
      });
    } catch (e) {
      return sendJson(res, e.status || 502, {
        ok: false,
        error: String(e.message || e),
        candidates: e.candidates || undefined,
      });
    }
  }

  if (req.method === 'POST' && url.pathname === '/matrix/token') {
    if (!authorized(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    try {
      const body = await readJson(req);
      const session = await ensureMatrixSession();
      const autoJoin = await matrixAutoJoinInvites(session);
      const selected = await discoverJoinedRoom(session, {
        roomId: body.roomId,
        targetUserId: body.targetUserId,
      });
      const membership = await matrixRoomMembership(session, selected.roomId);
      const rtc = await discoverMatrixRtcFocus(session.userId);
      const openId = await requestMatrixOpenId(session);
      const livekit = await requestModernLiveKitToken(rtc.focus, session, selected.roomId, openId, {
        slotId: body.slotId,
        memberId: body.memberId,
      });

      return sendJson(res, 200, {
        ok: true,
        status: 'livekit_token_ready',
        roomId: selected.roomId,
        selectedBy: selected.selectedBy,
        autoJoin,
        matrix: {
          userId: session.userId,
          deviceId: session.deviceId,
          membership: membership.membership || null,
        },
        rtc: {
          authorizationService: rtc.focus.livekit_service_url,
          mode: livekit.mode,
          livekitUrl: livekit.url,
          jwtReady: true,
          jwtLength: livekit.jwt.length,
          slotId: livekit.slotId,
          memberId: livekit.memberId,
        },
        note: 'MSC4195 /get_token succeeded with a device-aware participant identity. The next stage is connecting the Node client to LiveKit.',
      });
    } catch (e) {
      return sendJson(res, e.status || 502, {
        ok: false,
        error: String(e.message || e),
        candidates: e.candidates || undefined,
        details: e.body || undefined,
      });
    }
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
        note: 'Audio file validated and ready. MatrixRTC room auto-discovery is available through /matrix/prepare.',
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
  console.log(`matrix configured: ${matrixConfigured() ? 'yes' : 'no'}`);
});