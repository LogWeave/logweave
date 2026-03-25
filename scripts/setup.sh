#!/usr/bin/env bash
set -euo pipefail

# LogWeave setup — generates .env from .env.production.example with random secrets.
# Usage: bash scripts/setup.sh

ENV_EXAMPLE=".env.production.example"
ENV_FILE=".env"

if [ ! -f "$ENV_EXAMPLE" ]; then
  echo "Error: $ENV_EXAMPLE not found. Run this from the project root."
  exit 1
fi

if [ -f "$ENV_FILE" ]; then
  echo ".env already exists. Delete it first if you want to regenerate."
  exit 1
fi

# Generate secrets
API_KEY=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 16)
CHECKPOINT_HMAC_KEY=$(openssl rand -hex 16)

# Copy template and fill in secrets
cp "$ENV_EXAMPLE" "$ENV_FILE"

# Replace placeholder values
if [[ "$OSTYPE" == "darwin"* ]]; then
  # macOS sed
  sed -i '' "s|LOGWEAVE_API_KEYS=.*|LOGWEAVE_API_KEYS={\"${API_KEY}\":\"default\"}|" "$ENV_FILE"
  sed -i '' "s|LOGWEAVE_ENCRYPTION_KEY=.*|LOGWEAVE_ENCRYPTION_KEY=${ENCRYPTION_KEY}|" "$ENV_FILE"
  sed -i '' "s|LOGWEAVE_CHECKPOINT_HMAC_KEY=.*|LOGWEAVE_CHECKPOINT_HMAC_KEY=${CHECKPOINT_HMAC_KEY}|" "$ENV_FILE"
else
  # Linux/Git Bash sed
  sed -i "s|LOGWEAVE_API_KEYS=.*|LOGWEAVE_API_KEYS={\"${API_KEY}\":\"default\"}|" "$ENV_FILE"
  sed -i "s|LOGWEAVE_ENCRYPTION_KEY=.*|LOGWEAVE_ENCRYPTION_KEY=${ENCRYPTION_KEY}|" "$ENV_FILE"
  sed -i "s|LOGWEAVE_CHECKPOINT_HMAC_KEY=.*|LOGWEAVE_CHECKPOINT_HMAC_KEY=${CHECKPOINT_HMAC_KEY}|" "$ENV_FILE"
fi

echo ""
echo "LogWeave setup complete!"
echo ""
echo "  .env created with generated secrets."
echo ""
echo "  Your API key: ${API_KEY}"
echo "  (Save this — you'll need it for the SDK and MCP config)"
echo ""
echo "  Next steps:"
echo "    docker compose -f docker-compose.prod.yml up -d"
echo "    open http://localhost:3000 (login: admin / admin)"
echo ""
