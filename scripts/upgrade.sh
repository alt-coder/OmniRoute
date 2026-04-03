#!/bin/bash
#
# OmniRoute Upgrade Script
# Usage: ./scripts/upgrade.sh
#
# This script safely upgrades OmniRoute to the latest version:
#   1. Pulls latest changes from git
#   2. Installs dependencies
#   3. Runs database migrations
#   4. Builds the production bundle
#   5. Restarts the systemd service
#   6. Verifies the upgrade succeeded
#

set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SERVICE_NAME="omniroute.service"
BACKUP_DIR="/var/lib/omniroute/backups"
LOG_FILE="/tmp/omniroute-upgrade-$(date +%Y%m%d-%H%M%S).log"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ─────────────────────────────────────────────────────────────────────────────
# Helper Functions
# ─────────────────────────────────────────────────────────────────────────────
log() {
    echo -e "${BLUE}[INFO]${NC} $1" | tee -a "$LOG_FILE"
}

success() {
    echo -e "${GREEN}[OK]${NC} $1" | tee -a "$LOG_FILE"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1" | tee -a "$LOG_FILE"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" | tee -a "$LOG_FILE"
}

check_prerequisite() {
    if ! command -v "$1" &> /dev/null; then
        error "$1 is required but not installed."
        exit 1
    fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Pre-flight Checks
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "========================================"
echo "  OmniRoute Upgrade Script"
echo "========================================"
echo ""

check_prerequisite "git"
check_prerequisite "node"
check_prerequisite "npm"
check_prerequisite "sudo"

# Check if we're in the right directory
if [ ! -f "$PROJECT_DIR/package.json" ]; then
    error "package.json not found in $PROJECT_DIR"
    exit 1
fi

# Check if service exists
if ! sudo systemctl list-unit-files | grep -q "$SERVICE_NAME"; then
    error "Service $SERVICE_NAME not found. Is OmniRoute installed?"
    exit 1
fi

log "Log file: $LOG_FILE"
log "Project directory: $PROJECT_DIR"
log "Service: $SERVICE_NAME"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Step 1: Check for updates
# ─────────────────────────────────────────────────────────────────────────────
log "Checking for updates..."
cd "$PROJECT_DIR"

# Stash any local changes (but save them)
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    warn "Uncommitted changes detected. Stashing..."
    git stash push -m "Auto-stash before upgrade $(date)" 2>&1 | tee -a "$LOG_FILE"
    STASHED=true
else
    STASHED=false
fi

# Pull latest changes
CURRENT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
log "Current commit: $CURRENT_COMMIT"

if git pull --rebase 2>&1 | tee -a "$LOG_FILE"; then
    NEW_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
    if [ "$CURRENT_COMMIT" = "$NEW_COMMIT" ]; then
        success "Already up to date (commit: $CURRENT_COMMIT)"
        echo ""
        log "No upgrade needed. Exiting."
        if [ "$STASHED" = true ]; then
            log "Restoring stashed changes..."
            git stash pop 2>&1 | tee -a "$LOG_FILE"
        fi
        exit 0
    fi
    success "Pulled latest changes: $CURRENT_COMMIT → $NEW_COMMIT"
else
    error "Failed to pull latest changes. Check git status."
    if [ "$STASHED" = true ]; then
        warn "Restoring stashed changes..."
        git stash pop 2>&1 | tee -a "$LOG_FILE" || true
    fi
    exit 1
fi
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Step 2: Backup database
# ─────────────────────────────────────────────────────────────────────────────
DATA_DIR="${DATA_DIR:-/var/lib/omniroute}"
DB_FILE="$DATA_DIR/storage.sqlite"

if [ -f "$DB_FILE" ]; then
    log "Backing up database..."
    mkdir -p "$BACKUP_DIR"
    BACKUP_FILE="$BACKUP_DIR/storage-$(date +%Y%m%d-%H%M%S).sqlite"
    cp "$DB_FILE" "$BACKUP_FILE"
    success "Database backed up to: $BACKUP_FILE"
else
    warn "No database found at $DB_FILE (first-time setup?)"
fi
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Step 3: Install dependencies
# ─────────────────────────────────────────────────────────────────────────────
log "Installing dependencies..."
if npm install --production 2>&1 | tee -a "$LOG_FILE"; then
    success "Dependencies installed"
else
    error "Failed to install dependencies"
    log "Check $LOG_FILE for details"
    exit 1
fi
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Step 4: Build production bundle
# ─────────────────────────────────────────────────────────────────────────────
log "Building production bundle..."
if npm run build 2>&1 | tee -a "$LOG_FILE"; then
    success "Build completed"
else
    error "Build failed!"
    log "Check $LOG_FILE for details"
    error "Upgrade aborted. Database backup is at: $BACKUP_FILE"
    exit 1
fi
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Step 5: Restart service
# ─────────────────────────────────────────────────────────────────────────────
log "Restarting $SERVICE_NAME..."
if sudo systemctl restart "$SERVICE_NAME" 2>&1 | tee -a "$LOG_FILE"; then
    log "Waiting for service to start..."
    sleep 5

    if sudo systemctl is-active --quiet "$SERVICE_NAME"; then
        success "Service restarted successfully"
    else
        error "Service failed to start!"
        log "Check logs: sudo journalctl -u $SERVICE_NAME -n 50"
        error "Database backup is at: $BACKUP_FILE"
        exit 1
    fi
else
    error "Failed to restart service"
    exit 1
fi
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Step 6: Verify upgrade
# ─────────────────────────────────────────────────────────────────────────────
log "Verifying upgrade..."
sleep 2

# Check service health
if sudo systemctl is-active --quiet "$SERVICE_NAME"; then
    success "Service is running"
else
    error "Service is not running!"
    exit 1
fi

# Check HTTP endpoint
HTTP_STATUS=$(curl -sk -o /dev/null -w "%{http_code}" http://127.0.0.1:20128/ 2>/dev/null || echo "000")
if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "307" ]; then
    success "HTTP endpoint responding (status: $HTTP_STATUS)"
else
    warn "HTTP endpoint returned status: $HTTP_STATUS (may need more time to start)"
fi

# Get version
VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "unknown")
success "OmniRoute version: $VERSION"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
echo "========================================"
echo -e "  ${GREEN}Upgrade Complete!${NC}"
echo "========================================"
echo ""
echo "  Version:    $VERSION"
echo "  Commit:     $CURRENT_COMMIT → $NEW_COMMIT"
echo "  Backup:     $BACKUP_FILE"
echo "  Log:        $LOG_FILE"
echo "  Service:    $SERVICE_NAME (active)"
echo ""
echo "To rollback if needed:"
echo "  sudo systemctl stop $SERVICE_NAME"
echo "  cd $PROJECT_DIR"
echo "  git checkout $CURRENT_COMMIT"
echo "  npm install && npm run build"
echo "  sudo systemctl start $SERVICE_NAME"
echo ""

# Clean up old stashes (keep last 5)
if [ "$STASHED" = true ]; then
    log "Restoring stashed changes..."
    if git stash pop 2>&1 | tee -a "$LOG_FILE"; then
        success "Stashed changes restored"
    else
        warn "Failed to restore stashed changes (may have conflicts)"
    fi
fi

exit 0
