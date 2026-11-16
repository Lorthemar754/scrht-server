FROM node:22-alpine

# su-exec: start as root only to fix ownership of the mounted volume, then drop to the "node" user
RUN apk add --no-cache su-exec

WORKDIR /app
COPY server.js entrypoint.sh ./
RUN chmod +x entrypoint.sh && mkdir -p /data && chown node:node /data

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
