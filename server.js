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
const MATRIX_DEVICE_ID_PREFIX = String(process.env.MATRIX_DEVICE_ID || 'AUDIOBOT01').trim() || 'AUDIOBOT01';
const MATRIX_LOGIN_DEVICE_ID = `${MATRIX_DEVICE_ID_PREFIX}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
const MATRIX_RTC_SLOT_ID = String(process.env.MATRIX_RTC_SLOT_ID || 'm.call#ROOM').trim() || 'm.call#ROOM';
const MATRIX_RTC_MEMBER_ID_OVERRIDE = String(process.env.MATRIX_RTC_MEMBER_ID || '').trim();
const MATRIXRTC_E2EE_RATCHET_SALT = new TextEncoder().encode('LKFrameEncryptionKey');
const MATRIXRTC_E2EE_RATCHET_WINDOW_SIZE = 10;
const MATRIXRTC_E2EE_FAILURE_TOLERANCE = 10;
const MATRIXRTC_E2EE_KEY_RING_SIZE = 256;
const MATRIXRTC_E2EE_KDF_HKDF = 1; // livekit.proto.KeyDerivationFunction.HKDF
const MATRIX_RTC_SAFETY_TIMEOUT_RAW = Number(process.env.MATRIX_RTC_SAFETY_TIMEOUT_MS || 120000);
const MATRIX_RTC_SAFETY_TIMEOUT_MS = Number.isFinite(MATRIX_RTC_SAFETY_TIMEOUT_RAW)
  ? Math.max(0, Math.round(MATRIX_RTC_SAFETY_TIMEOUT_RAW))
  : 120000;

const jobs = new Map();
let matrixSession = null;
let matrixLoginSuspended = false;
const liveKitConnections = new Map();
const liveKitDisconnectTimers = new Map();
let liveKitModulePromise = null;
let matrixJsSdkPromise = null;
let matrixRtcModulePromise = null;
let matrixRtcClientPromise = null;
const matrixRtcContexts = new Map();
const matrixRtcMemberIds = new Map();
const simpleOneToOneCalls = new Map();

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
  return Boolean(MATRIX_HOMESERVER && MATRIX_USER_ID && MATRIX_PASSWORD);
}

function clearLiveKitSafetyDisconnect(roomId) {
  const timer = liveKitDisconnectTimers.get(roomId);
  if (timer) clearTimeout(timer);
  liveKitDisconnectTimers.delete(roomId);
}

function scheduleLiveKitSafetyDisconnect(roomId) {
  clearLiveKitSafetyDisconnect(roomId);
  if (!MATRIX_RTC_SAFETY_TIMEOUT_MS) return;
  const timer = setTimeout(() => {
    console.warn(`[MatrixRTC] safety timeout reached; disconnecting room=${roomId}`);
    disconnectLiveKitRoom(roomId).catch((error) => {
      console.warn(`[MatrixRTC] safety disconnect failed room=${roomId}: ${error?.message || error}`);
    });
  }, MATRIX_RTC_SAFETY_TIMEOUT_MS);
  timer.unref?.();
  liveKitDisconnectTimers.set(roomId, timer);
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
  if (matrixLoginSuspended) {
    const error = new Error('Matrix login is suspended. Call POST /matrix/login to resume.');
    error.status = 409;
    throw error;
  }
  if (!matrixConfigured()) {
    throw new Error('Matrix is not configured. Set MATRIX_HOMESERVER, MATRIX_USER_ID and MATRIX_PASSWORD.');
  }

  if (matrixSession?.accessToken) {
    try {
      const who = await matrixRequest('GET', '/_matrix/client/v3/account/whoami', undefined, matrixSession.accessToken);
      if (who.user_id) {
        matrixSession.userId = who.user_id;
        matrixSession.deviceId = who.device_id || matrixSession.deviceId || MATRIX_LOGIN_DEVICE_ID;
        return matrixSession;
      }
    } catch {
      matrixSession = null;
    }
  }

  const login = await matrixRequest('POST', '/_matrix/client/v3/login', {
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user: MATRIX_USER_ID },
    password: MATRIX_PASSWORD,
    device_id: MATRIX_LOGIN_DEVICE_ID,
    initial_device_display_name: 'Matrix Audio Bot',
  });

  if (!login.access_token) throw new Error('Matrix login succeeded without access_token');

  matrixSession = {
    accessToken: login.access_token,
    userId: login.user_id || MATRIX_USER_ID,
    deviceId: login.device_id || MATRIX_LOGIN_DEVICE_ID,
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

function matrixRtcSlotDescription() {
  const separator = MATRIX_RTC_SLOT_ID.indexOf('#');
  if (separator <= 0 || separator === MATRIX_RTC_SLOT_ID.length - 1) {
    throw new Error(`invalid MATRIX_RTC_SLOT_ID: ${MATRIX_RTC_SLOT_ID}`);
  }
  return {
    application: MATRIX_RTC_SLOT_ID.slice(0, separator),
    id: MATRIX_RTC_SLOT_ID.slice(separator + 1),
  };
}

function matrixRtcMemberId(session) {
  if (MATRIX_RTC_MEMBER_ID_OVERRIDE) return MATRIX_RTC_MEMBER_ID_OVERRIDE;
  const key = `${session.userId}|${session.deviceId}`;
  let memberId = matrixRtcMemberIds.get(key);
  if (!memberId) {
    memberId = `${session.deviceId}-${crypto.randomUUID()}`;
    matrixRtcMemberIds.set(key, memberId);
  }
  return memberId;
}

async function discoverMatrixRtcTransport(session) {
  const data = await matrixRequest(
    'GET',
    '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports',
    undefined,
    session.accessToken,
  );
  const transports = Array.isArray(data?.rtc_transports) ? data.rtc_transports : [];
  if (!transports.length) {
    const error = new Error('No MatrixRTC transports returned by MSC4143 /rtc/transports');
    error.status = 409;
    throw error;
  }

  const transport = transports.find((item) => item?.type === 'livekit');
  if (!transport?.livekit_service_url) {
    const error = new Error('Latest MatrixRTC transport discovery returned no LiveKit transport');
    error.status = 409;
    throw error;
  }

  return {
    serverName: matrixServerName(session.userId),
    transport,
    transports,
    discovery: 'msc4143_rtc_transports',
  };
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

async function matrixRecentRtcNotifications(session, roomId, limit = 20) {
  const room = encodeURIComponent(roomId);
  const data = await matrixRequest(
    'GET',
    `/_matrix/client/v3/rooms/${room}/messages?dir=b&limit=${Math.max(1, Math.min(100, Number(limit) || 20))}`,
    undefined,
    session.accessToken,
  );
  const chunk = Array.isArray(data?.chunk) ? data.chunk : [];
  return chunk
    .filter((event) => event?.type === 'org.matrix.msc4075.rtc.notification')
    .map((event) => ({
      eventId: event.event_id || '',
      sender: event.sender || '',
      originServerTs: Number(event.origin_server_ts || 0) || null,
      senderTs: Number(event?.content?.sender_ts || 0) || null,
      ageMs: Number(event?.content?.sender_ts || event.origin_server_ts || 0)
        ? Math.max(0, Date.now() - Number(event?.content?.sender_ts || event.origin_server_ts || 0))
        : null,
      notificationType: event?.content?.notification_type || '',
      intent: event?.content?.['m.call.intent'] || '',
      lifetime: Number(event?.content?.lifetime || 0) || null,
      relatesToEventId: event?.content?.['m.relates_to']?.event_id || '',
    }));
}

async function matrixJoinedMembers(session, roomId) {
  const room = encodeURIComponent(roomId);
  const data = await matrixRequest('GET', `/_matrix/client/v3/rooms/${room}/joined_members`, undefined, session.accessToken);
  return data && typeof data.joined === 'object' && data.joined ? data.joined : {};
}

async function activeRtcEvents(session, roomId) {
  const client = await ensureMatrixRtcClient(session);
  const room = client.getRoom(roomId);
  if (!room || typeof room._unstable_getStickyEvents !== 'function') return [];

  return Array.from(room._unstable_getStickyEvents()).filter((event) => {
    if (event?.getType?.() !== 'org.matrix.msc4143.rtc.member') return false;
    const content = event.getContent?.() || {};
    if (content.slot_id !== MATRIX_RTC_SLOT_ID) return false;
    if (content?.application?.type !== 'm.call') return false;
    if (!content?.member?.user_id || !content?.member?.device_id || !content?.member?.id) return false;
    return true;
  });
}

async function clearStaleOwnRtcMemberships(session, roomId, keepMemberId = '') {
  const client = await ensureMatrixRtcClient(session);
  const cleared = [];

  // Clear stale MSC4143/MSC4354 sticky memberships left by older audio-bot processes.
  const stickyEvents = await activeRtcEvents(session, roomId);
  for (const event of stickyEvents) {
    const content = event?.getContent?.() || {};
    const member = content?.member || {};
    const memberId = String(member.id || '');
    if (member.user_id !== session.userId || !memberId || memberId === keepMemberId) continue;
    try {
      await client._unstable_sendStickyEvent(
        roomId,
        60 * 60 * 1000,
        null,
        'org.matrix.msc4143.rtc.member',
        { msc4354_sticky_key: memberId },
      );
      cleared.push({ type: 'sticky', memberId, deviceId: member.device_id || '' });
      console.log(`[MatrixRTC] cleared stale sticky membership room=${roomId} member=${memberId}`);
    } catch (error) {
      console.warn(`[MatrixRTC] failed clearing stale sticky membership room=${roomId} member=${memberId}: ${error?.message || error}`);
    }
  }

  // Clear legacy m.call.member state left by an older implementation too.
  // These are the classic long-lived memberships that can make a fresh ring
  // look like it has already been running for several hours.
  const state = await matrixRoomState(session, roomId);
  for (const event of state) {
    if (event?.type !== 'org.matrix.msc3401.call.member') continue;
    if (event?.sender !== session.userId) continue;
    const content = event?.content || {};
    if (!Object.keys(content).length || content.application !== 'm.call') continue;
    const stateKey = String(event.state_key || '');
    if (!stateKey) continue;
    try {
      await matrixRequest(
        'PUT',
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/org.matrix.msc3401.call.member/${encodeURIComponent(stateKey)}`,
        {},
        session.accessToken,
      );
      cleared.push({
        type: 'legacy',
        stateKey,
        memberId: content.membershipID || '',
        deviceId: content.device_id || '',
      });
      console.log(`[MatrixRTC] cleared stale legacy membership room=${roomId} stateKey=${stateKey}`);
    } catch (error) {
      console.warn(`[MatrixRTC] failed clearing stale legacy membership room=${roomId} stateKey=${stateKey}: ${error?.message || error}`);
    }
  }

  return cleared;
}

