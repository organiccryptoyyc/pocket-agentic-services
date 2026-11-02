FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
ENV BP_DATA_DIR=/var/lib/brand-protection
RUN mkdir -p /var/lib/brand-protection && chown node:node /var/lib/brand-protection
USER node
EXPOSE 8080
CMD ["node", "server.js"]
