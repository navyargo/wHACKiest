#!/bin/sh
set -e
cd /app
# Apply migrations on every start (idempotent).
pnpm db:migrate
# Seed synthetic demo data only when asked (set SEED_ON_START=true for the first deploy / demo resets).
if [ "$SEED_ON_START" = "true" ]; then
  pnpm db:seed
fi
exec pnpm start
