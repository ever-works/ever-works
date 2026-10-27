#!/usr/bin/env bash
# Reproducible release build of the screen helper (FL-07, plan T-10) — Linux and macOS.
#
# Builds twice in clean target directories and compares the SHA-256 of both
# binaries; a mismatch fails. Writes unsigned-release-metadata.json with
# productionEligible: false. Uploads nothing. Run by the Screen Helper workflow
# on Linux and macOS (see PACKAGING.md).
set -euo pipefail

cd "$(dirname "$0")"
out_dir="${1:-dist}"
mkdir -p "$out_dir"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) target_name="linux-x64" ;;
  Darwin-arm64) target_name="darwin-arm64" ;;
  Darwin-x86_64) target_name="darwin-x64" ;;
  *) echo "unsupported build host: $(uname -s)-$(uname -m)" >&2; exit 2 ;;
esac

if [ ! -f Cargo.lock ]; then
  echo "Cargo.lock is missing: generate it once (cargo generate-lockfile), review and commit it first" >&2
  exit 2
fi

export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct 2>/dev/null || echo 0)}"
export CARGO_INCREMENTAL=0
export RUSTFLAGS="--remap-path-prefix=$(pwd)=/build/ever-works-screen --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo"

hash_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

for pass in 1 2; do
  rm -rf "target-repro-$pass"
  cargo build --release --locked --target-dir "target-repro-$pass"
done

first="target-repro-1/release/ever-works-screen"
second="target-repro-2/release/ever-works-screen"
sha_one="$(hash_of "$first")"
sha_two="$(hash_of "$second")"
if [ "$sha_one" != "$sha_two" ]; then
  echo "the two builds differ: $sha_one vs $sha_two" >&2
  exit 1
fi

cp "$first" "$out_dir/ever-works-screen"
version="$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)"
cat > "$out_dir/unsigned-release-metadata.json" <<JSON
{
  "schemaVersion": 1,
  "artifact": "ever-works-screen",
  "version": "$version",
  "target": "$target_name",
  "sha256": "$sha_one",
  "reproducible": true,
  "productionEligible": false
}
JSON
echo "ever-works-screen $version ($target_name) sha256 $sha_one"
