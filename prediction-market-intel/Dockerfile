# prediction-market-intel — zero-dependency Node >=18 backend (package.json
# has no "dependencies"), so `npm install` below is a no-op today and only
# matters if a dependency is ever added later. Build context is the
# backend/ folder of the PSM deploy folder (ops/package-psm.js copies it there).

FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./
COPY lib ./lib

ENV NODE_ENV=production
EXPOSE 8080

# No shell, no extra tooling in the running container — just the node process.
CMD ["node", "server.js"]
