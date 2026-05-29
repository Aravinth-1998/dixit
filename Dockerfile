# Build stage
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared ./shared
COPY server ./server
COPY client ./client
RUN npm install --workspaces --include-workspace-root
# Cards (PNGs + manifest.json) are committed under client/public/cards/.
# Do NOT regenerate here or they will be overwritten with placeholder SVGs.
RUN npm --workspace client run build
RUN npm --workspace server run build

# Runtime stage
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/shared ./shared
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist
RUN npm install --omit=dev --workspaces --include-workspace-root
EXPOSE 3001
CMD ["node", "server/dist/server/src/server.js"]

