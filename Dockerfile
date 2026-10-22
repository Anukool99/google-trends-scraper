# Build stage: compile TypeScript
FROM apify/actor-node:22 AS builder

COPY --chown=myuser package*.json ./
RUN npm ci --include=dev --audit=false

COPY --chown=myuser . ./
RUN npm run build

# Runtime stage: production dependencies + compiled output only
FROM apify/actor-node:22

COPY --chown=myuser package*.json ./
RUN npm ci --omit=dev --omit=optional --audit=false \
    && echo "Node.js version:" && node --version \
    && echo "NPM version:" && npm --version \
    && rm -r ~/.npm

COPY --from=builder --chown=myuser /usr/src/app/dist ./dist
COPY --chown=myuser .actor ./.actor

# The base image already runs as this non-root user; stated explicitly for readers.
USER myuser

CMD ["npm", "start", "--silent"]
