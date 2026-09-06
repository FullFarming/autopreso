FROM node:24-slim AS dependencies
WORKDIR /app/media-gateway
COPY media-gateway/package.json media-gateway/package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app/media-gateway
COPY --from=dependencies /app/media-gateway/node_modules ./node_modules
COPY media-gateway/package.json media-gateway/package-lock.json ./
COPY media-gateway/src ./src
COPY packages/caption-core /app/packages/caption-core
COPY packages/gemini-server /app/packages/gemini-server
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
