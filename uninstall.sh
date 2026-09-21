#!/usr/bin/env bash
#
# Remove the Meow translator service.
#   sudo ./uninstall.sh          stop and remove the code, keep the data
#   sudo ./uninstall.sh --purge  also delete visits, credentials, settings and backups
#
set -euo pipefail

SERVICE=meow-translator
RUN_USER=meow
APP_DIR=/opt/meow-translator
DATA_DIR=/var/lib/meow-translator
CONF_DIR=/etc/meow-translator
PURGE=0
REMOVE_USER=0

for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1; REMOVE_USER=1;;
    --remove-user) REMOVE_USER=1;;
    --service) shift; SERVICE="${1:?}";;
    -h|--help) echo "usage: sudo ./uninstall.sh [--purge] [--remove-user]"; exit 0;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "run me with sudo" >&2; exit 1; }

echo "==> stopping the service"
if command -v systemctl >/dev/null 2>&1; then
  systemctl stop "$SERVICE" 2>/dev/null || true
  systemctl disable "$SERVICE" 2>/dev/null || true
  rm -f "/etc/systemd/system/$SERVICE.service"
  systemctl daemon-reload
fi

echo "==> removing nginx site"
rm -f "/etc/nginx/sites-enabled/$SERVICE" "/etc/nginx/sites-available/$SERVICE"
command -v systemctl >/dev/null 2>&1 && systemctl reload nginx 2>/dev/null || true

echo "==> removing the application"
rm -rf "$APP_DIR"
rm -f /usr/local/bin/meow-translator

if [ "$PURGE" = 1 ]; then
  echo "==> deleting data and configuration (--purge)"
  rm -rf "$DATA_DIR" "$CONF_DIR"
else
  echo "==> keeping data in $DATA_DIR and config in $CONF_DIR"
  echo "    delete them yourself when you are sure: sudo rm -rf $DATA_DIR $CONF_DIR"
fi

if [ "$REMOVE_USER" = 1 ] && id "$RUN_USER" >/dev/null 2>&1; then
  echo "==> removing the $RUN_USER account"
  userdel "$RUN_USER" 2>/dev/null || true
fi

echo
echo "    done. Node.js and nginx were left installed."
echo
