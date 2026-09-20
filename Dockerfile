# StayChat OS — Production Docker Image
# Multi-stage build for smaller, more secure image

# ── Build Stage ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

# Install build dependencies
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Install all dependencies (including dev) for build
RUN npm ci --include=dev

# Copy source code
COPY . .

# Build native modules (better-sqlite3)
RUN npm rebuild better-sqlite3

# ── Production Stage ─────────────────────────────────────────────────────────
FROM node:20-alpine AS production

# Security: Create non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

# Install only runtime dependencies
RUN apk add --no-cache dumb-init

WORKDIR /app

# Copy node_modules from builder (only production deps)
COPY --from=builder /app/node_modules ./node_modules

# Copy application source
COPY --from=builder /app/server ./server
COPY --from=builder /app/public ./public
COPY --from=builder /app/package*.json ./

# Create data directory with proper ownership
RUN mkdir -p /app/data && chown -R appuser:appgroup /app

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

# Expose port
EXPOSE 3000

# Volume for persistent data
VOLUME ["/app/data"]

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

# Change to non-root user
USER appuser

# Health check (127.0.0.1, not localhost: on alpine/musl 'localhost' resolves
# to ::1 first and the app binds IPv4 — localhost here reports unhealthy)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

# Run migrations, seed, verify the database, then start the server.
# The check step fails fast (non-zero exit) on a bad seed — e.g. demo users
# missing or passwords rotated — so a broken deploy crashes HERE instead of
# serving 401s to every login attempt. Set CHECK_DEMO_USERS=false to skip the
# demo-account verification in hardened deployments (core schema still checked).
CMD ["sh", "-c", "node server/db/migrate.js && node server/db/seed.js && node server/db/check.js && node server/index.js"]

# Labels
LABEL org.opencontainers.image.title="StayChat OS"
LABEL org.opencontainers.image.version="1.0.0"
LABEL org.opencontainers.image.description="WhatsApp-Native Hotel Management SaaS"
