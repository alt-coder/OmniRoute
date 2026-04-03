#!/bin/bash
#
# Upgrade OmniRoute - Convenience wrapper
# Usage:
#   node bin/upgrade.js
#   npx omniroute upgrade
#   ./bin/upgrade.js
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

exec "$PROJECT_DIR/scripts/upgrade.sh" "$@"
