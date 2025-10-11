# syntax=docker/dockerfile:1
FROM node:20-alpine AS base

ENV TZ=UTC \
    LANG=C.UTF-8 \
    LOG_DIR=/var/log/logserver

RUN addgroup -S logserver && adduser -S -G logserver logserver

WORKDIR /app

COPY collector/package.json collector/package-lock.json ./collector/

WORKDIR /app/collector

RUN npm ci --include=dev

COPY collector ./

RUN mkdir -p "$LOG_DIR" /app/collector/data/db \
    && chown -R logserver:logserver /app "$LOG_DIR"

COPY docker/entrypoint.sh /usr/local/bin/logserver-entrypoint
RUN chmod 0555 /usr/local/bin/logserver-entrypoint

USER logserver

VOLUME ["/var/log/logserver"]

EXPOSE 8000

ENTRYPOINT ["logserver-entrypoint"]
CMD ["node", "server.js"]
