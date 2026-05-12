# Build from repository root: docker build -f api/Dockerfile -t slackkb-api:latest .
FROM node:22-bookworm-slim AS build

WORKDIR /workspace
COPY tsconfig.base.json ./

WORKDIR /workspace/api
COPY api/package.json api/package-lock.json ./
RUN npm ci

COPY api/ ./
RUN npm run build

FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build --chown=node:node /workspace/api/dist ./dist

USER node
EXPOSE 3001

# With compose, bind-mount api/.env to /app/.env. Compose `environment` overrides win over file entries.
CMD ["node", "--env-file=.env", "dist/main.js"]
