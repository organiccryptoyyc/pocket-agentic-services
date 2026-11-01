# pokt-network-intel: no npm dependencies, no keys, no state. One container per network:
# POCKET_NETWORK must match the network the supplier is staked on (main or beta).
FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
ENV PORT=8080 POCKET_NETWORK=main
USER node
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/v1/health || exit 1
CMD ["node", "server.js"]
