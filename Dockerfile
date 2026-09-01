FROM node:24-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server ./server
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 CMD node -e 'fetch("http://127.0.0.1:3000/").then(async (response) => { if (!response.ok) process.exit(1); const html = await response.text(); const match = html.match(/href="([^"]+\.css)"/); if (!match) process.exit(0); const css = await fetch(new URL(match[1], "http://127.0.0.1:3000/"), { method: "HEAD" }); process.exit(css.ok ? 0 : 1); }).catch(() => process.exit(1))'
CMD ["npm", "run", "start"]
