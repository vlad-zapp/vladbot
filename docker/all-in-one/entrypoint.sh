#!/bin/bash
set -e

# Create log directory
mkdir -p /var/log/supervisor

# Ensure data directories exist and have correct permissions
mkdir -p /data/profile /data/files /data/postgres /data/vnc-tokens
chown -R vladbot:vladbot /data/profile /data/files /data/vnc-tokens
chown -R postgres:postgres /data/postgres

# Initialize PostgreSQL if this is first run
if [ ! -f /data/postgres/PG_VERSION ]; then
    echo "Initializing PostgreSQL database..."

    # Initialize the database cluster
    su postgres -c "/usr/lib/postgresql/16/bin/initdb -D /data/postgres"

    # Configure PostgreSQL
    echo "host all all 127.0.0.1/32 md5" >> /data/postgres/pg_hba.conf
    echo "listen_addresses = 'localhost'" >> /data/postgres/postgresql.conf

    # Start PostgreSQL temporarily to create user and database
    su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /data/postgres -l /tmp/pg_init.log start"
    sleep 2

    # Create user and database
    su postgres -c "psql --command \"CREATE USER vladbot WITH PASSWORD 'vladbot';\""
    su postgres -c "createdb -O vladbot vladbot"
    su postgres -c "psql -d vladbot --command \"CREATE EXTENSION IF NOT EXISTS vector;\""

    # Stop PostgreSQL (supervisor will start it)
    su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /data/postgres stop"

    echo "PostgreSQL initialized successfully"
fi

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

# Inject API keys into supervisor backend environment if any are set
if [ -n "$API_KEYS" ]; then
    sed -i "s|DATABASE_URL=\"postgresql://vladbot:vladbot@localhost:5432/vladbot\"|DATABASE_URL=\"postgresql://vladbot:vladbot@localhost:5432/vladbot\"${API_KEYS}|" /etc/supervisor/conf.d/vladbot.conf
fi

echo "Starting Vladbot all-in-one container..."
echo "  Web UI:    http://localhost/"
echo "  Browser:   http://localhost/vnc"
echo ""

exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
