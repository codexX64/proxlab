# syntax=docker/dockerfile:1
# ProxLab 2 : Node seul, aucune dépendance d'exécution (node:sqlite, WebSocket,
# TLS et Argon2id sont dans le moteur). L'image de base est épinglée par
# empreinte (index multi-architecture amd64 + arm64) : une étiquette peut être
# déplacée, une empreinte non.
ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

FROM ${NODE_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 10001 proxlab && useradd -u 10001 -g proxlab -M -d /nonexistent -s /usr/sbin/nologin proxlab
WORKDIR /app
COPY package.json nouveautes.json ./
COPY socle ./socle
COPY src ./src
COPY web ./web
RUN mkdir -p /data && chown proxlab:proxlab /data && chmod 700 /data
USER proxlab
ENV NODE_ENV=production DATA_DIR=/data PORT=8140
EXPOSE 8140
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8140/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.js"]
