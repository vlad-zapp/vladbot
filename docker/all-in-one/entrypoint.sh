#!/bin/bash
set -e

# Create log directory
mkdir -p /var/log/supervisor

# Ensure PostgreSQL data directory has correct permissions
chown -R postgres:postgres /var/lib/postgresql

# Ensure data directories exist and have correct permissions
mkdir -p /data/profile /data/files
chown -R vladbot:vladbot /data

# Build API keys environment string for supervisor
API_KEYS=""
if [ -n "$ANTHROPIC_API_KEY" ]; then
    API_KEYS="${API_KEYS},ANTHROPIC_API_KEY=\"$ANTHROPIC_API_KEY\""
fi
if [ -n "$GOOGLE_GEMINI_API_KEY" ]; then
    API_KEYS="${API_KEYS},GOOGLE_GEMINI_API_KEY=\"$GOOGLE_GEMINI_API_KEY\""
fi
if [ -n "$DEEPSEEK_API_KEY" ]; then
    API_KEYS="${API_KEYS},DEEPSEEK_API_KEY=\"$DEEPSEEK_API_KEY\""
fi

# Inject API keys into supervisor config if any are set
if [ -n "$API_KEYS" ]; then
    sed -i "s|BROWSER_WS_ENDPOINT=\"ws://localhost:3100\"|BROWSER_WS_ENDPOINT=\"ws://localhost:3100\"${API_KEYS}|" /etc/supervisor/conf.d/vladbot.conf
fi

echo "Starting Vladbot all-in-one container..."
echo "  Web UI:    http://localhost/"
echo "  Browser:   http://localhost/vnc"
echo ""

exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
