FROM node:26-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/
RUN npm ci --include=dev

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
USER node
EXPOSE 3000
CMD ["node", "backend/dist/main.js"]
