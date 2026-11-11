# Stage 1: generate the static site with the same script used locally.
FROM node:22-alpine AS build
WORKDIR /app
COPY build.mjs ./
COPY templates ./templates
RUN node build.mjs

# Stage 2: runtime. No dependencies, so nothing is installed here.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000
COPY --from=build /app/dist ./dist
COPY server.mjs orchestrator.mjs docker-engine.mjs ./
COPY worker ./worker
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server.mjs"]
