#!/usr/bin/env bash
# Build dist/rfsafe-phone-agent-v<version>.zip from an allow-list, secret-scan staging AND the unpacked zip.
set -euo pipefail
cd "$(dirname "$0")/.."
VER=$(node -p 'require("./package.json").version'); NAME="rfsafe-phone-agent-v$VER"
STAGE=$(mktemp -d)/"$NAME"; mkdir -p "$STAGE" dist
cp -r bin src demo deploy scripts test "$STAGE"/
cp package.json README.md DESIGN.md DEPLOY.md RESEARCH.md WIKI_PAGE.md CHANGELOG.md GO-LIVE.md render.yaml .gitignore "$STAGE"/
find "$STAGE" \( -name '.env' -o -name '.env.*' -o -name 'data' -o -name '*.pem' -o -name '*.key' -o -name 'secrets.enc.json' -o -name 'consent.jsonl' -o -name 'owner-outbox.jsonl' -o -name 'owner-pins.json' \) -prune -print -exec rm -rf {} +
node scripts/scan-secrets.js "$STAGE"
rm -f "dist/$NAME.zip"
python3 - "$STAGE" "dist/$NAME.zip" <<'PYZ'
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]; base = os.path.dirname(src)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(src):
        dirs.sort()
        for f in sorted(files):
            p = os.path.join(root, f); info = zipfile.ZipInfo(os.path.relpath(p, base), (2026, 10, 29, 0, 0, 0))
            info.external_attr = (0o755 if os.access(p, os.X_OK) else 0o644) << 16; info.compress_type = zipfile.ZIP_DEFLATED
            with open(p, "rb") as fh: z.writestr(info, fh.read())
PYZ
( cd dist && sha256sum "$NAME.zip" > "$NAME.zip.sha256" )
CHECK=$(mktemp -d); unzip -q "dist/$NAME.zip" -d "$CHECK"; node scripts/scan-secrets.js "$CHECK/$NAME"
( cd "$CHECK/$NAME" && node --test ./test/*.test.js >/dev/null && echo "tests pass from unpacked zip" )
echo "built dist/$NAME.zip, $(unzip -l "dist/$NAME.zip" | tail -1 | awk '{print $2}') files"; cat "dist/$NAME.zip.sha256"
rm -rf "$CHECK" "$(dirname "$STAGE")"
