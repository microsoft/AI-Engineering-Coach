FROM mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm

# Keep image lean and deterministic for both Docker and Podman engines.
RUN apt-get update \
    && export DEBIAN_FRONTEND=noninteractive \
    && apt-get -y install --no-install-recommends \
    ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright browsers for E2E tests (OS-agnostic)
RUN npx playwright install --with-deps