FROM node:22-alpine
WORKDIR /app
COPY server.js ./server.js
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
