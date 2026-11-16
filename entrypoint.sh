#!/bin/sh
set -e
# A freshly created volume may belong to root — hand it to the unprivileged user.
mkdir -p "${DATA_DIR:-/data}/images"
chown -R node:node "${DATA_DIR:-/data}"
exec su-exec node node /app/server.js
