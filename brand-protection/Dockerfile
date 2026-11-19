# syntax=docker/dockerfile:1.7
# 0.1.16: Debian 13 (glibc 2.41) instead of Alpine, because c2patool's Linux build needs glibc >= 2.38
# (Alpine's gcompat cannot run it). No npm dependencies, so nothing else changes.
FROM node:22-trixie-slim

# c2patool 0.27.22 (contentauth/c2pa-rs, MIT/Apache-2.0) and the C2PA trust list
# (c2pa-org/conformance-public @ a95f2c4e, 2026-11-04, CC BY 4.0), both pinned by SHA-256.
ADD --checksum=sha256:6f138ad53da1a62f1cd6ee71c60727efa27d13b811f4c0ea8c2a8528968b358b \
    https://github.com/contentauth/c2pa-rs/releases/download/c2patool-v0.27.22/c2patool-v0.27.22-x86_64-unknown-linux-gnu.tar.gz \
    /tmp/c2patool.tar.gz
ADD --checksum=sha256:148c1c167e98dc909a0d5793d2feee1022aa60fef5c83a0d6b08f67f4446bc37 \
    https://raw.githubusercontent.com/c2pa-org/conformance-public/a95f2c4e4be7cd015c394fc5deb188683cbbc944/trust-list/C2PA-TRUST-LIST.pem \
    /opt/c2patool/C2PA-TRUST-LIST.pem
RUN tar -xzf /tmp/c2patool.tar.gz -C /opt && rm /tmp/c2patool.tar.gz \
    && chmod 755 /opt/c2patool/c2patool && chmod 644 /opt/c2patool/C2PA-TRUST-LIST.pem \
    && /opt/c2patool/c2patool --version

WORKDIR /app
COPY package.json server.js ct-follow.js ./
COPY lib ./lib
ENV BP_DATA_DIR=/var/lib/brand-protection
RUN mkdir -p /var/lib/brand-protection && chown node:node /var/lib/brand-protection
USER node
EXPOSE 8080
CMD ["node", "server.js"]