async function matrixRoomSummary(session, roomId, includeMembers = false) {
  const state = await matrixRoomState(session, roomId);
  const nameEvent = state.find((e) => e?.type === 'm.room.name' && e?.content?.name);
  const aliasEvent = state.find((e) => e?.type === 'm.room.canonical_alias' && e?.content?.alias);
  const rtcEvents = await activeRtcEvents(session, roomId);
  const recentRtcNotifications = await matrixRecentRtcNotifications(session, roomId, 50).catch(() => []);
  const stickyRtcMembers = rtcEvents.map((event) => {
    const content = event?.getContent?.() || {};
    return {
      type: 'org.matrix.msc4143.rtc.member',
      userId: content?.member?.user_id || event?.getSender?.() || '',
      deviceId: content?.member?.device_id || '',
      memberId: content?.member?.id || '',
      slotId: content?.slot_id || '',
      intent: content?.application?.['m.call.intent'] || '',
      eventId: event?.getId?.() || '',
      timestamp: event?.getTs?.() || null,
    };
  });
  const now = Date.now();
  const legacyRtcMembers = state
    .filter((event) => event?.type === 'org.matrix.msc3401.call.member' && event?.content && Object.keys(event.content).length > 0)
    .map((event) => {
      const content = event.content || {};
      const createdTs = Number(content.created_ts || event.origin_server_ts || 0) || 0;
      const expires = Number(content.expires || 0) || 0;
      const expiresAt = createdTs && expires ? createdTs + expires : 0;
      return {
        type: 'org.matrix.msc3401.call.member',
        userId: event.sender || '',
        deviceId: content.device_id || '',
        memberId: content.membershipID || '',
        callId: content.call_id ?? null,
        intent: content['m.call.intent'] || '',
        stateKey: event.state_key || '',
        eventId: event.event_id || '',
        createdTs: createdTs || null,
        ageMs: createdTs ? Math.max(0, now - createdTs) : null,
        expires,
        expiresAt: expiresAt || null,
        expired: expiresAt ? expiresAt <= now : null,
      };
    });
  const summary = {
    roomId,
    name: nameEvent?.content?.name || '',
    alias: aliasEvent?.content?.alias || '',
    rtcActive: stickyRtcMembers.length > 0 || legacyRtcMembers.some((member) => member.expired !== true),
    rtcMemberCount: stickyRtcMembers.length,
    stickyRtcMembers,
    legacyRtcMembers,
    recentRtcNotifications,
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

async function requireLatestMatrixRtcServerFeatures(session) {
  const versions = await matrixRequest('GET', '/_matrix/client/versions', undefined, session.accessToken);
  const unstable = versions?.unstable_features && typeof versions.unstable_features === 'object'
    ? versions.unstable_features
    : {};
  const capabilities = {
    msc4140DelayedEvents: unstable['org.matrix.msc4140'] === true,
    msc4143MatrixRtc: unstable['org.matrix.msc4143'] === true,
    msc4354StickyEvents: unstable['org.matrix.msc4354'] === true,
  };
  const missing = [];
  if (!capabilities.msc4140DelayedEvents) missing.push('MSC4140 delayed events');
  if (!capabilities.msc4143MatrixRtc) missing.push('MSC4143 MatrixRTC transports');
  if (!capabilities.msc4354StickyEvents) missing.push('MSC4354 sticky events');
  if (missing.length) {
    const error = new Error(`Latest MatrixRTC server features are missing: ${missing.join(', ')}`);
    error.status = 409;
    error.capabilities = capabilities;
    throw error;
  }
  return capabilities;
}

async function matrixRtcJwtHealth(transport) {
  const base = String(transport.livekit_service_url || '').replace(/\/$/, '');
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

async function requestLatestLiveKitToken(transport, session, roomId, openId, options = {}) {
  const base = String(transport.livekit_service_url || '').replace(/\/$/, '');
  if (!base) throw new Error('missing livekit_service_url');

  const slotId = String(options.slotId || MATRIX_RTC_SLOT_ID).trim() || MATRIX_RTC_SLOT_ID;
  const defaultMemberId = matrixRtcMemberId(session);
  const memberId = String(options.memberId || defaultMemberId).trim() || defaultMemberId;

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

async function requestLegacyLiveKitToken(transport, session, roomId, openId, options = {}) {
  // Keep the simple 1:1 call on the same proven media authorization path as
  // web_call/src/viewer.js. That caller uses getRoomSession()/joinRoomSession()
  // and the legacy /sfu/get endpoint, whose LiveKit participant identity
  // matches MatrixRTC's rtcBackendIdentity (userId:deviceId). Mixing this
  // signaling path with MSC4195 /get_token produces a hashed LiveKit identity
  // and breaks per-participant E2EE.
  const base = String(transport.livekit_service_url || '').replace(/\/$/, '');
  if (!base) throw new Error('missing livekit_service_url');

  const response = await fetchJson(`${base}/sfu/get`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      room: roomId,
      openid_token: openId,
      device_id: session.deviceId,
    }),
  });

  if (!response?.url || !response?.jwt) {
    throw new Error('Legacy MatrixRTC authorization service returned no LiveKit url/jwt');
  }

  return {
    url: response.url,
    jwt: response.jwt,
    mode: 'legacy_sfu_get',
    slotId: MATRIX_RTC_SLOT_ID,
    memberId: String(options.memberId || matrixRtcMemberId(session)),
  };
}

async function loadLiveKitRtc() {
  if (!liveKitModulePromise) {
    liveKitModulePromise = import('@livekit/rtc-node').catch((error) => {
      liveKitModulePromise = null;
      throw error;
    });
  }
  return liveKitModulePromise;
}

async function loadMatrixRtcSdk() {
  if (!matrixJsSdkPromise) {
    matrixJsSdkPromise = import('matrix-js-sdk').catch((error) => {
      matrixJsSdkPromise = null;
      throw error;
    });
  }
  if (!matrixRtcModulePromise) {
    matrixRtcModulePromise = import('matrix-js-sdk/lib/matrixrtc/index.js').catch((error) => {
      matrixRtcModulePromise = null;
      throw error;
    });
  }
  const [sdk, rtc] = await Promise.all([matrixJsSdkPromise, matrixRtcModulePromise]);
  return { sdk, rtc };
}

async function waitForMatrixPrepared(client, sdk, timeoutMs = 20000) {
  const current = client.getSyncState?.();
  if (current === 'PREPARED' || current === 'SYNCING') return current;

  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      client.off(sdk.ClientEvent.Sync, onSync);
    };
    const onSync = (state) => {
      if (state === 'PREPARED' || state === 'SYNCING') {
        cleanup();
        resolve(state);
      } else if (state === 'ERROR') {
        cleanup();
        reject(new Error('Matrix sync entered ERROR state'));
      }
    };
    client.on(sdk.ClientEvent.Sync, onSync);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Matrix sync did not become ready within ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

async function ensureMatrixRtcClient(session) {
  if (session.source !== 'password_login') {
    const error = new Error('Latest MatrixRTC E2EE mode requires password login so this process can own a fresh Matrix device for the in-memory Rust crypto store');
    error.status = 409;
    throw error;
  }
  if (!matrixRtcClientPromise) {
    matrixRtcClientPromise = (async () => {
      const { sdk } = await loadMatrixRtcSdk();
      const client = sdk.createClient({
        baseUrl: MATRIX_HOMESERVER,
        accessToken: session.accessToken,
        userId: session.userId,
        deviceId: session.deviceId,
      });

      console.log('[MatrixRTC] initializing Rust Crypto for AUDIOBOT device');
      await client.initRustCrypto({ useIndexedDB: false });
      client.startClient({ initialSyncLimit: 20 });
      await waitForMatrixPrepared(client, sdk);
      console.log(`[MatrixRTC] sync ready user=${session.userId} device=${session.deviceId}`);
      return client;
    })().catch((error) => {
      matrixRtcClientPromise = null;
      throw error;
    });
  }
  return matrixRtcClientPromise;
}

function applyLiveKitOutboundKey(roomId, key, keyIndex, rtcBackendIdentity) {
  const connection = liveKitConnections.get(roomId);
  const manager = connection?.room?.e2eeManager;
  const provider = manager?.keyProvider;
  if (!manager || !provider || typeof provider.setKey !== 'function') return false;

  const raw = key instanceof Uint8Array ? key : new Uint8Array(key);
  const localIdentity = connection.room.localParticipant?.identity || '';
  const participantIdentity = String(rtcBackendIdentity || localIdentity || '').trim();
  if (!participantIdentity) return false;

  // Match the known-good browser implementation in web_call/src/viewer.js:
  // MatrixRTC media keys are per participant (rtcBackendIdentity), not a room
  // shared key. patch-livekit-node-e2ee.cjs restores the raw key parameter that
  // rtc-node's JS wrapper currently omits from KeyProvider.setKey().
  provider.setKey(participantIdentity, raw, keyIndex);

  if (localIdentity && rtcBackendIdentity && localIdentity !== rtcBackendIdentity) {
    console.warn(`[E2EE] LiveKit identity mismatch local=${localIdentity} matrix=${rtcBackendIdentity}`);
  }

  let exportedKeyMatches = null;
  let exportedKeyBytes = null;
  let exportError = '';
  if (typeof provider.exportKey === 'function') {
    try {
      const exported = provider.exportKey(participantIdentity, keyIndex);
      exportedKeyBytes = exported?.length ?? 0;
      exportedKeyMatches = Buffer.from(exported || []).equals(Buffer.from(raw));
    } catch (error) {
      exportError = String(error?.message || error);
    }
  }

  try { manager.setEnabled(true); } catch {}

  let matchedCryptors = 0;
  const beforeCryptors = (manager.frameCryptors?.() || []).map((cryptor) => ({
    participantIdentity: cryptor.participantIdentity || '',
    enabled: Boolean(cryptor.enabled),
    keyIndex: Number(cryptor.keyIndex ?? -1),
  }));

  for (const cryptor of manager.frameCryptors?.() || []) {
    if (cryptor.participantIdentity === participantIdentity || cryptor.participantIdentity === localIdentity) {
      matchedCryptors += 1;
      try { cryptor.setKeyIndex(keyIndex); } catch {}
      try { cryptor.setEnabled(true); } catch {}
    }
  }

  const afterCryptors = (manager.frameCryptors?.() || []).map((cryptor) => ({
    participantIdentity: cryptor.participantIdentity || '',
    enabled: Boolean(cryptor.enabled),
    keyIndex: Number(cryptor.keyIndex ?? -1),
  }));

  connection.e2eeKeyIndex = keyIndex;
  connection.e2eeRtcBackendIdentity = participantIdentity;
  connection.e2eeKeyUpdatedAt = Date.now();
  connection.e2eeDiagnostics = {
    managerEnabled: Boolean(manager.enabled),
    participantIdentity,
    localIdentity,
    rawKeyBytes: raw.length,
    exportedKeyBytes,
    exportedKeyMatches,
    exportError: exportError || undefined,
    matchedCryptors,
    beforeCryptors,
    afterCryptors,
  };

  console.log(`[E2EE] LiveKit participant key applied index=${keyIndex} participant=${participantIdentity} bytes=${raw.length}`);
  console.log(`[E2EE] key roundtrip matches=${exportedKeyMatches} exportedBytes=${exportedKeyBytes ?? 'n/a'} managerEnabled=${Boolean(manager.enabled)}`);
  console.log(`[E2EE] frame cryptors matched=${matchedCryptors} before=${JSON.stringify(beforeCryptors)} after=${JSON.stringify(afterCryptors)}`);
  return true;
}

async function waitForOwnMatrixRtcKey(context, timeoutMs = 15000) {
  if (context.ownKey) return context;
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject };
    context.keyWaiters.add(waiter);
    const timer = setTimeout(() => {
      context.keyWaiters.delete(waiter);
      reject(new Error(`MatrixRTC media key was not received within ${timeoutMs}ms`));
    }, timeoutMs);
    waiter.resolve = (value) => {
      clearTimeout(timer);
      context.keyWaiters.delete(waiter);
      resolve(value);
    };
    waiter.reject = (error) => {
      clearTimeout(timer);
      context.keyWaiters.delete(waiter);
      reject(error);
    };
  });
}

