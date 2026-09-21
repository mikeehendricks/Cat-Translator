#!/usr/bin/env bash
#
# Meow translator — Ubuntu server installer.
#
#   From a checkout:   sudo ./install.sh
#   One-liner:         curl -fsSL https://raw.githubusercontent.com/mikeehendricks/Cat-Translator/main/install.sh | sudo bash
#
# What it does:
#   1. installs Node.js (>= 18, prefers the current LTS from NodeSource)
#   2. creates a dedicated system user and three directories
#   3. copies the application into /opt/meow-translator
#   4. installs and starts a systemd service (Restart=always, so the built-in
#      updater can restart the app just by exiting)
#   5. optionally puts nginx + Let's Encrypt in front, which matters because
#      microphone capture only works over HTTPS
#   6. prints the URL and the one-time admin setup token
#
# It is idempotent: re-running upgrades the files and the unit and leaves the
# data directory (visits, credentials, settings) untouched.
#
set -euo pipefail

REPO_DEFAULT="mikeehendricks/Cat-Translator"
BRANCH_DEFAULT="main"
SERVICE=meow-translator
RUN_USER=meow
APP_DIR=/opt/meow-translator
DATA_DIR=/var/lib/meow-translator
CONF_DIR=/etc/meow-translator
PORT=80
HOST=0.0.0.0
WITH_NGINX=0
DOMAIN=""
EMAIL=""
GITHUB_TOKEN=""
NODE_FROM_APT=0
SKIP_NODE=0
SOURCE_MODE=auto          # auto | local | remote

C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_INFO=$'\033[36m'; C_OFF=$'\033[0m'
say()  { printf '%s==>%s %s\n' "$C_INFO" "$C_OFF" "$*"; }
ok()   { printf '%s  ok%s %s\n' "$C_OK" "$C_OFF" "$*"; }
warn() { printf '%s  !!%s %s\n' "$C_WARN" "$C_OFF" "$*" >&2; }
die()  { printf '%s error:%s %s\n' "$C_ERR" "$C_OFF" "$*" >&2; exit 1; }

usage() {
  cat <<USAGE
Meow translator installer

  --port N              port to listen on (default $PORT)
  --host ADDR           bind address (default $HOST — reachable from outside the box;
                        use 127.0.0.1 to keep it local to the machine)
  --user NAME           service account (default $RUN_USER)
  --app-dir PATH        install path (default $APP_DIR)
  --data-dir PATH       data path (default $DATA_DIR)
  --with-nginx          install and configure nginx as a reverse proxy
  --domain FQDN         domain name for nginx + Let's Encrypt (implies --with-nginx)
  --email ADDR          email for Let's Encrypt (recommended with --domain)
  --repo owner/name     GitHub repository to install/update from (default $REPO_DEFAULT)
  --branch NAME         branch to follow (default $BRANCH_DEFAULT)
  --version REF         install a tag, branch or commit sha instead of the branch tip
  --github-token TOKEN  token for a private fork (stored in the config, mode 640)
  --node-from-apt       install Node.js from the distribution repository instead of NodeSource
  --skip-node           do not touch Node.js at all (you know it is >= 18)
  --local               force installing the tree this script sits in
  --remote              force downloading from GitHub even if a local tree exists
  -h, --help            this text

Uninstall:  sudo ./uninstall.sh          (keeps data unless --purge is given)
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:?}"; shift 2;;
    --host) HOST="${2:?}"; shift 2;;
    --user) RUN_USER="${2:?}"; shift 2;;
    --app-dir) APP_DIR="${2:?}"; shift 2;;
    --data-dir) DATA_DIR="${2:?}"; shift 2;;
    --with-nginx) WITH_NGINX=1; shift;;
    --domain) DOMAIN="${2:?}"; WITH_NGINX=1; shift 2;;
    --email) EMAIL="${2:?}"; shift 2;;
    --repo) REPO_DEFAULT="${2:?}"; shift 2;;
    --branch) BRANCH_DEFAULT="${2:?}"; shift 2;;
    --version) BRANCH_DEFAULT="${2:?}"; shift 2;;
    --github-token) GITHUB_TOKEN="${2:?}"; shift 2;;
    --node-from-apt) NODE_FROM_APT=1; shift;;
    --skip-node) SKIP_NODE=1; shift;;
    --local) SOURCE_MODE=local; shift;;
    --remote) SOURCE_MODE=remote; shift;;
    -h|--help) usage; exit 0;;
    *) die "unknown option: $1 (try --help)";;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run me with sudo (or as root)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-/dev/null}")" 2>/dev/null && pwd || echo "")"
