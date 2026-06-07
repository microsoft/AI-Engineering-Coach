# syntax=docker/dockerfile:1
#
# Fully isolated, real-VS-Code test environment for the AI Engineer Coach
# extension. Everything runs inside this container under a virtual display
# (xvfb), so the host needs nothing but Docker.
#
# What it does (see tests/vm/run.sh, the default CMD):
#   1. Builds the extension and packages a VSIX.
#   2. Runs the authless data-pipeline assertions (real parser + analyzer).
#   3. Runs the headless authless webview walkthrough (Playwright).
#   4. Downloads a real VS Code + chromedriver, installs the VSIX, seeds
#      synthetic fixtures into HOME, and runs the ExTester real-VS-Code UI suite.
#
# Network egress is required the first time (npm registry, Playwright browser
# CDN, and update.code.visualstudio.com for the VS Code download).

FROM mcr.microsoft.com/playwright:v1.49.1-noble

ENV DEBIAN_FRONTEND=noninteractive \
    CODE_VERSION=stable \
    DISPLAY=:99 \
    HOME=/home/tester

# System libraries VS Code / Electron need on top of the Playwright base image.
RUN apt-get update && apt-get install -y --no-install-recommends \
        xvfb \
        libgbm1 \
        libnss3 \
        libxshmfence1 \
        libsecret-1-0 \
        x11-utils \
        jq \
    && rm -rf /var/lib/apt/lists/*

# Run as an unprivileged user with a writable HOME for seeded fixtures.
RUN useradd --create-home --home-dir /home/tester --shell /bin/bash tester
WORKDIR /workspace
COPY . /workspace
RUN chown -R tester:tester /workspace /home/tester

USER tester

# Pre-install root dependencies so container start-up is fast.
RUN npm ci

CMD ["bash", "tests/vm/run.sh"]
