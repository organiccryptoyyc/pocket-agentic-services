# One image per bundle: bundle.json picks which service this container sells.
FROM node:22-alpine
WORKDIR /app
COPY package.json server.js bundle.json ./
COPY lib ./lib
ENV PACK_FILE=bundle.json
USER node
EXPOSE 8080
CMD ["node", "server.js"]
