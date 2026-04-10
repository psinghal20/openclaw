# OpenClaw Base Image
#
# Provides the OpenClaw gateway runtime (with tool.execute RPC support),
# system dependencies, and Chromium for headless browser automation.
#
# This image is used as the base for Scale's openclaw-environment image,
# which adds entrypoint scripts, skills, personas, and other config.
#
# Build & push:
#   ./docker/build-and-push.sh [tag]

FROM node:22-slim AS builder

RUN apt-get update && apt-get install -y git python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.23.0 --activate

COPY . /build
WORKDIR /build

# The tlon extension's git-hosted dep (@tloncorp/api) has TypeScript
# compilation errors at the pinned commit — exclude only tlon, keep all
# other channel extensions (telegram, whatsapp, discord, slack, etc.).
RUN rm -rf extensions/tlon

RUN pnpm install && pnpm build && pnpm pack

# ── Runtime image ──
FROM node:22-slim

# Core utilities + Chromium for headless browser automation
RUN apt-get update && apt-get install -y \
    curl git python3-pip \
    ffmpeg \
    chromium \
    fonts-liberation fonts-noto-color-emoji \
    libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
    libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
    libxcomposite1 libxdamage1 libxrandr2 xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Tell OpenClaw / Playwright where to find the browser
ENV CHROME_PATH="/usr/bin/chromium"

# Install OpenClaw from the build stage + mcporter (MCP server/tool CLI)
COPY --from=builder /build/openclaw-*.tgz /tmp/openclaw.tgz
RUN npm install -g /tmp/openclaw.tgz mcporter@latest && rm -f /tmp/openclaw.tgz

# Create standard OpenClaw directories
RUN mkdir -p /root/.openclaw \
             /root/.openclaw/agents/main/sessions \
             /root/.openclaw/credentials \
             /workspace /traces
