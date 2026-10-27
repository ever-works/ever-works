#!/usr/bin/env bash
# Sign a release build of the screen helper on macOS (FL-07 P3, owner questions 7 and 17).
#
# Input: the output of build-release.sh (`<dist>/ever-works-screen` and its
# unsigned-release-metadata.json). Output: `<dist>/signed/ever-works-screen`
# and `<dist>/signed/signed-release-metadata.json`, which carries the manifest
# target fields a release publishes (`sha256`, `signedSha256`, `signer`) plus
# the identifier. Uploads nothing; publishing stays an owner-approved step.
#
# The signature: Developer ID Application, a FIXED identifier (release-signing.json),
# the hardened runtime and a secure timestamp:
#   codesign --sign <identity> --identifier <id> --options runtime --timestamp
# It is then checked the way the node checks it (helper-signature.ts), plus the
# identifier: anchor apple generic, the Developer ID intermediate and leaf, the
# leaf's OU = the Team ID, identifier = <id>. Anything else fails the script.
#
# Environment (nothing secret is read from a file or printed):
#   SCREEN_HELPER_SIGN_IDENTITY  the keychain identity (name or SHA-1) to sign with
#   SCREEN_HELPER_TEAM_ID        the Apple Team ID (10 characters); defaults to
#                                release-signing.json darwin.teamId
#   SCREEN_HELPER_DRY_RUN=1      sign ad hoc (identity "-") and check only the
#                                identifier and the runtime flag: the CI exercise
#                                of this script. A dry-run output is never a release.
set -euo pipefail

cd "$(dirname "$0")"
dist="${1:-dist}"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "sign-release.sh signs macOS builds only (Windows: sign-release.ps1; Linux has no signed level)" >&2
  exit 2
fi
codesign=/usr/bin/codesign

field() { # field <json file> <key>: the first string value of "key" (flat JSON written by these scripts)
  sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" | head -1
}

unsigned="$dist/ever-works-screen"
metadata="$dist/unsigned-release-metadata.json"
if [ ! -f "$unsigned" ] || [ ! -f "$metadata" ]; then
  echo "run build-release.sh first: $unsigned and $metadata are needed" >&2
  exit 2
fi
identifier="$(field release-signing.json identifier)"
if ! printf '%s' "$identifier" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$'; then
  echo "release-signing.json has no usable identifier" >&2
  exit 2
fi
sha256="$(field "$metadata" sha256)"
version="$(field "$metadata" version)"
target="$(field "$metadata" target)"
hash_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
if [ "$(hash_of "$unsigned")" != "$sha256" ]; then
  echo "$unsigned is not the build its metadata describes" >&2
  exit 1
fi

dry_run="${SCREEN_HELPER_DRY_RUN:-0}"
if [ "$dry_run" = "1" ]; then
  identity="-"
  team_id=""
else
  identity="${SCREEN_HELPER_SIGN_IDENTITY:-}"
  team_id="${SCREEN_HELPER_TEAM_ID:-$(field release-signing.json teamId)}"
  if [ -z "$identity" ] || [ "$identity" = "-" ]; then
    echo "SCREEN_HELPER_SIGN_IDENTITY must name a Developer ID Application identity (an ad hoc signature is a dry run)" >&2
    exit 2
  fi
  if ! printf '%s' "$team_id" | grep -Eq '^[A-Z0-9]{10}$'; then
    echo "no Apple Team ID: set SCREEN_HELPER_TEAM_ID or release-signing.json darwin.teamId (owner question 7)" >&2
    exit 2
  fi
fi

out="$dist/signed"
rm -rf "$out"
mkdir -p "$out"
signed="$out/ever-works-screen"
cp "$unsigned" "$signed"

if [ "$dry_run" = "1" ]; then
  "$codesign" --force --sign - --identifier "$identifier" --options runtime "$signed"
  "$codesign" --verify --strict -- "$signed"
  details="$("$codesign" --display --verbose=2 -- "$signed" 2>&1)"
  printf '%s\n' "$details" | grep -q "^Identifier=$identifier\$" || { echo "the identifier was not stamped" >&2; exit 1; }
  printf '%s\n' "$details" | grep -Eq '^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*runtime' || { echo "the hardened runtime flag is missing" >&2; exit 1; }
  # A Developer ID requirement must refuse an ad hoc signature: the check below is the one a real run passes.
  if "$codesign" --verify --strict -R="anchor apple generic and identifier \"$identifier\"" -- "$signed" 2>/dev/null; then
    echo "an ad hoc signature satisfied an Apple-anchored requirement" >&2
    exit 1
  fi
  signer=""
else
  "$codesign" --force --sign "$identity" --identifier "$identifier" --options runtime --timestamp "$signed"
  requirement="anchor apple generic"
  requirement="$requirement and certificate 1[field.1.2.840.113635.100.6.2.6] exists"
  requirement="$requirement and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
  requirement="$requirement and certificate leaf[subject.OU] = \"$team_id\""
  requirement="$requirement and identifier \"$identifier\""
  "$codesign" --verify --strict -R="$requirement" -- "$signed"
  signer="$team_id"
fi

signed_sha256="$(hash_of "$signed")"
cat > "$out/signed-release-metadata.json" <<JSON
{
  "schemaVersion": 1,
  "artifact": "ever-works-screen",
  "version": "$version",
  "target": "$target",
  "sha256": "$sha256",
  "signedSha256": "$signed_sha256",
  "signer": "$signer",
  "identifier": "$identifier",
  "dryRun": $([ "$dry_run" = "1" ] && echo true || echo false),
  "productionEligible": false
}
JSON
echo "ever-works-screen $version ($target) signed$([ "$dry_run" = "1" ] && echo ' ad hoc (dry run)') identifier $identifier sha256 $signed_sha256"