if [ -z "$SOURCE_MODE" ] || [ "$SOURCE_MODE" = auto ]; then
  if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/server/server.js" ]; then SOURCE_MODE=local; else SOURCE_MODE=remote; fi
fi

# ---------------------------------------------------------------- base system
say "checking the base system"
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends ca-certificates curl tar adduser >/dev/null
  ok "apt packages present (ca-certificates, curl, tar)"
else
  for c in curl tar; do command -v "$c" >/dev/null 2>&1 || die "this installer expects apt (Ubuntu/Debian); missing: $c"; done
  warn "apt not found — skipping package installation, expecting curl and tar to be present"
fi

# ---------------------------------------------------------------------- node
node_major() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

if [ "$SKIP_NODE" = 0 ]; then
  MAJOR="$(node_major)"
  if [ "$MAJOR" -ge 18 ] 2>/dev/null; then
    ok "Node.js $(node -v) already installed"
  else
    say "installing Node.js 22 LTS"
    if [ "$NODE_FROM_APT" = 1 ]; then
      apt-get install -y -qq nodejs >/dev/null
    else
      if curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh 2>/dev/null; then
        bash /tmp/nodesource_setup.sh >/dev/null 2>&1 || warn "NodeSource setup reported a problem; falling back to the distribution package"
        rm -f /tmp/nodesource_setup.sh
        apt-get install -y -qq nodejs >/dev/null 2>&1 || apt-get install -y -qq nodejs npm >/dev/null
      else
        warn "could not reach deb.nodesource.com — using the distribution Node.js"
        apt-get install -y -qq nodejs npm >/dev/null
      fi
    fi
    MAJOR="$(node_major)"
    [ "$MAJOR" -ge 18 ] 2>/dev/null || die "Node.js >= 18 is required (found $(node -v 2>/dev/null || echo none)). On Ubuntu 22.04 run: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
    ok "Node.js $(node -v) installed"
  fi
else
  warn "leaving Node.js alone (--skip-node); found $(node -v 2>/dev/null || echo none)"
fi

NODE_BIN="$(command -v node)"
NPM_EXISTS=0; command -v npm >/dev/null 2>&1 && NPM_EXISTS=1
ok "using $NODE_BIN"

# ------------------------------------------------------------------ account
# The default is the public web port, which is often already taken by a web
# server. Say so plainly instead of installing a service that cannot bind.
say "checking that port $PORT is free"
if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/healthz" 2>/dev/null | grep -q '"ok":true'; then
  ok "port $PORT is already serving this app — it will be restarted"
