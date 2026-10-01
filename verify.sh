#!/usr/bin/env bash
set -euo pipefail

echo "========================================"
echo "  E.R.I.C.A. Verification Pipeline"
echo "========================================"

echo ""
echo "--> [1/2] Running TypeScript strict typecheck (tsc --noEmit)..."
npm run typecheck

echo ""
echo "--> [2/2] Running automated test matrix..."
npm test

echo ""
echo "========================================"
echo "✔ All verification checks passed cleanly."
echo "========================================"
