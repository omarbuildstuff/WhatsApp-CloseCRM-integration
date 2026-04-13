#!/bin/bash
# Apply Baileys connection stability patches after npm install
# Based on: https://github.com/kobie3717/Baileys/commit/24d4eea90c9ebb75cdfa0a0ddfd55db5c53daca4

BAILEYS_DIR="node_modules/@whiskeysockets/baileys/lib"
PATCHES_DIR="patches"

if [ ! -d "$BAILEYS_DIR" ]; then
  echo "[postinstall] Baileys not found — skipping patches"
  exit 0
fi

echo "[postinstall] Applying Baileys connection stability patches..."

cp "$PATCHES_DIR/websocket.js" "$BAILEYS_DIR/Socket/Client/websocket.js"
cp "$PATCHES_DIR/socket.js" "$BAILEYS_DIR/Socket/socket.js"
cp "$PATCHES_DIR/noise-handler.js" "$BAILEYS_DIR/Utils/noise-handler.js"
cp "$PATCHES_DIR/event-buffer.js" "$BAILEYS_DIR/Utils/event-buffer.js"

echo "[postinstall] Patches applied successfully"