async function ensureMatrixRtcE2ee(session, roomId, transport, joinOptions = {}) {
  let context = matrixRtcContexts.get(roomId);
  if (context?.rtcSession?.isJoined?.() && context.ownKey) return context;

  await requireLatestMatrixRtcServerFeatures(session);
  const client = await ensureMatrixRtcClient(session);
  const { rtc } = await loadMatrixRtcSdk();
  let room = client.getRoom(roomId);
  if (!room) {
    await client.joinRoom(roomId);
    room = client.getRoom(roomId);
  }
  if (!room) throw new Error(`MatrixRTC room is not available in matrix-js-sdk: ${roomId}`);
  const ownMemberId = matrixRtcMemberId(session);

  const staleCleared = await clearStaleOwnRtcMemberships(session, roomId, ownMemberId);
  if (staleCleared.length) {
    console.log(`[MatrixRTC] stale memberships cleared before join room=${roomId} count=${staleCleared.length}`);
  }

  let rtcSession = context?.rtcSession;
  if (!rtcSession || context?.client !== client) {
    rtcSession = rtc.MatrixRTCSession.sessionForSlot(
      client,
      room,
      matrixRtcSlotDescription(),
      {
        listenForStickyEvents: true,
        listenForMemberStateEvents: false,
      },
    );
    await rtcSession.initialMembershipCalculated;

    context = {
      client,
      rtcSession,
      roomId,
      memberId: ownMemberId,
      ownKey: null,
      ownKeyIndex: null,
      ownRtcBackendIdentity: '',
      keyWaiters: new Set(),
      keysSeen: 0,
      joinedAt: null,
    };
    matrixRtcContexts.set(roomId, context);

    rtcSession.on(rtc.MatrixRTCSessionEvent.EncryptionKeyChanged, (key, keyIndex, membership, rtcBackendIdentity) => {
      const raw = key instanceof Uint8Array ? new Uint8Array(key) : new Uint8Array(key || []);
      context.keysSeen += 1;
      const isOwn = membership?.userId === session.userId && membership?.deviceId === session.deviceId;
      console.log(`[E2EE] key index=${keyIndex} participant=${rtcBackendIdentity || '?'} matrix=${membership?.userId || '?'}/${membership?.deviceId || '?'} own=${isOwn}`);

      if (isOwn) {
        context.ownKey = raw;
        context.ownKeyIndex = Number(keyIndex || 0);
        context.ownRtcBackendIdentity = String(rtcBackendIdentity || '');
        applyLiveKitOutboundKey(roomId, raw, context.ownKeyIndex, context.ownRtcBackendIdentity);
        for (const waiter of Array.from(context.keyWaiters)) waiter.resolve(context);
      }
    });

    rtcSession.on(rtc.MatrixRTCSessionEvent.MembershipsChanged, (_oldMemberships, memberships) => {
      const ids = (memberships || []).map((m) => `${m.userId || '?'}/${m.deviceId || '?'}/${m.memberId || '?'}`).join(', ');
      console.log(`[MatrixRTC] sticky memberships=${memberships?.length || 0}${ids ? ` ${ids}` : ''}`);
    });

    rtcSession.on(rtc.MatrixRTCSessionEvent.MembershipManagerError, (error) => {
      const wrapped = error instanceof Error ? error : new Error(String(error || 'MatrixRTC membership manager error'));
      console.error('[MatrixRTC] membership manager error:', wrapped);
      for (const waiter of Array.from(context.keyWaiters)) waiter.reject(wrapped);
    });
  } else {
    await rtcSession.initialMembershipCalculated;
  }

  if (!rtcSession.isJoined?.()) {
    const publishedTransport = {
      type: 'livekit',
      livekit_service_url: transport.livekit_service_url,
    };
    const identity = {
      userId: session.userId,
      deviceId: session.deviceId,
      memberId: ownMemberId,
    };

    rtcSession.joinRTCSession(identity, [], publishedTransport, {
      callIntent: 'audio',
      manageMediaKeys: true,
      unstableSendStickyEvents: true,
      ...joinOptions,
    });
    context.joinedAt = Date.now();
    console.log(`[MatrixRTC] joined MSC4143/MSC4354 sticky membership user=${session.userId} device=${session.deviceId} member=${ownMemberId}`);
  }

  // MatrixRTC's first outbound media key is created from EncryptionManager.onMembershipsUpdate().
  // Do one explicit membership refresh after join so a headless Node client does not have to wait
  // for a later sticky-event update before the initial key rollout starts.
  if (!context.ownKey && typeof rtcSession._onRTCSessionMemberUpdate === 'function') {
    console.log('[MatrixRTC] forcing post-join membership refresh for initial E2EE key rollout');
    await rtcSession._onRTCSessionMemberUpdate();
  }

  try { rtcSession.reemitEncryptionKeys?.(); } catch {}
  await waitForOwnMatrixRtcKey(context);
  return context;
}

