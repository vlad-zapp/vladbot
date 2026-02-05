#!/bin/bash
set -e

RESOLUTION="${RESOLUTION:-1920x1080x24}"

# Start virtual display
Xvfb :99 -screen 0 "$RESOLUTION" -ac &
sleep 1

# Start VNC server for observation (localhost only by default)
x11vnc -display :99 -forever -shared -rfbport 5900 -nopw &

# Start noVNC web viewer
websockify --web=/usr/share/novnc/ 6080 localhost:5900 &

echo "Browser container ready"
echo "  VNC:   localhost:5900"
echo "  noVNC: http://localhost:6080"

# Start the Patchright browser server (foreground — container lives with this)
exec node /app/server.js
