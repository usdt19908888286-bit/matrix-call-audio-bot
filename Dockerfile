FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev \
    && sed -i 's|from "../http-api";|from "../http-api/index.js";|g' node_modules/matrix-js-sdk/lib/oauth/index.js node_modules/matrix-js-sdk/lib/oauth/authorize.js \
    && grep -n 'http-api/index.js' node_modules/matrix-js-sdk/lib/oauth/index.js node_modules/matrix-js-sdk/lib/oauth/authorize.js

COPY . .

EXPOSE 3000

CMD ["npm", "start"]