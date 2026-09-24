#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ ! -f "${CFP_STATE_DIR:-.state}/hub.json" ]; then
  node bin/cfp.js init
fi
exec node bin/cfp.js start
