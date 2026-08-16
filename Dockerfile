FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev \
    && npm install --omit=dev --no-save livekit-server-sdk@2.17.0 \
    && node -e "import('livekit-server-sdk').then(()=>console.log('livekit-server-sdk build check=OK')).catch(e=>{console.error(e);process.exit(1)})" \
    && sed -i 's|from "../http-api";|from "../http-api/index.js";|g' node_modules/matrix-js-sdk/lib/oauth/index.js node_modules/matrix-js-sdk/lib/oauth/authorize.js \
    && grep -n 'http-api/index.js' node_modules/matrix-js-sdk/lib/oauth/index.js node_modules/matrix-js-sdk/lib/oauth/authorize.js

COPY . .

# MatrixRTC uses a distinct E2EE key for each rtcBackendIdentity. The current
# rtc-node JS wrapper omits the raw key argument from KeyProvider.setKey even
# though the underlying FFI supports it, so patch the wrapper at image build.
RUN node patch-livekit-node-e2ee.cjs

EXPOSE 3000

# Give the bot a chance to leave MatrixRTC sticky membership before Docker stops it.
STOPSIGNAL SIGTERM

CMD ["npm", "start"]