function summarizeLiveKitRoom(roomId, connection) {
  const room = connection?.room;
  const local = room?.localParticipant;
  const remoteParticipants = room
    ? Array.from(room.remoteParticipants.values()).map((participant) => ({
        identity: participant.identity,
        sid: participant.sid || null,
        name: participant.name || '',
      }))
    : [];

  return {
    roomId,
    connected: Boolean(room?.isConnected),
    livekitRoomName: room?.name || '',
    localParticipant: local ? {
      identity: local.identity,
      sid: local.sid || null,
      name: local.name || '',
    } : null,
    remoteParticipantCount: remoteParticipants.length,
    remoteParticipants,
    connectedAt: connection?.connectedAt || null,
    memberId: connection?.memberId || null,
    slotId: connection?.slotId || null,
    e2ee: {
      enabled: Boolean(room?.e2eeManager?.enabled),
      keyIndex: connection?.e2eeKeyIndex ?? null,
      rtcBackendIdentity: connection?.e2eeRtcBackendIdentity || '',
      keyUpdatedAt: connection?.e2eeKeyUpdatedAt || null,
    },
  };
}

async function waitForLiveKitRemoteParticipant(roomId, timeoutMs = 45000) {
  const startedAt = Date.now();
  const waitMs = Math.max(0, Math.min(120000, Math.round(Number(timeoutMs) || 0)));

  while (true) {
    const connection = liveKitConnections.get(roomId);
    if (!connection?.room?.isConnected) {
      const error = new Error('LiveKit room disconnected while waiting for remote participant');
      error.status = 409;
      throw error;
    }

    const summary = summarizeLiveKitRoom(roomId, connection);
    if (summary.remoteParticipantCount > 0) {
      return {
        ready: true,
        waitedMs: Date.now() - startedAt,
        remoteParticipantCount: summary.remoteParticipantCount,
        remoteParticipants: summary.remoteParticipants,
      };
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= waitMs) {
      const error = new Error(`Timed out waiting for remote LiveKit participant after ${waitMs}ms`);
      error.status = 504;
      throw error;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function stopSimpleOneToOneCall(session, roomId) {
  const active = simpleOneToOneCalls.get(roomId);
  if (liveKitConnections.has(roomId)) {
    await disconnectLiveKitRoom(roomId).catch(() => {});
  }
  let left = false;
  if (active?.rtcSession?.isJoined?.()) {
    try {
      left = Boolean(await active.rtcSession.leaveRoomSession(10000));
    } catch (error) {
      console.warn(`[1:1] leave failed room=${roomId}: ${error?.message || error}`);
    }
  }
  if (active?.rtcSession) {
    try { await active.rtcSession.stop?.(); } catch {}
  }
  simpleOneToOneCalls.delete(roomId);
  const cleared = await clearStaleOwnRtcMemberships(session, roomId, '');
  return { left, cleared };
}

async function startSimpleOneToOneCall(session, roomId) {
  // Mirror the already-working local caller exactly at the signaling layer:
  // getRoomSession() -> joinRoomSession() -> SDK-generated ring.
  // No LiveKit media connection and no sticky-membership mode are used here.
  if (simpleOneToOneCalls.has(roomId)) {
    await stopSimpleOneToOneCall(session, roomId);
  }
  if (matrixRtcContexts.has(roomId) || liveKitConnections.has(roomId)) {
    await disconnectLiveKitRoom(roomId);
  }

  const cleared = await clearStaleOwnRtcMemberships(session, roomId, '');
  if (cleared.length) await new Promise((resolve) => setTimeout(resolve, 1200));

  const client = await ensureMatrixRtcClient(session);
  const { rtc: rtcModule } = await loadMatrixRtcSdk();
  let room = client.getRoom(roomId);
  if (!room) {
    await client.joinRoom(roomId);
    room = client.getRoom(roomId);
  }
  if (!room) throw new Error(`Matrix room is not available in matrix-js-sdk: ${roomId}`);

  const joined = room.getJoinedMembers?.() || [];
  const opponents = joined.filter((member) => member.userId !== session.userId);
  if (opponents.length !== 1) {
    const error = new Error(`1:1 call requires exactly one remote joined member; found ${opponents.length}`);
    error.status = 409;
    throw error;
  }

  const rtc = await discoverMatrixRtcTransport(session);
  const focus = { ...rtc.transport, livekit_alias: roomId };
  const rtcSession = client.matrixRTC.getRoomSession(room);
  await rtcSession.initialMembershipCalculated;

  const simpleContext = {
    client,
    rtcSession,
    roomId,
    memberId: '',
    ownKey: null,
    ownKeyIndex: null,
    ownRtcBackendIdentity: '',
    keyWaiters: new Set(),
    keysSeen: 0,
    startedAt: Date.now(),
  };

  rtcSession.on(rtcModule.MatrixRTCSessionEvent.EncryptionKeyChanged, (key, keyIndex, membership, rtcBackendIdentity) => {
    const raw = key instanceof Uint8Array ? new Uint8Array(key) : new Uint8Array(key || []);
    simpleContext.keysSeen += 1;
    const isOwn = membership?.userId === session.userId && membership?.deviceId === session.deviceId;
    console.log(`[1:1 E2EE] key index=${keyIndex} participant=${rtcBackendIdentity || '?'} matrix=${membership?.userId || '?'}/${membership?.deviceId || '?'} own=${isOwn}`);
    if (!isOwn) return;

    simpleContext.memberId = String(membership?.memberId || simpleContext.memberId || '');
    simpleContext.ownKey = raw;
    simpleContext.ownKeyIndex = Number(keyIndex || 0);
    simpleContext.ownRtcBackendIdentity = String(rtcBackendIdentity || '');
    applyLiveKitOutboundKey(roomId, raw, simpleContext.ownKeyIndex, simpleContext.ownRtcBackendIdentity);
    for (const waiter of Array.from(simpleContext.keyWaiters)) waiter.resolve(simpleContext);
  });

  rtcSession.on(rtcModule.MatrixRTCSessionEvent.MembershipManagerError, (error) => {
    const wrapped = error instanceof Error ? error : new Error(String(error || 'MatrixRTC membership manager error'));
    console.error('[1:1] membership manager error:', wrapped);
    for (const waiter of Array.from(simpleContext.keyWaiters)) waiter.reject(wrapped);
  });

  const notificationPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MatrixRTC ring notification was not sent within 20000ms')), 20000);
    rtcSession.once('did_send_call_notification', (notification) => {
      clearTimeout(timer);
      resolve(notification);
    });
    rtcSession.once('membership_manager_error', (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });

  rtcSession.joinRoomSession([], focus, {
    notificationType: 'ring',
    callIntent: 'audio',
    manageMediaKeys: true,
  });
  simpleOneToOneCalls.set(roomId, simpleContext);

  try {
    const notification = await notificationPromise;
    return {
      roomId,
      opponentUserId: opponents[0].userId,
      notificationEventId: notification?.event_id || null,
      notificationType: notification?.notification_type || 'ring',
      state: 'ringing',
      focus,
    };
  } catch (error) {
    await stopSimpleOneToOneCall(session, roomId).catch(() => {});
    throw error;
  }
}

async function resolveSimpleCallMemberId(session, roomId, active) {
  if (active?.memberId) return active.memberId;

  const state = await matrixRoomState(session, roomId);
  const own = state
    .filter((event) => event?.type === 'org.matrix.msc3401.call.member')
    .filter((event) => event?.sender === session.userId)
    .map((event) => event?.content || {})
    .find((content) => content?.device_id === session.deviceId && content?.membershipID);

  if (own?.membershipID) {
    active.memberId = String(own.membershipID);
    return active.memberId;
  }

  const error = new Error('1:1 MatrixRTC membership is not visible yet');
  error.status = 409;
  throw error;
}

async function connectSimpleCallMedia(session, roomId, waitForRemoteMs = 15000) {
  const active = simpleOneToOneCalls.get(roomId);
  if (!active?.rtcSession?.isJoined?.()) {
    const error = new Error('No active 1:1 call session. Call /matrix/call first and answer it before playing audio.');
    error.status = 409;
    throw error;
  }

  const memberId = await resolveSimpleCallMemberId(session, roomId, active);

  if (!active.ownKey && typeof active.rtcSession._onRTCSessionMemberUpdate === 'function') {
    try { await active.rtcSession._onRTCSessionMemberUpdate(); } catch {}
  }
  try { active.rtcSession.reemitEncryptionKeys?.(); } catch {}
  await waitForOwnMatrixRtcKey(active, 15000);

  const rtc = await discoverMatrixRtcTransport(session);
  const openId = await requestMatrixOpenId(session);
  const livekit = await requestLegacyLiveKitToken(rtc.transport, session, roomId, openId, {
    memberId,
  });
  const connection = await connectLiveKitRoom(roomId, livekit, active);
  const remote = await waitForLiveKitRemoteParticipant(roomId, waitForRemoteMs);
  return { active, livekit, connection, remote };
}

function summarizeMatrixRtcContext(roomId, context) {
  return {
    roomId,
    joined: Boolean(context?.rtcSession?.isJoined?.()),
    memberId: context?.memberId || null,
    joinedAt: context?.joinedAt || null,
    keysSeen: Number(context?.keysSeen || 0),
    ownKeyReady: Boolean(context?.ownKey),
    ownKeyIndex: context?.ownKeyIndex ?? null,
    ownRtcBackendIdentity: context?.ownRtcBackendIdentity || '',
    liveKitConnected: Boolean(liveKitConnections.get(roomId)?.room?.isConnected),
  };
}

async function disconnectLiveKitRoom(roomId) {
  clearLiveKitSafetyDisconnect(roomId);
  const connection = liveKitConnections.get(roomId);
  const context = matrixRtcContexts.get(roomId);
  if (connection) {
    try { await connection.room.disconnect(); }
    catch (error) { console.warn(`[LiveKit] disconnect failed room=${roomId}: ${error?.message || error}`); }
  }
  if (context?.rtcSession?.isJoined?.()) {
    let leaveConfirmed = false;
    try {
      leaveConfirmed = await context.rtcSession.leaveRoomSession(5000);
      if (leaveConfirmed) {
        console.log(`[MatrixRTC] left room=${roomId} member=${context.memberId || '?'}`);
      } else {
        console.warn(`[MatrixRTC] leave timed out room=${roomId}; forcing sticky membership clear`);
      }
    } catch (error) {
      console.warn(`[MatrixRTC] leave failed room=${roomId}: ${error?.message || error}`);
    }

    // Do not trust leaveRoomSession() alone. In practice it may report success
    // while the MSC4354 sticky membership is still visible for a short period,
    // which makes Element treat the room as an already-active call and suppress
    // the next ring notification. Always overwrite our exact sticky key with an
    // empty membership after leave so the Audio Bot cannot keep m.call#ROOM alive.
    if (context?.client?._unstable_sendStickyEvent && context?.memberId) {
      try {
        await context.client._unstable_sendStickyEvent(
          roomId,
          60 * 60 * 1000,
          null,
          'org.matrix.msc4143.rtc.member',
          { msc4354_sticky_key: context.memberId },
        );
        console.log(`[MatrixRTC] sticky membership cleared room=${roomId} member=${context.memberId} leaveConfirmed=${leaveConfirmed}`);
        // Give the local sync/store a moment to observe the sticky clear before
        // tearing down the MatrixRTC session object.
        await new Promise((resolve) => setTimeout(resolve, 300));
      } catch (error) {
        console.warn(`[MatrixRTC] sticky clear failed room=${roomId}: ${error?.message || error}`);
      }
    }
  }
  if (context?.rtcSession) {
    try { await context.rtcSession.stop?.(); }
    catch (error) { console.warn(`[MatrixRTC] stop failed room=${roomId}: ${error?.message || error}`); }
  }
  liveKitConnections.delete(roomId);
  matrixRtcContexts.delete(roomId);
  return Boolean(connection || context);
}

async function disconnectAllRtcRooms() {
  const roomIds = Array.from(new Set([
    ...liveKitConnections.keys(),
    ...matrixRtcContexts.keys(),
  ]));
  const results = [];
  for (const roomId of roomIds) {
    try {
      const disconnected = await disconnectLiveKitRoom(roomId);
      results.push({ roomId, disconnected, ok: true });
    } catch (error) {
      console.warn(`[RTC] cleanup failed room=${roomId}: ${error?.message || error}`);
      results.push({ roomId, disconnected: false, ok: false, error: String(error?.message || error) });
    }
  }
  return { roomIds, results };
}

async function logoutMatrixSession() {
  // First leave every RTC/LiveKit session while the Matrix access token is still valid.
  const rtcCleanup = await disconnectAllRtcRooms();

  // Stop matrix-js-sdk sync so this process is no longer an active Matrix client.
  let clientStopped = false;
  if (matrixRtcClientPromise) {
    try {
      const client = await matrixRtcClientPromise;
      client?.stopClient?.();
      clientStopped = true;
    } catch (error) {
      console.warn(`[Matrix] stopClient before logout failed: ${error?.message || error}`);
    }
  }

  const session = matrixSession;
  let logoutOk = false;
  let logoutError = '';
  if (session?.accessToken) {
    try {
      await matrixRequest('POST', '/_matrix/client/v3/logout', {}, session.accessToken);
      logoutOk = true;
      console.log(`[Matrix] logged out user=${session.userId || '?'} device=${session.deviceId || '?'}`);
    } catch (error) {
      logoutError = String(error?.message || error);
      console.warn(`[Matrix] logout failed: ${logoutError}`);
    }
  }

  matrixSession = null;
  matrixRtcClientPromise = null;
  matrixRtcContexts.clear();
  matrixRtcMemberIds.clear();
  matrixLoginSuspended = true;

  return {
    rtcCleanup,
    clientStopped,
    hadSession: Boolean(session?.accessToken),
    userId: session?.userId || null,
    deviceId: session?.deviceId || null,
    logoutOk,
    logoutError: logoutError || undefined,
    loginSuspended: matrixLoginSuspended,
  };
}

async function connectLiveKitRoom(roomId, livekit, e2eeContext) {
  const existing = liveKitConnections.get(roomId);
  if (existing?.room?.isConnected && existing.memberId === livekit.memberId && existing.e2eeKeyIndex !== undefined) {
    scheduleLiveKitSafetyDisconnect(roomId);
    return summarizeLiveKitRoom(roomId, existing);
  }
  if (existing) {
    liveKitConnections.delete(roomId);
    try { await existing.room.disconnect(); } catch {}
  }

  if (!e2eeContext?.ownKey) throw new Error('MatrixRTC outbound E2EE key is not ready');
  const { Room, EncryptionType } = await loadLiveKitRtc();
  const room = new Room();
  const initialKey = e2eeContext.ownKey instanceof Uint8Array
    ? e2eeContext.ownKey
    : new Uint8Array(e2eeContext.ownKey);

  try {
    await room.connect(livekit.url, livekit.jwt, {
      autoSubscribe: false,
      dynacast: false,
      encryption: {
        encryptionType: EncryptionType.GCM,
        keyProviderOptions: {
          // Match web_call/src/viewer.js MatrixKeyProvider: MatrixRTC does NOT
          // use one room-wide shared key. The raw key is installed after connect
          // against its rtcBackendIdentity with KeyProvider.setKey().
          ratchetSalt: MATRIXRTC_E2EE_RATCHET_SALT,
          ratchetWindowSize: MATRIXRTC_E2EE_RATCHET_WINDOW_SIZE,
          failureTolerance: MATRIXRTC_E2EE_FAILURE_TOLERANCE,
          keyRingSize: MATRIXRTC_E2EE_KEY_RING_SIZE,
          keyDerivationFunction: MATRIXRTC_E2EE_KDF_HKDF,
        },
      },
    });
  } catch (error) {
    try { await room.disconnect(); } catch {}
    throw error;
  }

  const connection = {
    room,
    connectedAt: Date.now(),
    memberId: livekit.memberId,
    slotId: livekit.slotId,
    e2eeKeyIndex: e2eeContext.ownKeyIndex ?? 0,
    e2eeRtcBackendIdentity: e2eeContext.ownRtcBackendIdentity || '',
    e2eeKeyUpdatedAt: Date.now(),
  };
  liveKitConnections.set(roomId, connection);
  scheduleLiveKitSafetyDisconnect(roomId);
  try { room.e2eeManager?.setEnabled(true); } catch {}
  applyLiveKitOutboundKey(
    roomId,
    initialKey,
    connection.e2eeKeyIndex,
    connection.e2eeRtcBackendIdentity,
  );
  return summarizeLiveKitRoom(roomId, connection);
}

function parsePcm16Wav(fileBuffer) {
  if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length < 44) throw new Error('invalid WAV file');
  if (fileBuffer.toString('ascii', 0, 4) !== 'RIFF' || fileBuffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('unsupported audio file: expected RIFF/WAVE');
  }

  let offset = 12;
  let format = null;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= fileBuffer.length) {
    const chunkId = fileBuffer.toString('ascii', offset, offset + 4);
    const chunkSize = fileBuffer.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;
    if (chunkDataOffset + chunkSize > fileBuffer.length) break;

    if (chunkId === 'fmt ' && chunkSize >= 16) {
      format = {
        audioFormat: fileBuffer.readUInt16LE(chunkDataOffset),
        channels: fileBuffer.readUInt16LE(chunkDataOffset + 2),
        sampleRate: fileBuffer.readUInt32LE(chunkDataOffset + 4),
        bitsPerSample: fileBuffer.readUInt16LE(chunkDataOffset + 14),
      };
    } else if (chunkId === 'data') {
      dataOffset = chunkDataOffset;
      dataSize = chunkSize;
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (!format || dataOffset < 0) throw new Error('invalid WAV file: missing fmt/data chunk');
  if (format.audioFormat !== 1) throw new Error(`unsupported WAV format ${format.audioFormat}; PCM required`);
  if (format.bitsPerSample !== 16) throw new Error(`unsupported WAV bit depth ${format.bitsPerSample}; 16-bit required`);
  if (format.channels < 1 || format.channels > 2) throw new Error(`unsupported WAV channel count ${format.channels}`);

  const pcmBytes = fileBuffer.subarray(dataOffset, dataOffset + dataSize);
  const evenLength = pcmBytes.length - (pcmBytes.length % 2);
  const samples = new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, evenLength / 2);
  const samplesPerChannel = Math.floor(samples.length / format.channels);

  return {
    sampleRate: format.sampleRate,
    channels: format.channels,
    bitsPerSample: format.bitsPerSample,
    samples,
    samplesPerChannel,
    durationMs: Math.round((samplesPerChannel / format.sampleRate) * 1000),
  };
}

async function publishWavToLiveKit(roomId, audioName, repeat = 1) {
  const connection = liveKitConnections.get(roomId);
  if (!connection?.room?.isConnected) {
    const error = new Error('LiveKit room is not connected');
    error.status = 409;
    throw error;
  }
  // Playback is active work, so give it a fresh safety window instead of
  // allowing an older connect timer to interrupt a later audio publish.
  scheduleLiveKitSafetyDisconnect(roomId);

  const name = normalizeAudioName(audioName);
  if (!name) {
    const error = new Error('invalid audio name');
    error.status = 400;
    throw error;
  }

  let wav;
  try {
    // Keep the built-in test tone consistent with GET /audio/test.wav so a
    // fresh deployment can verify encrypted MatrixRTC playback without first
    // mounting or uploading an audio file.
    const wavBuffer = name === 'test'
      ? makeTestWav()
      : fs.readFileSync(audioFilePath(name));
    wav = parsePcm16Wav(wavBuffer);
  } catch (e) {
    if (e?.code === 'ENOENT') {
      const error = new Error(`audio not found: ${name}.wav`);
      error.status = 404;
      throw error;
    }
    throw e;
  }

  const { AudioFrame, AudioSource, LocalAudioTrack, TrackPublishOptions, TrackSource } = await loadLiveKitRtc();
  const source = new AudioSource(wav.sampleRate, wav.channels);
  const track = LocalAudioTrack.createAudioTrack(`audio-${name}`, source);
  const options = new TrackPublishOptions();
  options.source = TrackSource.SOURCE_MICROPHONE;

  const frameSamplesPerChannel = Math.max(1, Math.round(wav.sampleRate * 0.02));
  const frameSampleCount = frameSamplesPerChannel * wav.channels;
  const loops = Math.max(1, Math.min(10, Number(repeat || 1)));
  let publication = null;

  try {
    publication = await connection.room.localParticipant.publishTrack(track, options);
    if (typeof publication?.waitForSubscription === 'function') {
      console.log(`[LiveKit] waiting for remote subscription track=${publication?.sid || track.sid || '?'} room=${roomId}`);
      await Promise.race([
        publication.waitForSubscription(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for remote audio-track subscription')), 10000)),
      ]);
      console.log(`[LiveKit] remote subscribed track=${publication?.sid || track.sid || '?'} room=${roomId}`);
    }
    const e2eeContext = matrixRtcContexts.get(roomId) || simpleOneToOneCalls.get(roomId);
    if (e2eeContext?.ownKey) {
      applyLiveKitOutboundKey(
        roomId,
        e2eeContext.ownKey,
        e2eeContext.ownKeyIndex ?? 0,
        e2eeContext.ownRtcBackendIdentity,
      );
    }
    for (let loop = 0; loop < loops; loop++) {
      for (let start = 0; start < wav.samples.length; start += frameSampleCount) {
        const end = Math.min(start + frameSampleCount, wav.samples.length);
        const frameData = wav.samples.subarray(start, end);
        const actualSamplesPerChannel = Math.floor(frameData.length / wav.channels);
        if (actualSamplesPerChannel <= 0) continue;
        const aligned = frameData.subarray(0, actualSamplesPerChannel * wav.channels);
        await source.captureFrame(new AudioFrame(aligned, wav.sampleRate, wav.channels, actualSamplesPerChannel));
      }
    }
    await source.waitForPlayout();

    return {
      audio: name,
      repeat: loops,
      sampleRate: wav.sampleRate,
      channels: wav.channels,
      bitsPerSample: wav.bitsPerSample,
      durationMsPerPlay: wav.durationMs,
      totalDurationMs: wav.durationMs * loops,
      trackSid: publication?.sid || track.sid || null,
      trackName: track.name || `audio-${name}`,
      publicationEncryptionType: publication?.encryptionType ?? null,
      e2eeSender: connection.e2eeDiagnostics || null,
    };
  } finally {
    try { await track.close(); } catch {}
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/') {
    return sendJson(res, 200, {
      ok: true,
      service: 'matrix-call-audio-bot-test',
      mode: 'latest-matrixrtc-msc4143-msc4354-msc4195-e2ee-audio',
      audioDir: AUDIO_DIR,
      endpoints: {
        health: 'GET /health',
        audio: 'GET /audio/:name.wav',
        createJob: 'POST /play',
        jobStatus: 'GET /jobs/:id',
        matrixStatus: 'GET /matrix/status',
        matrixLogin: 'POST /matrix/login',
        matrixLogout: 'POST /matrix/logout',
        matrixRooms: 'GET /matrix/rooms',
        matrixPrepare: 'POST /matrix/prepare',
        matrixToken: 'POST /matrix/token',
        matrixConnect: 'POST /matrix/connect',
        matrixCall: 'POST /matrix/call',
        matrixHangup: 'POST /matrix/hangup',
        matrixCallAudio: 'POST /matrix/call-audio',
        matrixPlayAudio: 'POST /matrix/play-audio',
        matrixLiveKitStatus: 'GET /matrix/livekit-status',
        matrixDisconnect: 'POST /matrix/disconnect',
        matrixCleanupStale: 'POST /matrix/cleanup-stale',
      },
    });
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    const activeRtcRoomIds = Array.from(new Set([
      ...liveKitConnections.keys(),
      ...matrixRtcContexts.keys(),
    ]));
    return sendJson(res, 200, {
      ok: true,
      service: 'matrix-call-audio-bot-test',
      uptime: Math.round(process.uptime()),
      jobs: jobs.size,
      audioDir: AUDIO_DIR,
      matrixConfigured: matrixConfigured(),
      rtcClean: activeRtcRoomIds.length === 0,
      activeRtcRoomCount: activeRtcRoomIds.length,
      activeRtcRoomIds,
      matrixRtcSafetyTimeoutMs: MATRIX_RTC_SAFETY_TIMEOUT_MS,
      liveKitE2ee: {
        ratchetWindowSize: MATRIXRTC_E2EE_RATCHET_WINDOW_SIZE,
        failureTolerance: MATRIXRTC_E2EE_FAILURE_TOLERANCE,
        keyRingSize: MATRIXRTC_E2EE_KEY_RING_SIZE,
        keyDerivationFunction: 'HKDF',
      },
      now: new Date().toISOString(),
    });
  }

  if (req.method === 'POST' && url.pathname === '/matrix/logout') {
    if (!authorized(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    try {
      const result = await logoutMatrixSession();
      return sendJson(res, 200, {
        ok: true,
        status: 'matrix_logged_out',
        ...result,
        note: 'Docker process is still running. Matrix auto-login is suspended until POST /matrix/login is called.',
      });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e.message || e) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/matrix/login') {
    if (!authorized(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    try {
      matrixLoginSuspended = false;
      const session = await ensureMatrixSession();
      return sendJson(res, 200, {
        ok: true,
        status: 'matrix_logged_in',
        matrix: {
          homeserver: MATRIX_HOMESERVER,
          userId: session.userId,
          deviceId: session.deviceId,
          authSource: session.source,
        },
      });
    } catch (e) {
      matrixLoginSuspended = true;
      return sendJson(res, e.status || 502, { ok: false, error: String(e.message || e) });
    }
  }

  if (req.method === 'GET' && url.pathname === '/matrix/status') {
    if (!authorized(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    try {
      const session = await ensureMatrixSession();
      const autoJoin = await matrixAutoJoinInvites(session);
      const capabilities = await requireLatestMatrixRtcServerFeatures(session);
      const rtc = await discoverMatrixRtcTransport(session);
      const jwtServiceHealth = await matrixRtcJwtHealth(rtc.transport);
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
          protocol: 'latest_matrixrtc',
          capabilities,
          discovery: rtc.discovery,
          transport: {
            type: rtc.transport.type,
            livekit_service_url: rtc.transport.livekit_service_url,
          },
          transportCount: rtc.transports.length,
          jwtServiceHealth,
        },
      });
    } catch (e) {
      return sendJson(res, e.status || 502, {
        ok: false,
        error: String(e.message || e),
        capabilities: e.capabilities || undefined,
        details: e.body || undefined,
      });
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

  if (req.method === 'POST' && url.pathname === '/matrix/cleanup-stale') {
    if (!authorized(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    try {
      const session = await ensureMatrixSession();
      const disconnected = await disconnectAllRtcRooms();
      const autoJoin = await matrixAutoJoinInvites(session);
      const joinedRooms = await matrixJoinedRooms(session);
      const cleared = [];
      const rooms = [];

      for (const roomId of joinedRooms) {
        try {
          const roomCleared = await clearStaleOwnRtcMemberships(session, roomId, '');
          if (roomCleared.length) cleared.push({ roomId, memberships: roomCleared });
          rooms.push(await matrixRoomSummary(session, roomId, true));
        } catch (error) {
          rooms.push({ roomId, error: String(error?.message || error) });
        }
      }

      return sendJson(res, 200, {
        ok: true,
        status: 'stale_audio_bot_memberships_cleared',
        disconnected,
        autoJoin,
        clearedCount: cleared.reduce((sum, item) => sum + item.memberships.length, 0),
        cleared,
        rooms,
      });
    } catch (e) {
      return sendJson(res, e.status || 502, {
        ok: false,
        error: String(e.message || e),
        details: e.body || undefined,
      });
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
      const capabilities = await requireLatestMatrixRtcServerFeatures(session);
      const rtc = await discoverMatrixRtcTransport(session);
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
          protocol: 'latest_matrixrtc',
          capabilities,
          discovery: rtc.discovery,
          transport: {
            type: rtc.transport.type,
            livekit_service_url: rtc.transport.livekit_service_url,
          },
        },
        openId: {
          ready: Boolean(openId.access_token),
          expires_in: openId.expires_in,
          matrix_server_name: openId.matrix_server_name,
          token_type: openId.token_type,
        },
        note: 'Latest MatrixRTC path is ready: MSC4143 transport discovery, OpenID and room membership are available. No legacy RTC focus fallback is used.',
      });
    } catch (e) {
      return sendJson(res, e.status || 502, {
        ok: false,
        error: String(e.message || e),
        candidates: e.candidates || undefined,
        capabilities: e.capabilities || undefined,
        details: e.body || undefined,
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
      const capabilities = await requireLatestMatrixRtcServerFeatures(session);
      const rtc = await discoverMatrixRtcTransport(session);
      const openId = await requestMatrixOpenId(session);
      const livekit = await requestLatestLiveKitToken(rtc.transport, session, selected.roomId, openId, {
        slotId: MATRIX_RTC_SLOT_ID,
        memberId: matrixRtcMemberId(session),
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
          protocol: 'latest_matrixrtc',
          capabilities,
          discovery: rtc.discovery,
          membership: 'msc4143_msc4354_sticky',
          authorization: 'msc4195_get_token',
          authorizationService: rtc.transport.livekit_service_url,
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
        capabilities: e.capabilities || undefined,
        details: e.body || undefined,
      });
    }
  }

  if (req.method === 'POST' && url.pathname === '/matrix/connect') {
    if (!authorized(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    let connectRoomId = '';
    try {
      const body = await readJson(req);
      const session = await ensureMatrixSession();
      const autoJoin = await matrixAutoJoinInvites(session);
      const selected = await discoverJoinedRoom(session, {
        roomId: body.roomId,
        targetUserId: body.targetUserId,
      });
      connectRoomId = selected.roomId;
      const membership = await matrixRoomMembership(session, selected.roomId);
      const capabilities = await requireLatestMatrixRtcServerFeatures(session);
      const rtc = await discoverMatrixRtcTransport(session);
      const e2eeContext = await ensureMatrixRtcE2ee(session, selected.roomId, rtc.transport);
      const openId = await requestMatrixOpenId(session);
      const livekit = await requestLatestLiveKitToken(rtc.transport, session, selected.roomId, openId, {
        slotId: MATRIX_RTC_SLOT_ID,
        memberId: e2eeContext.memberId,
      });
      const connection = await connectLiveKitRoom(selected.roomId, livekit, e2eeContext);

      return sendJson(res, 200, {
        ok: true,
        status: 'livekit_connected',
        roomId: selected.roomId,
        selectedBy: selected.selectedBy,
        autoJoin,
        matrix: {
          userId: session.userId,
          deviceId: session.deviceId,
          membership: membership.membership || null,
        },
        rtc: {
          protocol: 'latest_matrixrtc',
          capabilities,
          discovery: rtc.discovery,
          membership: 'msc4143_msc4354_sticky',
          authorization: 'msc4195_get_token',
          authorizationService: rtc.transport.livekit_service_url,
          mode: livekit.mode,
          livekitUrl: livekit.url,
          slotId: livekit.slotId,
          memberId: livekit.memberId,
        },
        connection,
        note: 'MatrixRTC membership, media-key management and LiveKit E2EE are active. Audio can now be published encrypted.',
      });
    } catch (e) {
      // Membership is joined before the LiveKit E2EE connect. If a later
      // stage fails, leave immediately so this bot does not keep the room in
      // an active-call state and suppress the next fresh ringing notification.
      if (connectRoomId && (matrixRtcContexts.has(connectRoomId) || liveKitConnections.has(connectRoomId))) {
        await disconnectLiveKitRoom(connectRoomId).catch(() => {});
      }
      return sendJson(res, e.status || 502, {
        ok: false,
        error: String(e.message || e),
        candidates: e.candidates || undefined,
        capabilities: e.capabilities || undefined,
        details: e.body || undefined,
      });
    }
  }

  if (req.method === 'POST' && url.pathname === '/matrix/play-audio') {
    if (!authorized(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    try {
      const body = await readJson(req);
      const session = await ensureMatrixSession();
      const selected = await discoverJoinedRoom(session, {
        roomId: body.roomId,
        targetUserId: body.targetUserId,
      });
      const audio = normalizeAudioName(body.audio || 'alarm');
      const repeat = Math.max(1, Math.min(10, Number(body.repeat || 1)));
      const hangupAfterPlay = body.hangupAfterPlay !== false;
      const requestedHangupDelayMs = Number(body.hangupDelayMs);
      const hangupDelayMs = Number.isFinite(requestedHangupDelayMs)
        ? Math.max(0, Math.min(5000, Math.round(requestedHangupDelayMs)))
        : 600;
      let playback;
      try {
        playback = await publishWavToLiveKit(selected.roomId, audio, repeat);
      } catch (error) {
        // Playback failures must not strand a sticky MatrixRTC membership.
        if (hangupAfterPlay) await disconnectLiveKitRoom(selected.roomId).catch(() => {});
        throw error;
      }

      let hungUp = false;
      if (hangupAfterPlay) {
        // Let the final encrypted audio packets leave the sender before disconnecting.
        if (hangupDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, hangupDelayMs));
        }
        hungUp = await disconnectLiveKitRoom(selected.roomId);
      }

      return sendJson(res, 200, {
        ok: true,
        status: hangupAfterPlay ? 'audio_played_and_hung_up' : 'audio_played',
        roomId: selected.roomId,
        selectedBy: selected.selectedBy,
        playback,
        hangupAfterPlay,
        hangupDelayMs: hangupAfterPlay ? hangupDelayMs : 0,
        hungUp,
        connection: hangupAfterPlay
          ? null
          : summarizeLiveKitRoom(selected.roomId, liveKitConnections.get(selected.roomId)),
      });
    } catch (e) {
      return sendJson(res, e.status || 502, {
        ok: false,
        error: String(e.message || e),
        candidates: e.candidates || undefined,
        capabilities: e.capabilities || undefined,
        details: e.body || undefined,
      });
    }
  }

  if (req.method === 'POST' && url.pathname === '/matrix/call') {
    if (!authorized(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    try {
      const body = await readJson(req);
      const session = await ensureMatrixSession();
      const autoJoin = await matrixAutoJoinInvites(session);
      const selected = await discoverJoinedRoom(session, {
        roomId: body.roomId,
        targetUserId: body.targetUserId,
      });
      const call = await startSimpleOneToOneCall(session, selected.roomId);
      return sendJson(res, 202, {
        ok: true,
        status: 'ringing',
        selectedBy: selected.selectedBy,
        autoJoin,
        matrix: { userId: session.userId, deviceId: session.deviceId },
        call,
        note: 'Simple 1:1 signaling path; no bot audio yet.',
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

  if (req.method === 'POST' && url.pathname === '/matrix/call-play') {
    if (!authorized(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    let selectedRoomId = '';
    try {
      const body = await readJson(req);
      const session = await ensureMatrixSession();
      const selected = await discoverJoinedRoom(session, {
        roomId: body.roomId,
        targetUserId: body.targetUserId,
      });
      selectedRoomId = selected.roomId;

      const audio = normalizeAudioName(body.audio || 'test');
      const repeat = Math.max(1, Math.min(10, Number(body.repeat || 1)));
      const requestedWaitForRemoteMs = Number(body.waitForRemoteMs);
      const waitForRemoteMs = Number.isFinite(requestedWaitForRemoteMs)
        ? Math.max(1000, Math.min(30000, Math.round(requestedWaitForRemoteMs)))
        : 15000;
      if (!audio) {
        const error = new Error('invalid audio name');
        error.status = 400;
        throw error;
      }

      const media = await connectSimpleCallMedia(session, selected.roomId, waitForRemoteMs);
      const playback = await publishWavToLiveKit(selected.roomId, audio, repeat);

      // Let the last encrypted audio frames leave the sender, then disconnect only
      // the LiveKit media transport. Keep the 1:1 MatrixRTC session alive so the
      // phone call itself remains connected until /matrix/hangup is requested.
      await new Promise((resolve) => setTimeout(resolve, 700));
      await disconnectLiveKitRoom(selected.roomId);

      const active = simpleOneToOneCalls.get(selected.roomId);
      return sendJson(res, 200, {
        ok: true,
        status: 'audio_played_call_still_active',
        roomId: selected.roomId,
        selectedBy: selected.selectedBy,
        audio,
        repeat,
        remote: media.remote,
        playback,
        mediaTransport: {
          tokenMode: media.livekit.mode,
          localLiveKitIdentity: media.connection?.localParticipant?.identity || '',
          livekitRoomName: media.connection?.livekitRoomName || '',
        },
        e2ee: {
          keyIndex: media.active.ownKeyIndex ?? 0,
          rtcBackendIdentity: media.active.ownRtcBackendIdentity || '',
          memberId: media.active.memberId || media.livekit.memberId,
        },
        callStillActive: Boolean(active?.rtcSession?.isJoined?.()),
      });
    } catch (e) {
      // A media failure must not tear down the already-working 1:1 signaling call.
      if (selectedRoomId && liveKitConnections.has(selectedRoomId)) {
        await disconnectLiveKitRoom(selectedRoomId).catch(() => {});
      }
      return sendJson(res, e.status || 502, {
        ok: false,
        error: String(e.message || e),
        details: e.body || undefined,
      });
    }
  }

  if (req.method === 'POST' && url.pathname === '/matrix/hangup') {
    if (!authorized(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    try {
      const body = await readJson(req);
      const session = await ensureMatrixSession();
      const selected = await discoverJoinedRoom(session, {
        roomId: body.roomId,
        targetUserId: body.targetUserId,
      });
      const result = await stopSimpleOneToOneCall(session, selected.roomId);
      return sendJson(res, 200, { ok: true, status: 'ended', roomId: selected.roomId, ...result });
    } catch (e) {
      return sendJson(res, e.status || 502, { ok: false, error: String(e.message || e) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/matrix/call-audio') {
    if (!authorized(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    let selectedRoomId = '';
    try {
      const body = await readJson(req);
      const session = await ensureMatrixSession();
      const autoJoin = await matrixAutoJoinInvites(session);
      const selected = await discoverJoinedRoom(session, {
        roomId: body.roomId,
        targetUserId: body.targetUserId,
      });
      selectedRoomId = selected.roomId;

      const audio = normalizeAudioName(body.audio || 'alarm');
      const repeat = Math.max(1, Math.min(10, Number(body.repeat || 1)));
      if (!audio) {
        const error = new Error('invalid audio name');
        error.status = 400;
        throw error;
      }
      const requestedHangupDelayMs = Number(body.hangupDelayMs);
      const hangupDelayMs = Number.isFinite(requestedHangupDelayMs)
        ? Math.max(0, Math.min(5000, Math.round(requestedHangupDelayMs)))
        : 600;
      const requestedWaitForRemoteMs = Number(body.waitForRemoteMs);
      const waitForRemoteMs = Number.isFinite(requestedWaitForRemoteMs)
        ? Math.max(0, Math.min(120000, Math.round(requestedWaitForRemoteMs)))
        : 45000;

      const capabilities = await requireLatestMatrixRtcServerFeatures(session);
      const rtc = await discoverMatrixRtcTransport(session);
      await clearStaleOwnRtcMemberships(session, selected.roomId);
      const e2eeContext = await ensureMatrixRtcE2ee(session, selected.roomId, rtc.transport, { notificationType: 'ring' });
      const openId = await requestMatrixOpenId(session);
      const livekit = await requestLatestLiveKitToken(rtc.transport, session, selected.roomId, openId, {
        slotId: MATRIX_RTC_SLOT_ID,
        memberId: e2eeContext.memberId,
      });
      const connection = await connectLiveKitRoom(selected.roomId, livekit, e2eeContext);
      const remote = await waitForLiveKitRemoteParticipant(selected.roomId, waitForRemoteMs);
      const playback = await publishWavToLiveKit(selected.roomId, audio, repeat);

      if (hangupDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, hangupDelayMs));
      }
      const hungUp = await disconnectLiveKitRoom(selected.roomId);

      return sendJson(res, 200, {
        ok: true,
        status: 'connected_played_and_hung_up',
        roomId: selected.roomId,
        selectedBy: selected.selectedBy,
        autoJoin,
        remote,
        waitForRemoteMs,
        playback,
        hangupDelayMs,
        hungUp,
        connectionBeforeHangup: connection,
        rtc: {
          protocol: 'latest_matrixrtc',
          capabilities,
          discovery: rtc.discovery,
          membership: 'msc4143_msc4354_sticky',
          authorization: 'msc4195_get_token',
          slotId: livekit.slotId,
          memberId: livekit.memberId,
        },
      });
    } catch (e) {
      if (selectedRoomId && (matrixRtcContexts.has(selectedRoomId) || liveKitConnections.has(selectedRoomId))) {
        await disconnectLiveKitRoom(selectedRoomId).catch(() => {});
      }
      return sendJson(res, e.status || 502, {
        ok: false,
        error: String(e.message || e),
        candidates: e.candidates || undefined,
        capabilities: e.capabilities || undefined,
        details: e.body || undefined,
      });
    }
  }

  if (req.method === 'GET' && url.pathname === '/matrix/livekit-status') {
    if (!authorized(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    const connections = Array.from(liveKitConnections.entries()).map(([roomId, connection]) =>
      summarizeLiveKitRoom(roomId, connection)
    );
    const rtcContexts = Array.from(matrixRtcContexts.entries()).map(([roomId, context]) =>
      summarizeMatrixRtcContext(roomId, context)
    );
    const activeRoomIds = Array.from(new Set([
      ...liveKitConnections.keys(),
      ...matrixRtcContexts.keys(),
    ]));
    return sendJson(res, 200, {
      ok: true,
      clean: activeRoomIds.length === 0,
      activeRoomCount: activeRoomIds.length,
      activeRoomIds,
      livekitConnectionCount: connections.length,
      matrixRtcContextCount: rtcContexts.length,
      matrixRtcJoinedCount: rtcContexts.filter((item) => item.joined).length,
      connections,
      rtcContexts,
    });
  }

  if (req.method === 'POST' && url.pathname === '/matrix/disconnect') {
    if (!authorized(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    try {
      const body = await readJson(req);
      const roomId = String(body.roomId || '').trim();
      if (roomId) {
        const disconnected = await disconnectLiveKitRoom(roomId);
        return sendJson(res, 200, { ok: true, disconnected, roomId });
      }

      // A failed LiveKit connect can still leave a MatrixRTC context behind.
      // Disconnect the union so sticky membership is always released.
      const cleanup = await disconnectAllRtcRooms();
      return sendJson(res, 200, {
        ok: true,
        disconnected: cleanup.roomIds.length,
        roomIds: cleanup.roomIds,
        results: cleanup.results,
      });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e.message || e) });
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
  console.log(`MatrixRTC safety timeout: ${MATRIX_RTC_SAFETY_TIMEOUT_MS}ms`);
  console.log(`LiveKit E2EE: HKDF keyRing=${MATRIXRTC_E2EE_KEY_RING_SIZE} ratchetWindow=${MATRIXRTC_E2EE_RATCHET_WINDOW_SIZE}`);
});

let shutdownStarted = false;
async function gracefulShutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`[Shutdown] ${signal}: leaving all MatrixRTC/LiveKit rooms`);

  try { server.close(); } catch {}

  const forceExit = setTimeout(() => {
    console.error('[Shutdown] RTC cleanup exceeded 8s; forcing exit');
    process.exit(1);
  }, 8000);
  forceExit.unref?.();

  try {
    const cleanup = await disconnectAllRtcRooms();
    if (matrixRtcClientPromise) {
      try {
        const client = await matrixRtcClientPromise;
        client?.stopClient?.();
      } catch (error) {
        console.warn(`[Shutdown] Matrix client stop failed: ${error?.message || error}`);
      }
    }
    clearTimeout(forceExit);
    console.log(`[Shutdown] complete rooms=${cleanup.roomIds.length}`);
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExit);
    console.error(`[Shutdown] cleanup failed: ${error?.message || error}`);
    process.exit(1);
  }
}

process.once('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
process.once('SIGINT', () => { void gracefulShutdown('SIGINT'); });