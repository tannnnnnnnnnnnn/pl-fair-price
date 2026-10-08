#!/bin/bash
# Usage: ./run.sh          fetch live data, then price
#        ./run.sh --cached price from raw/ only
set -euo pipefail
cd "$(dirname "$0")"
[ "${1:-}" = "--cached" ] || ./fetch.sh
python3 engine.py
python3 consensus.py "$@" || true
