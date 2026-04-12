#!/bin/bash
# WA-Close DB Backup → Google Drive
# Usage: ./backup-db.sh
# Cron:  0 3 * * * /var/www/tempwarep/scripts/backup-db.sh

set -euo pipefail

# Config
GDRIVE_REMOTE="gdrive"
GDRIVE_FOLDER="WA-Close-Backups"
BACKUP_DIR="/tmp/waclose-backups"
KEEP_DAYS=30

# Load env
source /var/www/tempwarep/.env

# Create temp dir
mkdir -p "$BACKUP_DIR"

# Dump
FILENAME="waclose-$(date +%Y%m%d-%H%M%S).sql.gz"
pg_dump "$DATABASE_URL" | gzip > "$BACKUP_DIR/$FILENAME"

# Upload to Google Drive
rclone copy "$BACKUP_DIR/$FILENAME" "$GDRIVE_REMOTE:$GDRIVE_FOLDER/" --log-level INFO

# Clean up local file
rm -f "$BACKUP_DIR/$FILENAME"

# Clean up old backups on Google Drive (keep last 30 days)
rclone delete "$GDRIVE_REMOTE:$GDRIVE_FOLDER/" --min-age "${KEEP_DAYS}d" --log-level INFO 2>/dev/null || true

echo "[$(date)] Backup complete: $FILENAME → $GDRIVE_REMOTE:$GDRIVE_FOLDER/"
