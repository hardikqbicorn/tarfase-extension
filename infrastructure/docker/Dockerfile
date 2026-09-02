# =============================================================================
# Multi-target image for the platform's Node services.
#
# The monorepo uses TypeScript project references, so the packages must be
# compiled together rather than per service. `build` does that once and the
# per-service targets copy out only what they need:
#
#   docker build -f infrastructure/docker/Dockerfile --target api .
#   docker build -f infrastructure/docker/Dockerfile --target ingestion .
#   docker build -f infrastructure/docker/Dockerfile --target consumer .
#
# docker-compose.yml selects these with `target:`.
# =============================================================================

# --- Dependencies -------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app

# Manifests first, so the (slow) install layer is cached across source edits.
COPY package.json package-lock.json ./
COPY packages/event-schema/package.json packages/event-schema/
COPY packages/crypto/package.json packages/crypto/
COPY packages/shared-utils/package.json packages/shared-utils/
COPY packages/event-sdk/package.json packages/event-sdk/
COPY services/api/package.json services/api/
COPY services/kafka-producer/package.json services/kafka-producer/
COPY services/kafka-consumer/package.json services/kafka-consumer/
COPY extensions/vscode/package.json extensions/vscode/

RUN npm ci --no-audit --no-fund


# --- Compile ------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY services services

# The VS Code extension ships as a .vsix, not in a service image, so it is
# left out of the build graph to keep image builds fast.
RUN npx tsc -b \
      packages/event-schema \
      packages/crypto \
      packages/shared-utils \
      packages/event-sdk \
      services/api \
      services/kafka-producer \
      services/kafka-consumer


# --- Production dependencies --------------------------------------------------
# A separate install so devDependencies (typescript, vitest) stay out of the
# runtime images.
FROM deps AS prod-deps
RUN npm prune --omit=dev


# --- Shared runtime base ------------------------------------------------------
FROM node:20-alpine AS runtime-base
WORKDIR /app
ENV NODE_ENV=production

# Run as a non-root user: a compromised service should not be root in its
# container.
RUN addgroup -g 1001 -S nodejs && adduser -S -u 1001 -G nodejs collector

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

# The workspace packages every service imports.
COPY --from=build /app/packages/event-schema/package.json ./packages/event-schema/
COPY --from=build /app/packages/event-schema/dist ./packages/event-schema/dist
COPY --from=build /app/packages/crypto/package.json ./packages/crypto/
COPY --from=build /app/packages/crypto/dist ./packages/crypto/dist
COPY --from=build /app/packages/shared-utils/package.json ./packages/shared-utils/
COPY --from=build /app/packages/shared-utils/dist ./packages/shared-utils/dist

# Init handles signal forwarding and zombie reaping so SIGTERM reaches Node and
# graceful shutdown actually runs.
RUN apk add --no-cache tini
ENTRYPOINT ["/sbin/tini", "--"]


# --- API service --------------------------------------------------------------
FROM runtime-base AS api
COPY --from=build /app/services/api/package.json ./services/api/
COPY --from=build /app/services/api/dist ./services/api/dist
USER collector
EXPOSE 8081
CMD ["node", "services/api/dist/server.js"]


# --- Ingestion (Kafka producer) service ---------------------------------------
FROM runtime-base AS ingestion
COPY --from=build /app/services/kafka-producer/package.json ./services/kafka-producer/
COPY --from=build /app/services/kafka-producer/dist ./services/kafka-producer/dist
USER collector
EXPOSE 8080
CMD ["node", "services/kafka-producer/dist/server.js"]


# --- Kafka consumer service ---------------------------------------------------
FROM runtime-base AS consumer
COPY --from=build /app/services/kafka-consumer/package.json ./services/kafka-consumer/
COPY --from=build /app/services/kafka-consumer/dist ./services/kafka-consumer/dist
USER collector
EXPOSE 8082
CMD ["node", "services/kafka-consumer/dist/index.js"]
