# Custom rtpengine image with 3GPP EVS codec support.
#
# rtpengine ships NO EVS implementation — the codec is patent-encumbered and no
# freely distributable implementation exists. rtpengine instead dlopen()s an
# external `lib3gpp-evs.so` at startup (--evs-lib-path). This image builds that
# library from the 3GPP TS 26.443 v17.0.0 floating-point reference source
# (downloaded from 3gpp.org at build time) plus rtpengine's own build patch,
# then builds the rtpengine daemon itself.
#
# The stock drachtio/rtpengine:latest is mr9.4 and has no EVS support at all,
# so we build rtpengine from source at a pinned recent tag.
#
# Build:  docker build -t rtpengine-evs:local .
ARG RTPENGINE_TAG=mr14.1.1.13

# ---- stage 1: build lib3gpp-evs.so from the 3GPP reference source ----
FROM ubuntu:24.04 AS evs
ARG RTPENGINE_TAG
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential curl unzip ca-certificates patch \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /build
# 3GPP TS 26.443 — EVS floating-point reference code (faster than the 26.442
# fixed-point variant; not bit-exact, which is fine for a transcoding gateway).
RUN curl -fsSL -o evs.zip \
      "https://www.3gpp.org/ftp/Specs/archive/26_series/26.443/26443-h00.zip" \
 && unzip -q evs.zip 26443-h00-ANSI-C_source_code.zip \
 && unzip -q 26443-h00-ANSI-C_source_code.zip
# rtpengine's build patch — kept version-matched to the rtpengine tag.
RUN curl -fsSL -o evs.patch \
      "https://raw.githubusercontent.com/sipwise/rtpengine/${RTPENGINE_TAG}/evs/etsi-ts-126.443-3gpp-ts-26.443-v17.0.0/patch" \
 && cd c-code && patch -p1 < ../evs.patch \
 && RELEASE=1 make -j"$(nproc)" lib3gpp-evs.so

# ---- stage 2: build the rtpengine daemon (also the runtime image) ----
FROM ubuntu:24.04
ARG RTPENGINE_TAG
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential git pkgconf gperf ca-certificates default-libmysqlclient-dev \
      libavcodec-dev libavfilter-dev libavformat-dev libavutil-dev libswresample-dev \
      libbcg729-dev libcjson-dev libcurl4-openssl-dev libevent-dev libglib2.0-dev \
      libhiredis-dev libjson-glib-dev libjwt-dev libmosquitto-dev libncurses-dev \
      libopus-dev libpcap-dev libpcre2-dev libspandsp-dev libssl-dev libsystemd-dev \
      liburing-dev libwebsockets-dev libxtables-dev libiptc-dev zlib1g-dev \
 && git clone --depth 1 -b "${RTPENGINE_TAG}" \
      https://github.com/sipwise/rtpengine.git /src \
 && make -C /src/daemon rtpengine \
 && cp /src/daemon/rtpengine /usr/bin/rtpengine \
 && rm -rf /src /var/lib/apt/lists/*
COPY --from=evs /build/c-code/lib3gpp-evs.so \
      /usr/lib/x86_64-linux-gnu/lib3gpp-evs.so
ENTRYPOINT ["/usr/bin/rtpengine"]
