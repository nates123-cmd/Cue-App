#!/usr/bin/env bash
# Install the download-steering half of the media-stack skill.
# Run on the Beelink as:   sudo bash ~/install-dl-skill.sh
#
# Everything it needs is already on this box. No secrets are typed in.
#   - extends /opt/media-helper/media_helper.py with /queue /releases /pick /drop
#   - copies the qBittorrent + Sonarr/Radarr creds from nate's bridge.env into
#     /etc/media-helper.env (this is also what fixes the long-broken /torrents)
#   - installs the new SKILL.md so the bot knows the new commands exist
#   - restarts the helper and the OpenClaw gateway
set -euo pipefail

STAGE=/home/nate/media-bridge
BRIDGE_ENV=$STAGE/bridge.env
HELPER_ENV=/etc/media-helper.env
HELPER_PY=/opt/media-helper/media_helper.py
SKILL_DIR=/home/openclaw/.openclaw/skills/media-stack
STAMP=$(date +%Y%m%d-%H%M%S)

[ "$(id -u)" = 0 ] || { echo "run me with sudo"; exit 1; }
for f in "$STAGE/media_helper.new.py" "$STAGE/SKILL.md.new" "$BRIDGE_ENV"; do
  [ -f "$f" ] || { echo "missing $f"; exit 1; }
done

echo "==> 1/5 helper code"
cp -a "$HELPER_PY" "$HELPER_PY.bak.$STAMP"
install -m 0755 -o root -g root "$STAGE/media_helper.new.py" "$HELPER_PY"

echo "==> 2/5 helper env (creds copied from bridge.env, never printed)"
cp -a "$HELPER_ENV" "$HELPER_ENV.bak.$STAMP"
for KEY in QBIT_USER QBIT_PASS SONARR_URL SONARR_KEY RADARR_URL RADARR_KEY; do
  if grep -qE "^${KEY}=" "$HELPER_ENV"; then
    echo "    $KEY already set, leaving it"
    continue
  fi
  LINE=$(grep -E "^${KEY}=" "$BRIDGE_ENV" | head -1 || true)
  if [ -z "$LINE" ]; then echo "    $KEY not in bridge.env, skipping"; continue; fi
  # strip surrounding quotes so systemd EnvironmentFile reads it literally
  VAL=${LINE#*=}; VAL=${VAL%\"}; VAL=${VAL#\"}; VAL=${VAL%\'}; VAL=${VAL#\'}
  printf '%s=%s\n' "$KEY" "$VAL" >> "$HELPER_ENV"
  echo "    $KEY added"
done
chmod 600 "$HELPER_ENV"; chown root:root "$HELPER_ENV"

echo "==> 3/5 skill doc"
install -d -o openclaw -g openclaw -m 0750 "$SKILL_DIR"
[ -f "$SKILL_DIR/SKILL.md" ] && cp -a "$SKILL_DIR/SKILL.md" "$SKILL_DIR/SKILL.md.bak.$STAMP"
install -m 0640 -o openclaw -g openclaw "$STAGE/SKILL.md.new" "$SKILL_DIR/SKILL.md"

echo "==> 4/5 restart helper"
systemctl restart media-helper
sleep 2
systemctl is-active media-helper

echo "==> 5/5 restart OpenClaw gateway (bind-mounted skill: needs restart, not up -d)"
sudo -u openclaw env \
  XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  DOCKER_HOST=unix:///run/user/1001/docker.sock \
  bash -c 'cd /home/openclaw/openclaw && docker compose restart' || {
    echo "!! gateway restart failed. The rootless daemon may be down; start it first:"
    echo "   sudo -u openclaw env XDG_RUNTIME_DIR=/run/user/1001 \\"
    echo "     DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \\"
    echo "     bash -c 'systemctl --user start docker'"
    echo "   then re-run this script."
    exit 1
  }

echo
echo "==> verifying"
SECRET=$(grep -E '^MEDIA_HELPER_SECRET=' "$HELPER_ENV" | head -1 | cut -d= -f2-)
URL="http://100.111.77.98:8099"
for EP in /status /torrents /queue; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $SECRET" "$URL$EP" || echo 000)
  echo "    $EP -> $CODE"
done
echo
echo "Done. On Telegram try:  what's downloading?"
echo "Then:                   show me other files for Sweethearts season 3 episode 3"
