#!/bin/bash
# Self-healing watchdog for the shopper UI on :8794.
# Registered via automations (command payload, every 5 min). Silent when healthy.
cd "$(dirname "$0")" || exit 1
if curl -s --noproxy '*' -o /dev/null -m 5 http://127.0.0.1:8794/api/health; then
  exit 0
fi
echo "$(date -Is) health check failed — relaunching" >> server.log
setsid nohup env HOST=0.0.0.0 PORT=8794 DUMMY_EMAIL=guest@pixerful.com \
  OPENCLAW_MODEL=zai/glm-5.3 OPENCLAW_GATEWAY_PORT=18789 \
  OPENCLAW_TIMEOUT_MS=900000 OPENCLAW_OVERALL_BUDGET_MS=890000 \
  node server.js >> server.log 2>&1 < /dev/null &
sleep 3
if curl -s --noproxy '*' -o /dev/null -m 5 http://127.0.0.1:8794/api/health; then
  echo "$(date -Is) relaunched ok" >> server.log
else
  echo "$(date -Is) relaunch FAILED — inspect manually" >> server.log
fi
