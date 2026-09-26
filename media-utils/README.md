# Agent Media Utilities

A standalone [Pocket Network](https://pocket.network) service: three
things an autonomous agent regularly needs to do with a file, not a live
data lookup. Built for Pocket's [Agentic Portal builder
contest](https://docs.pocket.network/services/) (announced 2026-09-18,
submissions due 2026-10-12), after checking the real, live Agentic Portal
marketplace (`agent.pocket.network`, 99 services, 10 categories, snapshot
2026-09-26 — see `../docs/registration-runbook.md` §15) and confirming
this specific niche was the one gap that survived: nothing on that
catalog takes a URL or file and returns an actual rendered image, converts
image formats, or transcribes audio.

## Endpoints

| Endpoint | What it does | Tool doing the real work |
|---|---|---|
| `POST /v1/pdf-render` | One page of a PDF → a PNG/JPEG image, at a chosen DPI | [poppler](https://poppler.freedesktop.org/) (`pdftoppm`, `pdfinfo`) |
| `POST /v1/image-convert` | Any-format-to-any-format image conversion, **including real HEIC/HEVC photos** | [sharp](https://sharp.pixelplumbing.com/)/libvips, with a [libheif](https://github.com/strukturag/libheif) (`heif-convert`) fallback |
| `POST /v1/audio-transcribe` + `POST /v1/audio-transcribe-status` | Submit a short clip, poll for its transcript | [whisper.cpp](https://github.com/ggerganov/whisper.cpp) |

`/v1/pdf-render` and `/v1/image-convert` are synchronous — both tools
finish in well under a second for typical inputs (confirmed during this
build, see "Verification"). `/v1/audio-transcribe` is deliberately **not**
synchronous: a real speech-to-text pass, on CPU, on modest supplier
hardware, cannot reliably finish inside a gateway's `relay_timeout`
(design rule 7 forbids streaming through a gateway and bounds a response
to that timeout — typically 10–30s). The skill's own guidance for exactly
this situation is "return a handle and let the client poll," so submit
returns a `job_id` immediately and the caller polls
`/v1/audio-transcribe-status` until `status` is `done` or `error`. Jobs
are capped at `MAX_AUDIO_SECONDS` (default 180s) and processed one at a
time — this is a small CPU box, not a GPU cluster.

## Why real system tools, not a pure-npm approach

This repo's other three services are deliberately zero-npm-dependency
Node (see `agent-trust/package.json`) because nothing they do needs a
codec library. This service genuinely does, and the choice of *which*
tool matters — the obvious npm-only path for HEIC silently fails on the
exact files real users have:

**`sharp`'s bundled libheif build does not decode real HEIC photos.**
Tested directly against a real single-image, HEVC-coded HEIC file (the
format actual iPhone photos use) during this build:

```
$ node -e "require('sharp')('example.heic').png().toBuffer().catch(e=>console.log(e.message))"
example.heic: bad seek to 718130
heif: Error while loading plugin: Support for this compression format has not been built in (11.6003)
```

`sharp`'s prebuilt binaries include AVIF (AV1-based, royalty-free) support
but deliberately omit HEVC decoding — the codec real HEIC files use — for
licensing reasons. This is a well-known, documented limitation of the
sharp/libvips ecosystem, not a bug to work around in application code.
`libheif-examples`' `heif-convert` CLI, with the `libde265` HEVC plugin
installed alongside it, decodes the same file correctly:

```
$ apt-get install -y libheif-examples libheif-plugin-libde265 libheif-plugin-aomdec
$ heif-convert example.heic out.png
File contains 2 images
Written to out-1.png
Written to out-2.png
```

So `/v1/image-convert` tries `sharp` first (fast, in-process, covers
png/jpeg/webp/gif/tiff/bmp/avif/svg natively) and falls back to
`heif-convert` only when sharp's own pipeline fails **and** the input's
ISO-BMFF `ftyp` box brand is a HEIC/HEVC brand rather than AVIF (`lib/
media.js`'s `looksLikeHevcHeif`) — the fallback runs a real system tool,
not a second guess at the same broken codec path.

One real bug this caught during the build, worth naming because it's the
kind of thing that would have shipped silently otherwise: `sharp`'s
`.metadata()` call succeeds on a real HEVC-coded HEIC file — it can read
the *container-level* width/height/brand without invoking the codec — and
only the later pixel-level `.toBuffer()` call actually fails. An earlier
version of `convertImage()` wrapped only `.metadata()` in the
sharp-vs-heif-convert try/catch, so the real decode failure was escaping
uncaught and surfacing as a generic 422, never reaching the fallback path
at all. Caught by the real HEIC test in `test/smoke.js` (not a mock), not
by review — fixed by wrapping the whole pipeline, including the encode
step, in one try.

## Verification

**Independently confirmed for real, in this build's own environment**
(this build's sandbox has a real filesystem, real network for public
GitHub raw content, and — unlike most of this repo's other packages —
already had `pdftoppm`, `pdfinfo`, `ffmpeg`, and `apt-get` available,
so these paths were exercised end to end, not just read about):

- **PDF rendering**: a hand-built minimal one-page PDF, rendered via
  `pdftoppm -singlefile` at a known DPI, produces exactly the expected
  pixel dimensions (200×100 at 72 DPI for a 200×100pt page — verified,
  and this is the same fixture embedded as `card.json`'s functional
  healthcheck probe). Also verified `pdftoppm`'s *non*-singlefile output
  naming zero-pads the page-number suffix to the digit-width of the
  document's total page count (an 11-page document's page 9 is named
  `prefix-09.png`, not `prefix-9.png`) — which is exactly why
  `renderPdfPage` uses `-singlefile` (`prefix.png`, no digit-guessing)
  rather than reverse-engineering that scheme.
- **Image conversion**: a synthetic PNG converts correctly to WebP via
  `sharp`. A real single-image HEVC-coded HEIC file (libheif's own
  official example, fetched live) round-trips through the `heif-convert`
  fallback to a valid PNG with real, non-zero pixel dimensions.
- **Audio normalization**: `ffmpeg` converts a synthetic MP3 to the exact
  16 kHz mono 16-bit PCM WAV format `whisper.cpp` requires — verified via
  `ffprobe` reading back the resulting file's sample rate and channel
  count.
- `npm audit`: `sharp` is pinned to `^0.35.4` specifically because every
  earlier `sharp` release has known libvips/libheif CVEs
  ([GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj),
  [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c))
  — checked with `npm audit` after installing, not assumed; `0.35.4`
  reports zero.

**Not independently confirmed, and flagged rather than guessed:**
`whisper.cpp` itself. Building it needs `cmake`/`git`/a C++ toolchain
(all present here and confirmed working), but its model files are hosted
on `huggingface.co`, which this build sandbox's own outbound network
cannot reach — the same class of restriction this repo already documents
for `*.pocket.network` elsewhere. `lib/transcribe.js`'s
`parseWhisperOutput` was written against `whisper.cpp`'s long-documented,
stable plain-text output format (`[hh:mm:ss.mmm --> hh:mm:ss.mmm]  text`
per line, one of the project's oldest and most stable conventions) rather
than its `-oj` JSON mode, specifically because this build could not run a
real instance to confirm the JSON schema's exact key names, but could
have real confidence in the text format from the project's own long-
standing documentation. **Before relying on `/v1/audio-transcribe`,
build the image and run one real clip through it** — if the installed
`whisper.cpp` version's line format has drifted, `parseWhisperOutput`'s
regex is the one place to fix. The endpoint degrades honestly rather than
guessing: if `WHISPER_BIN`/`WHISPER_MODEL` aren't present, it returns
`422 {"error":{"code":"not_configured", ...}}` (confirmed — this is the
actual response in this sandbox, which has no whisper.cpp binary),
never a fabricated transcript.

## Operator setup

Everything `/v1/pdf-render` and `/v1/image-convert` need is installed by
this package's own `Dockerfile` — no extra operator steps. `whisper.cpp`
and its model are also built and fetched by the same `Dockerfile`
(`docker build` needs real outbound network access for the `git clone`
and the model download — this is a build-time requirement, not a runtime
one, and does not apply to the sandbox this README was written in, see
"Verification"). To use a smaller/faster or multilingual model instead of
the `base.en` default: `docker build --build-arg WHISPER_MODEL_NAME=tiny.en ...`
(or any name `models/download-ggml-model.sh` in the whisper.cpp repo
accepts).

## Testing

```
node test/smoke.js    # real pdftoppm/sharp/heif-convert paths; audio path asserted only up to not_configured
npm start             # POCKET_NETWORK n/a here; needs the Docker image's tools (or all of poppler-utils/
                       # libheif-examples+libheif-plugin-libde265+libheif-plugin-aomdec/ffmpeg/whisper.cpp
                       # installed locally) to exercise every path for real
```

## Deploying

See `../docs/registration-runbook.md` §15 for how this package was
scoped, and §5's pattern for the other four services for the registration
steps this one will need too (service ID `media-utils` — **not yet
catalog-conflict-checked against either network's live registry**; run
`check_catalog.py media-utils --both` before registering, per the
`pocket-service-builder` skill's Rule 1, since that check needs a live
chain query this build did not perform). Nothing in this package has been
registered, staked, or deployed to the supplier host — design and build
only, pending your go-ahead, per this project's standing rule that
nothing gets pushed to chain or run against the real supplier host
without approval in the moment.
