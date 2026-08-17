# syntax = docker/dockerfile:1

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim AS base

WORKDIR /app
ENV NODE_ENV="production"

# ----------------------
# BUILD STAGE
# ----------------------

FROM base AS build

COPY package-lock.json package.json ./
RUN npm ci --include=dev

COPY . .
RUN npm run build
RUN npm prune --omit=dev

# ----------------------
# FINAL RUNTIME IMAGE
# ----------------------

FROM base

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

EXPOSE 3000
USER node
CMD ["node", "dist/server/server.js"]