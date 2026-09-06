FROM node:24.15.0-bookworm-slim@sha256:152aceace5c03e2597988763165ee33e3fd3633636db0fc983cd2e126b02cfde
RUN apt-get update && apt-get install -y --no-install-recommends tar acl attr && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/ia4tube-pause
COPY overlay/package.json overlay/package-lock.json ./overlay/
RUN cd overlay && npm ci --ignore-scripts --no-audit --no-fund
COPY overlay/ ./overlay/
COPY tests/ ./tests/
ENV NODE_ENV=test
ENV IA4TUBE_LINUX_PHYSICAL=1
ENV PAUSE_OVERLAY_ROOT=/opt/ia4tube-pause/overlay
CMD ["node", "--test", "--test-concurrency=1", "tests/linux-physical.test.js"]
