FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
ENV CQ_DATA_DIR=/var/lib/pocket-confidential-queue
RUN mkdir -p /var/lib/pocket-confidential-queue && chown node:node /var/lib/pocket-confidential-queue
USER node
EXPOSE 8080 8090
CMD ["node", "server.js"]
