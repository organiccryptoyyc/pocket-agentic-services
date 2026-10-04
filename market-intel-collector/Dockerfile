# One image for every role: the collector loop, the query API, and the hub. node:22-alpine is
# multi-arch, so the same file builds on a Raspberry Pi 5 / Umbrel (arm64) and on x86 servers.
FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY bin ./bin
COPY config ./config
COPY migrations ./migrations
ENV PMIC_DATA_DIR=/var/lib/pmic
RUN mkdir -p /var/lib/pmic && chown node:node /var/lib/pmic
USER node
EXPOSE 8088
CMD ["node", "server.js"]
