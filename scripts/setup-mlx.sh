#!/usr/bin/env bash
set -euo pipefail

# ─── MLX Setup Script ─────────────────────────────────────────────────────────
# Creates a Python virtualenv, installs mlx-lm, downloads a Q4 model,
# and registers a launch agent for automatic startup on login.
#
# Usage:  ./scripts/setup-mlx.sh
# ────────────────────────────────────────────────────────────────────────────────

MLX_ENV="${HOME}/mlx-env"
MODEL_REPO="mlx-community/Qwen2.5-Coder-14B-Instruct-4bit"
MODEL_DIR="${MLX_ENV}/models/Qwen2.5-Coder-14B-Instruct-4bit"
MLX_PORT="${MLX_PORT:-8082}"

echo "==> Creating Python virtualenv at ${MLX_ENV}..."
python3 -m venv "${MLX_ENV}"

echo "==> Installing mlx-lm..."
source "${MLX_ENV}/bin/activate"
pip install -q mlx-lm

echo "==> Downloading model ${MODEL_REPO}..."
mkdir -p "${MLX_ENV}/models"
hf download "${MODEL_REPO}" --local-dir "${MODEL_DIR}"

echo "==> Installing launch agent (auto-start on login)..."
cat > "${HOME}/Library/LaunchAgents/com.user.mlx-server.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.user.mlx-server</string>
    <key>ProgramArguments</key>
    <array>
        <string>${MLX_ENV}/bin/mlx_lm</string>
        <string>server</string>
        <string>--model</string>
        <string>${MODEL_DIR}</string>
        <string>--host</string>
        <string>127.0.0.1</string>
        <string>--port</string>
        <string>${MLX_PORT}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${MLX_ENV}/server.log</string>
    <key>StandardErrorPath</key>
    <string>${MLX_ENV}/server.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${MLX_ENV}/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
EOF

launchctl load "${HOME}/Library/LaunchAgents/com.user.mlx-server.plist" 2>/dev/null || true

echo ""
echo "==> MLX setup complete!"
echo "    Model:      ${MODEL_REPO}"
echo "    Server:     http://localhost:${MLX_PORT}/v1"
echo "    Logs:       ${MLX_ENV}/server.log"
echo ""
echo "    The MLX server is starting in the background."
echo "    Verify with: curl http://localhost:${MLX_PORT}/v1/models"
echo ""
echo "    To use with the SDLC Framework, set in your .env:"
echo "    MLX_HOST=http://localhost:${MLX_PORT}"
echo ""
echo "    To use with opencode, add to opencode.json:"
echo '    "mlx": { "name": "MLX (local)", "options": { "baseURL": "http://localhost:'${MLX_PORT}'/v1" }, "models": { "'"${MODEL_DIR}"'": { "name": "Qwen 2.5 Coder 14B Q4" } } }'
