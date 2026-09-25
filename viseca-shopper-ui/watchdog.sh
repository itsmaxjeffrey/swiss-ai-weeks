#!/bin/bash
# Keep the dashboard in its own service, outside OpenClaw exec cleanup.
set -eu
if systemctl --user is-active --quiet viseca-shopper-ui.service; then
  exit 0
fi
systemctl --user start viseca-shopper-ui.service
