# Build from repository root: docker build -f web/Dockerfile -t slackkb-web:latest .
FROM node:22-bookworm-slim AS build

WORKDIR /workspace/web
COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/ ./
RUN npm run build

FROM nginx:1.27-alpine

COPY web/nginx.docker.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/web/dist /usr/share/nginx/html

EXPOSE 80
