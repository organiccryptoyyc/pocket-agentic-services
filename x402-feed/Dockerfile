FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
USER node
EXPOSE 8080 8095
CMD ["node", "server.js"]
