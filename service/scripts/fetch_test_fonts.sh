#!/usr/bin/env bash
# Fonts used ONLY to generate synthetic Korean test pages (SIL OFL 1.1, Google Fonts repo).
set -euo pipefail
cd "$(dirname "$0")/../tests/fonts"
G=https://raw.githubusercontent.com/google/fonts/main/ofl
curl -fsSL -o NotoSansKR.ttf "$G/notosanskr/NotoSansKR%5Bwght%5D.ttf"
curl -fsSL -o BlackHanSans-Regular.ttf "$G/blackhansans/BlackHanSans-Regular.ttf"
echo "194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252  NotoSansKR.ttf
31960809284026681774a8e52dc19ebcad26cf69b0ad9d560f288296fbb52739  BlackHanSans-Regular.ttf" | sha256sum -c -
