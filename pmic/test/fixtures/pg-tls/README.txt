Throwaway TLS fixtures for test/pg.test.js only (made 2026-10-20 with OpenSSL 3.5).
ca.crt is a test CA (its key was deleted after signing). leaf.key is a test-only key that protects nothing.
expired.crt / wrongname.crt / selfsigned.crt expired on 2025-01-01; they exercise the expired-certificate exception in lib/pg.js.
