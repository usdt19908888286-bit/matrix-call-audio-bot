const fs = require('fs');
const path = require('path');

const root = process.env.LIVEKIT_RTC_NODE_ROOT
  ? path.resolve(process.env.LIVEKIT_RTC_NODE_ROOT)
  : path.join(__dirname, 'node_modules', '@livekit', 'rtc-node');
if (!fs.existsSync(root)) {
  throw new Error(`@livekit/rtc-node not installed: ${root}`);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

let patched = 0;
for (const file of walk(root)) {
  let source = fs.readFileSync(file, 'utf8');
  if (!source.includes('SetKeyRequest') || !source.includes('setKey(')) continue;

  const original = source;

  // rtc-node 0.13.x exposes setKey(participantIdentity, keyIndex), while the
  // underlying FFI SetKeyRequest contains a raw `key` field. MatrixRTC needs
  // that raw per-participant key, matching livekit-client BaseKeyProvider.
  source = source.replace(
    /setKey\(participantIdentity,\s*keyIndex\)\s*\{/g,
    'setKey(participantIdentity, key, keyIndex) {',
  );

  // Works for both TS-style `participantIdentity: participantIdentity` and the
  // compiled CJS shorthand `participantIdentity` used by rtc-node 0.13.33.
  source = source.replace(
    /(setKey\(participantIdentity, key, keyIndex\)\s*\{[\s\S]*?SetKeyRequest\(\{[\s\S]*?\bparticipantIdentity\b)(\s*,?\s*\}\))/,
    (match, before, closing) => {
      if (/\bkey\s*:\s*key\b|(?:^|[,\s])key(?:[,\s]|$)/m.test(before.split('SetKeyRequest({').pop() || '')) {
        return match;
      }
      return `${before},\n          key${closing}`;
    },
  );

  // Refuse to produce a half-patch: both the method signature and FFI request
  // must contain the raw key.
  const methodStart = source.indexOf('setKey(participantIdentity, key, keyIndex)');
  const methodEnd = methodStart >= 0 ? source.indexOf('exportKey(', methodStart) : -1;
  const methodBody = methodStart >= 0 && methodEnd > methodStart
    ? source.slice(methodStart, methodEnd)
    : '';
  const valid = methodBody.includes('SetKeyRequest') && /\bkey\b/.test(methodBody);

  if (source !== original && valid) {
    fs.writeFileSync(file, source);
    patched += 1;
    console.log(`[livekit-e2ee-patch] patched ${path.relative(root, file)}`);
  }
}

if (!patched) {
  throw new Error('Could not fully patch @livekit/rtc-node KeyProvider.setKey; package layout/API changed');
}
console.log(`[livekit-e2ee-patch] patched files=${patched}`);
