FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:99

# System dependencies
RUN apt-get update && apt-get install -y \
    xvfb x11vnc novnc websockify \
    curl wget gnupg ca-certificates \
    fonts-liberation libnss3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxcomposite1 libxdamage1 libxrandr2 \
    libgbm1 libasound2t64 libpango-1.0-0 libcairo2 \
    libxshmfence1 libx11-xcb1 \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# App
WORKDIR /app
COPY package.json ./
RUN npm install

# Install real Chrome via Patchright
RUN npx patchright install chrome --with-deps

# Copy server script and entrypoint
COPY server.js entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Profile data directory
RUN mkdir -p /data/profile

EXPOSE 3100 5900 6080

ENTRYPOINT ["/app/entrypoint.sh"]
