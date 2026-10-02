FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY pipeline ./pipeline
COPY methodology ./methodology
COPY data ./data
ENV TCS6_DATA_DIR=/var/lib/tcs6
RUN mkdir -p /var/lib/tcs6 && chown node:node /var/lib/tcs6
USER node
EXPOSE 8080
CMD ["node", "server.js"]
