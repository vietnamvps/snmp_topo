FROM node:26-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/
# Build the SQLite native addon when a matching musl binary is unavailable.
RUN apk add --no-cache python3 make g++ && npm ci --include=dev --foreground-scripts

COPY backend/ ./backend/
COPY frontend/ ./frontend/
RUN npm run build && npm prune --omit=dev

FROM node:26-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/frontend/dist ./frontend/dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "backend/dist/main.js"]
