#!/usr/bin/env bash
#
# Install the Ever Works node as a systemd service.
#
#   sudo ./install.sh <user>
#
# Idempotent: re-running refreshes the unit and reloads systemd. It does
# NOT enroll the node — enrollment consumes a one-time token and is an
# explicit, interactive act:
#
#   ever-works-node enroll --api-url https://api.ever.works --token <token>
#
# Run that as <user> first, then start the service.

set -euo pipefail

UNIT_NAME="ever-works-node@.service"
UNIT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/${UNIT_NAME}"
UNIT_DEST="/etc/systemd/system/${UNIT_NAME}"
STATE_DIR="/var/lib/ever-works-node"

RUN_AS="${1:-}"
if [ -z "${RUN_AS}" ]; then
    echo "usage: $0 <user>" >&2
    echo "  the node runs as that user and executes ITS commands" >&2
    exit 2
fi

if [ "$(id -u)" -ne 0 ]; then
    echo "error: must run as root (installing a system unit)" >&2
    exit 1
fi

if ! id "${RUN_AS}" >/dev/null 2>&1; then
    echo "error: user '${RUN_AS}' does not exist" >&2
    exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
    echo "error: systemd is not available on this host" >&2
    echo "  use the container image (.deploy/docker/node/Dockerfile) instead" >&2
    exit 1
fi

if ! command -v ever-works-node >/dev/null 2>&1; then
    # Refuse rather than install a unit that will crash-loop on start.
    echo "error: 'ever-works-node' is not on PATH" >&2
    echo "  install it first, e.g.: npm install -g ever-works-node" >&2
    exit 1
fi

install -d -m 0700 -o "${RUN_AS}" -g "${RUN_AS}" "${STATE_DIR}"
install -m 0644 "${UNIT_SRC}" "${UNIT_DEST}"

systemctl daemon-reload

echo "Installed ${UNIT_DEST}"
echo
echo "Next:"
echo "  1. enroll (as ${RUN_AS}):"
echo "     sudo -u ${RUN_AS} ever-works-node enroll --api-url <url> --token <token>"
echo "  2. start:"
echo "     systemctl enable --now ever-works-node@${RUN_AS}"
echo
echo "Operating:"
echo "  drain (finish in-flight work, take no more):  ever-works-node pause"
echo "  take work again:                              ever-works-node resume"
echo "  follow logs:                                  journalctl -fu ever-works-node@${RUN_AS}"
