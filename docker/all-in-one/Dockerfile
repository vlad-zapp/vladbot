FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:99

# System dependencies
RUN apt-get update && apt-get install -y \
    # Display & VNC
    xvfb x11vnc novnc websockify \
    # PostgreSQL
    postgresql postgresql-contrib \
    # Build tools
    curl wget gnupg ca-certificates build-essential \
    # Chrome dependencies
    fonts-liberation libnss3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxcomposite1 libxdamage1 libxrandr2 \
    libgbm1 libasound2t64 libpango-1.0-0 libcairo2 \
    libxshmfence1 libx11-xcb1 \
    # Process management
    supervisor \
    # nginx for serving frontend
    nginx \
    && rm -rf /var/lib/apt/lists/*

# pgvector extension
RUN apt-get update && apt-get install -y postgresql-16-pgvector && rm -rf /var/lib/apt/lists/*

# Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Create app user
RUN useradd -m -s /bin/bash vladbot

# PostgreSQL setup
USER postgres
RUN /etc/init.d/postgresql start && \
    psql --command "CREATE USER vladbot WITH PASSWORD 'vladbot';" && \
    createdb -O vladbot vladbot && \
    psql -d vladbot --command "CREATE EXTENSION IF NOT EXISTS vector;" && \
    /etc/init.d/postgresql stop
USER root

# Configure PostgreSQL to listen on localhost
RUN echo "host all all 127.0.0.1/32 md5" >> /etc/postgresql/16/main/pg_hba.conf && \
    echo "listen_addresses = 'localhost'" >> /etc/postgresql/16/main/postgresql.conf

# App directory
WORKDIR /app

# Copy package files first for caching
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/

# Install dependencies (include dev for build, then prune)
RUN npm ci --include=dev

# Install Chrome via Patchright
RUN npx patchright install chrome --with-deps

# Copy source code
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/backend packages/backend
COPY packages/frontend packages/frontend

# Build all packages
RUN npm run build

# Fix shared package exports for production (point to compiled JS instead of TS source)
RUN sed -i 's|"./src/index.ts"|"./dist/index.js"|g' packages/shared/package.json

# Prune dev dependencies and set production mode
RUN npm prune --omit=dev
ENV NODE_ENV=production

# Copy browser server files
COPY docker/browser/server.js /app/browser-server.js

# Create data directories and symlink for session files
RUN mkdir -p /data/profile /data/files && \
    chown -R vladbot:vladbot /data && \
    mkdir -p /app/data && \
    ln -s /data/files /app/data/files

# nginx config - serve frontend, proxy backend
RUN rm /etc/nginx/sites-enabled/default
COPY docker/all-in-one/nginx.conf /etc/nginx/sites-enabled/vladbot

# Supervisor config
COPY docker/all-in-one/supervisord.conf /etc/supervisor/conf.d/vladbot.conf

# Entrypoint
COPY docker/all-in-one/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Expose ports
# 80 - nginx (frontend + backend proxy + noVNC at /vnc)
EXPOSE 80

# Volumes for persistent data
VOLUME ["/data"]

ENTRYPOINT ["/entrypoint.sh"]
