#!/bin/bash
cd "$(dirname "$0")"
PORT=8765
echo "Starting DM Studio on http://localhost:$PORT ..."
echo "Close this window to stop the server."
( sleep 1 && open "http://localhost:$PORT/index.html" ) &
python3 -m http.server $PORT
