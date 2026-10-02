FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 DATA_DIR=/data MIGRATIONS_DIR=/app/drizzle
RUN groupadd --gid 10001 portal && useradd --uid 10001 --gid portal --no-create-home portal && mkdir /data && chown portal:portal /data
COPY --from=build --chown=portal:portal /app/.next/standalone ./
COPY --from=build --chown=portal:portal /app/.next/static ./.next/static
COPY --from=build --chown=portal:portal /app/public ./public
COPY --from=build --chown=portal:portal /app/drizzle ./drizzle
COPY --from=build --chown=portal:portal /app/standalone-dist ./standalone-dist
USER portal
EXPOSE 3000
CMD ["node", "server.js"]
