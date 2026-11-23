# x402-feed

A read-only, token-protected door from our x402 seller (alpha1, `organiccryptoyyc.com:8443`) to the
service backends on the supplier server's internal Docker network. alpha1 sells the calls over x402;
this container only forwards an allowlisted set of reads.

- `POST /v1/<service>/<path>` with `Authorization: Bearer <FEED_TOKEN>` and the backend's JSON input.
  Forwarded as POST to `http://<service>[-beta]-backend:8080/v1/<path>`. Anything not in `ROUTES`
  (server.js) is a 404; Pocket Confidential, `pmic-hub` and `brand/photo` are not in it.
- `GET /health` (no token). `GET /v1/routes` (token) lists the allowlist.
- Limits: 64 KiB request, 4 MiB response, 60 s per call, 120 calls a minute, read-only filesystem,
  96 MB memory. Stores nothing; logs service, path, status and time only (never bodies).
- Not a Pocket Network service: no card, no relayer entry, no stake.

## Deploy (PSM, Beta first)

```
node ops/package-psm.js beta [--new-token]   # build/x402-feed-beta, route /x402-feed-beta
node ops/package-psm.js main [--new-token]   # build/x402-feed,      route /x402-feed
```

Then PSM: `deploy_ship` the folder, `supplier_run deploy` (health `/health`), `add-routes`
(`/x402-feed[-beta]` -> 8095). The token lives in `%USERPROFILE%\.x402-feed\<network>.env`, outside
every repo; the same value goes into alpha1's Portainer stack as `FEED_TOKEN`. `build/` holds the token
and is gitignored.

Tests: `node --test test/feed.test.js`.
