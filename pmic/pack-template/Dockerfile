FROM node:22-alpine
WORKDIR /app
COPY package.json server.js pack.json ./
COPY lib ./lib
USER node
EXPOSE 8080
CMD ["node", "server.js"]
