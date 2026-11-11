# Image for running Big Eyes Office agents in isolation (and the egress proxy).
# Build from the repository root:  docker build -t big-eyes-office-agent -f docker/Dockerfile .
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates ripgrep python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
# Linux builds of the agent SDKs; the source itself is mounted read-only at run time.
RUN npm install --workspace server --omit=dev --no-audit --no-fund
# /state is where each agent's own Docker volume is mounted; a new volume copies this owner.
RUN mkdir -p /state && chown node:node /state
USER node
ENV HOME=/home/node
WORKDIR /work
