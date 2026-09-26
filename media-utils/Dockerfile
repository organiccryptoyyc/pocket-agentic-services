# media-utils — needs real system tools (poppler, libheif+libde265, ffmpeg,
# whisper.cpp), unlike this repo's other three zero-dependency Node
# backends, so this Dockerfile is heavier than theirs. Two stages: the
# first compiles whisper.cpp and fetches its model (needs real outbound
# network — this step cannot run inside this project's own build sandbox,
# see README.md "Verification"; it runs fine on a normal internet
# connection, e.g. the supplier host itself); the second is the actual
# runtime image and does not carry the compiler toolchain.
#
# Build-time knob: WHISPER_MODEL_NAME picks which ggml model
# download-ggml-model.sh fetches — "base.en" (~148MB) by default, a
# reasonable size/accuracy balance for English-only voice clips on a small
# CPU box. Override with --build-arg WHISPER_MODEL_NAME=tiny.en for a
# faster/smaller model, or a non-".en" name (e.g. "base") for
# multilingual input.

FROM debian:bookworm-slim AS whisper-build
ARG WHISPER_MODEL_NAME=base.en
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git .
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build --config Release -j"$(nproc)"
# Binary name has changed across whisper.cpp releases ("main" -> "whisper-cli");
# accept either and normalize to one stable name for the runtime stage.
RUN set -e; \
    if [ -f build/bin/whisper-cli ]; then cp build/bin/whisper-cli /build/whisper-cli; \
    elif [ -f build/bin/main ]; then cp build/bin/main /build/whisper-cli; \
    else echo "no whisper.cpp binary found under build/bin" >&2; exit 1; fi

# whisper.cpp's default cmake build produces whisper-cli as a DYNAMICALLY
# linked binary against libwhisper.so.1 + libggml.so.0/libggml-base.so.0/
# libggml-cpu.so.0 -- all built as .so files sitting in build/bin/ right
# next to the binary itself, not baked into it. Confirmed for real by
# building this exact repo and running `ldd build/bin/whisper-cli`
# (2026-09-26) -- not assumed. Copy every .so this build actually produced
# (preserving the versioned-file + SONAME-symlink + dev-symlink chain each
# one has, e.g. libwhisper.so -> libwhisper.so.1 -> libwhisper.so.1.9.4)
# so the runtime stage can run the binary at all.
RUN mkdir -p /build/lib && cp -P build/bin/*.so* /build/lib/
RUN ./models/download-ggml-model.sh "${WHISPER_MODEL_NAME}" \
    && mkdir -p /build/model \
    && cp "models/ggml-${WHISPER_MODEL_NAME}.bin" "/build/model/ggml-${WHISPER_MODEL_NAME}.bin"

FROM node:20-bookworm-slim
ARG WHISPER_MODEL_NAME=base.en

# poppler-utils: pdftoppm/pdfinfo for /v1/pdf-render.
# ffmpeg: audio normalization for /v1/audio-transcribe.
# libheif-examples: heif-convert, the fallback decoder for real HEVC-coded
# HEIC photos that sharp's bundled libheif build cannot decode on its own.
#
# Do NOT add libheif-plugin-libde265/libheif-plugin-aomdec here — this
# real build (2026-09-26, first real `docker build` against this exact
# base image, on the actual supplier host) failed with "Unable to locate
# package" for both: bookworm ships libheif1 1.15.1, one release before
# upstream's 1.19 loadable-plugin (dlopen) split (confirmed via that
# source package's own Build-Depends: libaom-dev, libdav1d-dev,
# libde265-dev, libx265-dev — bookworm's libheif1 is linked directly
# against those codec .so files at build time as ordinary shared-library
# dependencies, not loaded as separate libheif-plugin-* packages; those
# only exist from bookworm-backports 1.19+ onward). So on bookworm,
# `libheif-examples` alone already pulls in everything heif-convert needs
# via libheif1's own auto-generated Depends — no plugin package to name.
# (The two now-removed names DID resolve when this Dockerfile's
# "Verification" section was first written, because that check ran
# against this project's own build sandbox — Ubuntu 24.04/noble, apt
# archive.ubuntu.com — not against debian:bookworm-slim, which is what
# this Dockerfile actually builds from. Ubuntu noble ships libheif 1.17.6
# with the plugin split already present, so the mismatch passed silently
# until the real bookworm build on the box caught it.)
#
# Build-time proof, not just an assumption: locate libheif's actual .so
# via ldconfig's cache and confirm it is itself linked against libde265 —
# if a future base-image bump ever ships a libheif1 built without HEVC
# support, this fails the build loudly instead of shipping a HEIC
# fallback that silently no-ops.
RUN apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils ffmpeg libheif-examples \
    && rm -rf /var/lib/apt/lists/* \
    && HEIF_SO="$(ldconfig -p | awk '/libheif\.so/{print $NF; exit}')" \
    && [ -n "$HEIF_SO" ] && ldd "$HEIF_SO" | grep -qi 'libde265' \
    || { echo "libheif is missing or not linked against libde265 — real HEIC decode would silently fail" >&2; exit 1; }

COPY --from=whisper-build /build/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper-build /build/lib /opt/whisper/lib
COPY --from=whisper-build /build/model /opt/whisper/models
ENV WHISPER_BIN=/usr/local/bin/whisper-cli
ENV WHISPER_MODEL=/opt/whisper/models/ggml-${WHISPER_MODEL_NAME}.bin
# Without this, whisper-cli exits 127 with "error while loading shared
# libraries: libwhisper.so.1: cannot open shared object file" -- a real
# failure this build hit and fixed (see the whisper-build stage comment
# above for how it was actually root-caused and verified, not guessed).
ENV LD_LIBRARY_PATH=/opt/whisper/lib

# Real proof this actually works in THIS image, not just an assumption
# carried over from the isolated-directory test that found the fix:
# whisper-cli's own --help must exit 0 under the exact env vars and
# library layout the runtime container will actually use.
RUN whisper-cli --help >/dev/null || { echo "whisper-cli cannot even run --help — library layout is still broken" >&2; exit 1; }

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./
COPY lib ./lib

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "server.js"]