elif (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  # the file descriptor lives inside the subshell above and closes with it; do not
  # close it here with `exec 3<&-` — in a non-interactive shell a failing exec
  # redirection exits the whole script, silently
  OWNER="$(ss -ltnp 2>/dev/null | awk -v p=":$PORT" '$4 ~ p {print $NF}' | head -1)"
  warn "port $PORT is already in use by something else${OWNER:+ ($OWNER)}"
  warn "  a web server such as nginx or apache2 may be holding it."
  warn "  options: stop it (sudo systemctl stop nginx), pick another port"
  warn "  (--port 8080), or keep it and put this app behind it (--with-nginx)."
  die "refusing to install a service that cannot bind port $PORT"
fi

say "creating the service account and directories"
if id "$RUN_USER" >/dev/null 2>&1; then
  ok "user $RUN_USER already exists"
else
  if command -v adduser >/dev/null 2>&1; then
    adduser --system --group --home "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$RUN_USER" >/dev/null 2>&1 \
      || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$RUN_USER"
  else
    useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$RUN_USER"
  fi
  ok "created system user $RUN_USER"
fi

install -d -o "$RUN_USER" -g "$RUN_USER" -m 0750 "$DATA_DIR"
install -d -o "$RUN_USER" -g "$RUN_USER" -m 0755 "$APP_DIR"
install -d -o root -g "$RUN_USER" -m 0750 "$CONF_DIR"
install -d -o "$RUN_USER" -g "$RUN_USER" -m 0750 "$DATA_DIR/versions" "$DATA_DIR/staging"
ok "directories ready: $APP_DIR, $DATA_DIR, $CONF_DIR"

# ------------------------------------------------------------------- payload
say "fetching the application"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
if [ "$SOURCE_MODE" = local ]; then
  say "installing from $SCRIPT_DIR"
  # Copy the application, never the things that are not the application. A
  # development checkout can hold a repository, installed dependencies, caches
  # and — if the data directory was left at its default — runtime state,
  # including the store's own copies of earlier installs. Copying that back into
  # itself is an infinite regress that fills the disk, so the data directory is
  # excluded explicitly, wherever it lives.
  DATA_REL=""
  case "$DATA_DIR" in
    "$SCRIPT_DIR"/*) DATA_REL="./${DATA_DIR#"$SCRIPT_DIR"/}" ;;
  esac
  tar -C "$SCRIPT_DIR" \
    --exclude='./.git' --exclude='./node_modules' --exclude='./.npm' \
    --exclude='./.cache' --exclude='./.local' --exclude='./.arena' \
    --exclude='./data' --exclude='./versions' --exclude='./staging' \
    --exclude='./local' --exclude='*.log' \
    ${DATA_REL:+--exclude="$DATA_REL"} \
    -cf - . | tar -C "$STAGE" -xf -
else
  URL="${GITHUB_URL:-https://codeload.github.com/$REPO_DEFAULT/tar.gz/$BRANCH_DEFAULT}"
  say "downloading $URL"
  curl -fsSL --retry 3 --max-time 300 "$URL" -o "$STAGE/src.tgz" || die "download failed"
  tar -xzf "$STAGE/src.tgz" -C "$STAGE"
  rm -f "$STAGE/src.tgz"
  INNER="$(find "$STAGE" -maxdepth 1 -mindepth 1 -type d | head -1)"
  [ -n "$INNER" ] || die "the archive did not unpack as expected"
  mv "$INNER" "$STAGE/tree"
  rm -rf "${STAGE:?}"/*.tgz 2>/dev/null || true
  STAGE="$STAGE/tree"
fi
[ -f "$STAGE/server/server.js" ] || die "server/server.js is missing from the payload"
STAGE_KB="$(du -sk "$STAGE" | cut -f1)"
if [ "${STAGE_KB:-0}" -gt 262144 ]; then
  die "the payload is ${STAGE_KB} kB, which is far larger than this application \
(about 20 MB). Something else is inside the source tree — most likely a data or \
backup directory. Move it out, or delete it, and run the installer again."
fi
say "payload: ${STAGE_KB} kB"

# copy over the live tree, keeping anything the update system protects
say "installing into $APP_DIR"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude '.git' --exclude 'node_modules' --exclude 'data' --exclude '.env' --exclude 'local' \
    "$STAGE/" "$APP_DIR/"
else
  find "$APP_DIR" -mindepth 1 -maxdepth 1 \
    ! -name data ! -name node_modules ! -name .git ! -name .env ! -name local \
    -exec rm -rf {} +
  (cd "$STAGE" && tar --exclude=.git --exclude=node_modules --exclude=data -cf - .) | (cd "$APP_DIR" && tar -xf -)
fi
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"
find "$APP_DIR" -type d -exec chmod 755 {} \;
find "$APP_DIR" -type f -exec chmod 644 {} \;
[ -f "$APP_DIR/install.sh" ] && chmod 755 "$APP_DIR/install.sh"
[ -f "$APP_DIR/uninstall.sh" ] && chmod 755 "$APP_DIR/uninstall.sh"
[ -f "$APP_DIR/bin/meow-translator" ] && chmod 755 "$APP_DIR/bin/meow-translator"
VERSION="$(cat "$APP_DIR/VERSION" 2>/dev/null | tr -d '[:space:]')"
ok "application v${VERSION:-unknown} in place"

# -------------------------------------------------------------------- config
say "writing $CONF_DIR/config.json"
if [ -f "$CONF_DIR/config.json" ]; then
  cp "$CONF_DIR/config.json" "$CONF_DIR/config.json.bak-$(date +%s)"
fi
# Keep a trustProxy setting from a previous install unless nginx is being set up
# now: re-running the installer must not silently stop logging real visitor IPs.
EXISTING_TRUST="$(grep -o '"trustProxy"[[:space:]]*:[[:space:]]*\(true\|false\)' "$CONF_DIR/config.json" 2>/dev/null \
  | grep -o 'true\|false' | head -1 || true)"
TRUST_PROXY="${EXISTING_TRUST:-false}"
[ "$WITH_NGINX" = 1 ] && TRUST_PROXY=true
cat > "$CONF_DIR/config.json" <<JSON
{
  "host": "$HOST",
  "port": $PORT,
  "appDir": "$APP_DIR",
  "dataDir": "$DATA_DIR",
  "trustProxy": $TRUST_PROXY,
  "restartMode": "systemd",
  "sessionHours": 12,
  "maxVisitRows": 50000
}
JSON
chown root:"$RUN_USER" "$CONF_DIR/config.json"
chmod 640 "$CONF_DIR/config.json"
ok "config written (host $HOST, port $PORT, trustProxy $TRUST_PROXY)"

# Seed the update source (and, for a private fork, a token) into the store once it
# exists. The token is handed over through a root-only temp file rather than on a
# command line, so it never shows up in the process list.
if [ -f "$DATA_DIR/store.json" ] && [ -n "$GITHUB_TOKEN" ]; then
  SEED="$(mktemp)"
  chmod 600 "$SEED"
  printf '{"repo":"%s","branch":"%s","token":"%s"}\n' "$REPO_DEFAULT" "$BRANCH_DEFAULT" "$GITHUB_TOKEN" > "$SEED"
  sudo -u "$RUN_USER" MEOW_SEED_FILE="$SEED" "$NODE_BIN" -e "
    const fs = require('fs');
    const seed = JSON.parse(fs.readFileSync(process.env.MEOW_SEED_FILE, 'utf8'));
    const p = '$DATA_DIR/store.json';
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    s.settings = Object.assign({}, s.settings, {
      githubRepo: seed.repo, updateChannel: seed.branch,
      githubToken: seed.token || '',
    });
    fs.writeFileSync(p, JSON.stringify(s));
  " && ok "update source seeded into the store" || warn "could not seed the update source — set it in the admin panel instead"
  rm -f "$SEED"
fi

if [ -f "$DATA_DIR/store.json" ]; then
  sudo -u "$RUN_USER" "$NODE_BIN" -e "
    const fs = require('fs');
    const p = '$DATA_DIR/store.json';
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    s.settings = Object.assign({}, s.settings, { githubRepo: '$REPO_DEFAULT', updateChannel: '$BRANCH_DEFAULT' });
    fs.writeFileSync(p, JSON.stringify(s));
  " 2>/dev/null && ok "update source set to $REPO_DEFAULT@$BRANCH_DEFAULT"
fi

# -------------------------------------------------------------------- systemd
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  say "installing the systemd service"
  sed -e "s#^User=.*#User=$RUN_USER#" \
      -e "s#^Group=.*#Group=$RUN_USER#" \
      -e "s#^WorkingDirectory=.*#WorkingDirectory=$APP_DIR#" \
      -e "s#^ExecStart=.*#ExecStart=$NODE_BIN $APP_DIR/server/server.js#" \
      -e "s#^ReadWritePaths=.*#ReadWritePaths=$APP_DIR $DATA_DIR#" \
      "$APP_DIR/deploy/meow-translator.service" > "/etc/systemd/system/$SERVICE.service"
  chmod 644 "/etc/systemd/system/$SERVICE.service"
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE"
  ok "service enabled and started"
else
  warn "systemd is not running here — starting the server in the background instead"
  pkill -f "$APP_DIR/server/server.js" 2>/dev/null || true
  sudo -u "$RUN_USER" env MEOW_CONFIG="$CONF_DIR/config.json" nohup "$NODE_BIN" "$APP_DIR/server/server.js" \
    >> "$DATA_DIR/server.log" 2>&1 &
  sleep 1
fi

# CLI
if [ -f "$APP_DIR/bin/meow-translator" ]; then
  ln -sf "$APP_DIR/bin/meow-translator" /usr/local/bin/meow-translator
  chmod 755 /usr/local/bin/meow-translator
  ok "command installed: meow-translator"
fi

# wait for the store to exist so we can show the setup token
say "waiting for the service to come up"
i=0
while [ "$i" -lt 30 ]; do
  if curl -fsS --max-time 2 "http://$HOST:$PORT/healthz" >/dev/null 2>&1; then break; fi
  if [ "$HOST" = "127.0.0.1" ]; then :; fi
  sleep 0.5; i=$((i + 1))
done
if curl -fsS --max-time 2 "http://$HOST:$PORT/healthz" >/dev/null 2>&1; then
  ok "service answers on http://$HOST:$PORT/"
else
  warn "the service did not answer yet — check: journalctl -u $SERVICE -n 50"
fi

SETUP_TOKEN=""
i=0
while [ "$i" -lt 20 ]; do
  if [ -f "$DATA_DIR/store.json" ]; then
    SETUP_TOKEN="$(sudo -u "$RUN_USER" "$NODE_BIN" "$APP_DIR/server/server.js" --print-setup-token 2>/dev/null | tail -1 || true)"
    [ -n "$SETUP_TOKEN" ] && break
  fi
  sleep 0.5; i=$((i + 1))
done

# ---------------------------------------------------------------------- nginx
if [ "$WITH_NGINX" = 1 ]; then
  say "setting up nginx"
  apt-get install -y -qq nginx >/dev/null
  SERVER_NAME="${DOMAIN:-_}"
  cat > "/etc/nginx/sites-available/$SERVICE" <<NGINX
# Meow translator — reverse proxy to the service on $HOST:$PORT
server {
    listen 80;
    listen [::]:80;
    server_name $SERVER_NAME;

    # uploads from phones can be a few MB
    client_max_body_size 32m;

    location / {
        proxy_pass http://$HOST:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
NGINX
  ln -sf "/etc/nginx/sites-available/$SERVICE" "/etc/nginx/sites-enabled/$SERVICE"
  rm -f /etc/nginx/sites-enabled/default
  nginx -t >/dev/null 2>&1 && systemctl reload nginx && ok "nginx configured for $SERVER_NAME" || warn "nginx config test failed"

  if [ -n "$DOMAIN" ]; then
    say "requesting a Let's Encrypt certificate for $DOMAIN"
    apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
    if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
        ${EMAIL:+-m "$EMAIL"} --redirect >/dev/null 2>&1; then
      ok "HTTPS enabled — https://$DOMAIN/"
      URL="https://$DOMAIN/"
    else
      warn "certbot failed (DNS pointing elsewhere? port 80 closed?). The site still works over HTTP,"
      warn "but microphone capture needs HTTPS — see 'certbot --nginx -d $DOMAIN' once DNS is right."
      URL="http://$DOMAIN/"
    fi
  else
    warn "no --domain given: nginx serves plain HTTP. Microphone capture needs a secure context, so either"
    warn "add a domain with a certificate, or keep visitors on localhost, or make an SSH tunnel."
    URL="http://$(hostname -f 2>/dev/null || echo localhost)/"
  fi
else
  if [ "$HOST" = "127.0.0.1" ]; then
    URL="http://127.0.0.1:$PORT/"
  else
    URL="http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo localhost):$PORT/"
  fi
fi

# --------------------------------------------------------------------- report
if printf '%s' "$SETUP_TOKEN" | grep -qE '^[A-Za-z0-9_-]{20,}$'; then
  TOKEN_BLOCK="  One-time admin setup token (registration only works once). Open the admin
  panel and paste it in to create your admin account:

      $SETUP_TOKEN

  Admin panel:"
elif [ -n "$SETUP_TOKEN" ]; then
  TOKEN_BLOCK="  Registration is already complete on this instance, so the service kept the
  existing account — nothing was reset. Sign in at the admin panel, or reset the
  password with:

      sudo meow-translator reset-password

  Admin panel:"
else
  TOKEN_BLOCK="  The setup token was not readable yet. Get it with:

      sudo meow-translator token

  Admin panel:"
fi

cat <<REPORT

$(printf '%s' "$C_OK")

  Meow translator v${VERSION:-?} is installed.

$(printf '%s' "$TOKEN_BLOCK")

    app        ${URL}
    admin      ${URL%/}/admin
    service    systemctl status $SERVICE
    logs       journalctl -u $SERVICE -f
    files      $APP_DIR          (code, replaced by updates)
    data       $DATA_DIR         (visits, credentials, settings — survives updates)
    config     $CONF_DIR/config.json

REPORT

# An exposed plain-HTTP port is the common case now, and it has two consequences
# worth saying out loud rather than leaving to the operator to remember.
if [ "$HOST" = "0.0.0.0" ]; then
  cat <<EXPOSED
  This instance listens on every interface, on the plain HTTP port $PORT.
  To let it in, open the firewall:   sudo ufw allow $PORT/tcp
  Over plain HTTP the admin password crosses the network in the clear, and
  browsers refuse microphone access without HTTPS. For a public server, point a
  domain at this box and run:
      sudo meow-translator setup-https your.domain.com you@example.com
  That installs nginx + Let's Encrypt, serves the app on 443, redirects $PORT
  to it, and records real visitor addresses. Keep trustProxy=false until then.

EXPOSED
fi

if [ "$WITH_NGINX" = 1 ] && [ -z "$DOMAIN" ]; then
  cat <<NOTE
  Note on the microphone: browsers only allow audio capture on HTTPS or
  localhost. Point a domain at this server and run:
      sudo meow-translator setup-https your.domain.com you@example.com

NOTE
fi

printf '%s' "$C_OFF"
