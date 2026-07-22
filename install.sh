#!/usr/bin/env bash
set -euo pipefail

echo "Claw Messenger → n8n listener setup"
echo

if [ ! -f ".env" ]; then
  cp .env.example .env
  echo "Created .env from .env.example. Edit it before starting."
fi

mkdir -p secrets state

if [ ! -f "secrets/n8n_webhook_secret" ]; then
  umask 077
  openssl rand -hex 32 > secrets/n8n_webhook_secret
  echo "Generated secrets/n8n_webhook_secret"
fi

if [ ! -f "secrets/claw_api_key" ]; then
  cat > secrets/claw_api_key <<'EOF'
REPLACE_WITH_CLAW_API_KEY
EOF
  echo "Created secrets/claw_api_key placeholder. Replace it with your real Claw API key."
fi

chmod 700 secrets state
chmod 400 secrets/claw_api_key secrets/n8n_webhook_secret 2>/dev/null || true
chmod 600 .env

echo
echo "Next steps:"
echo "1. Edit .env"
echo "2. Replace secrets/claw_api_key with your Claw API key"
echo "3. Configure n8n Header Auth as:"
printf "   Authorization: Bearer "
cat secrets/n8n_webhook_secret
echo
echo "4. Run: sudo chown 65532:65532 secrets/claw_api_key secrets/n8n_webhook_secret"
echo "5. Run: sudo chown -R 65532:65532 state"
echo "6. Run: docker compose up -d"
