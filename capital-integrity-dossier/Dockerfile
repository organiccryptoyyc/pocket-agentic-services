FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
ENV DOSSIER_TCS6_DATA_DIR=/var/lib/tcs6 DOSSIER_DATA_DIR=/var/lib/dossier
RUN mkdir -p /var/lib/dossier && chown node:node /var/lib/dossier
USER node
EXPOSE 8080
CMD ["node", "server.js"]
