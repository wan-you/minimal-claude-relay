#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
PLIST_PATH="$HOME/Library/LaunchAgents/com.wanyou.minimal-claude-relay.plist"
LABEL="com.wanyou.minimal-claude-relay"
PORT_VALUE="${PORT:-3001}"
HOST_VALUE="${HOST:-127.0.0.1}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "此一键部署脚本目前只支持 macOS。" >&2
  exit 1
fi

command -v node >/dev/null || { echo "未找到 Node.js 18+。" >&2; exit 1; }
command -v launchctl >/dev/null || { echo "未找到 launchctl。" >&2; exit 1; }

node --check "$PROJECT_DIR/server.js"
(cd "$PROJECT_DIR" && npm test >/dev/null)

if [[ ! -f "$ENV_FILE" ]]; then
  RELAY_KEY="$(openssl rand -hex 24)"
  cat > "$ENV_FILE" <<EOF
HOST=$HOST_VALUE
PORT=$PORT_VALUE
RELAY_API_KEY=$RELAY_KEY
CLAUDE_AUTH_MODE=oauth
ANTHROPIC_AUTH_HEADER=authorization
CLAUDE_OAUTH_STORE=$PROJECT_DIR/.oauth-tokens.json
CLAUDE_CODE_OAUTH_IMPORT=auto
DEEPSEEK_HARNESS_COMPAT=true
UPSTREAM_TIMEOUT_MS=600000
EOF
  chmod 600 "$ENV_FILE"
else
  RELAY_KEY="$(sed -n 's/^RELAY_API_KEY=//p' "$ENV_FILE" | head -1)"
  [[ -n "$RELAY_KEY" ]] || { echo "$ENV_FILE 缺少 RELAY_API_KEY。" >&2; exit 1; }
fi

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>cd $PROJECT_DIR &amp;&amp; set -a &amp;&amp; source .env &amp;&amp; set +a &amp;&amp; exec $(command -v node) server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$PROJECT_DIR/launchd.log</string>
  <key>StandardErrorPath</key><string>$PROJECT_DIR/launchd.log</string>
</dict></plist>
EOF

USER_ID="$(id -u)"
launchctl bootout "gui/$USER_ID/$LABEL" 2>/dev/null || true
if ! launchctl bootstrap "gui/$USER_ID" "$PLIST_PATH"; then
  sleep 1
  launchctl bootstrap "gui/$USER_ID" "$PLIST_PATH"
fi
launchctl kickstart -k "gui/$USER_ID/$LABEL"

for _ in {1..20}; do
  if node -e "fetch('http://$HOST_VALUE:$PORT_VALUE/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"; then
    break
  fi
  sleep 0.25
done

echo "部署完成：http://$HOST_VALUE:$PORT_VALUE"
echo "管理页：http://$HOST_VALUE:$PORT_VALUE/"
echo "RELAY_API_KEY=$RELAY_KEY"
echo "OAuth 状态：打开管理页后点击“获取授权链接”"
