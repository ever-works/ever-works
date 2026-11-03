/**
 * EW-58 — the GitHub Actions workflow that turns a data update in an
 * Ever Works data repository into a git tag and a GitHub Release.
 *
 * The canonical, human-editable artifact is the real workflow file next to
 * this module (`assets/data-repo-release.yml`); the constant below is a
 * generated, byte-identical copy of it so the data generator can write the
 * file at runtime without depending on asset copying or on `__dirname` (the
 * agent package is compiled by SWC and re-bundled by esbuild for the
 * Trigger.dev worker, and neither preserves sibling files).
 *
 * After editing the YAML, run:
 *
 *   node scripts/generate-data-repo-release-workflow.mjs
 *
 * `release-workflow.spec.ts` fails if the two ever drift apart.
 */

/** Where the workflow lives inside a data repository. */
export const DATA_REPO_RELEASE_WORKFLOW_PATH = '.github/workflows/release.yml';

/**
 * Revision of the workflow this build ships. Bump it (here AND in the
 * `x-ever-works-workflow-version` comment inside the YAML) whenever the
 * workflow changes in a way that already-seeded repositories should pick up;
 * {@link DataRepository.ensureReleaseWorkflow} upgrades any managed copy that
 * carries a lower number.
 */
export const DATA_REPO_RELEASE_WORKFLOW_VERSION = 1;

/**
 * Marker comment that identifies a copy of the workflow as platform-managed.
 * A file without it was authored (or adopted) by the repository owner and is
 * never touched.
 */
export const DATA_REPO_RELEASE_WORKFLOW_MARKER = 'data-repo-release';

const MARKER_PATTERN = /^#[ \t]*x-ever-works-workflow:[ \t]*([A-Za-z0-9._-]+)[ \t]*$/m;
const VERSION_PATTERN = /^#[ \t]*x-ever-works-workflow-version:[ \t]*(\d{1,9})[ \t]*$/m;

/**
 * True when `content` is a copy of this workflow that the platform owns, i.e.
 * it still carries the `x-ever-works-workflow: data-repo-release` marker.
 */
export function isManagedReleaseWorkflow(content: string): boolean {
    return MARKER_PATTERN.exec(content)?.[1] === DATA_REPO_RELEASE_WORKFLOW_MARKER;
}

/**
 * Revision recorded in a managed copy of the workflow, or `null` when the
 * content is not managed or carries no readable version marker.
 */
export function parseReleaseWorkflowVersion(content: string): number | null {
    if (!isManagedReleaseWorkflow(content)) {
        return null;
    }

    const match = VERSION_PATTERN.exec(content);
    if (!match) {
        return null;
    }

    const version = Number.parseInt(match[1], 10);
    return Number.isSafeInteger(version) ? version : null;
}

// <generated from assets/data-repo-release.yml>
export const DATA_REPO_RELEASE_WORKFLOW = `# Ever Works — automated releases for a data repository (EW-58).
#
# Drop-in workflow: copy this file to \`.github/workflows/release.yml\` in any
# Ever Works data repository (the \`*-data\` repos that back a Work). It needs no
# secrets and no configuration — the built-in \`GITHUB_TOKEN\` is enough — and it
# is installed automatically by the Ever Works data generator on every data
# repository it creates or regenerates.
#
# What it does: whenever generated content lands on the default branch it
# resolves the next semantic version and creates the matching \`vX.Y.Z\` tag plus
# a GitHub Release with generated notes. Downstream websites can then pin or
# display an exact data version instead of a bare commit hash.
#
# Version resolution order:
#   1. the explicit \`version\` input (manual runs only);
#   2. \`version:\` from \`.works/works.yml\` — the value the Ever Works data
#      generator already bumps on every generation — when it is a semver that
#      has not been released yet;
#   3. the newest existing \`v*\` tag, incremented with the same rollover rules
#      the generator uses (patch + 1; patch >= 100 rolls into minor;
#      minor >= 10 rolls into major);
#   4. \`0.1.0\` for a repository that has never been released.
#
# A commit that is already tagged is never released twice, so re-running the
# workflow by hand is safe.
#
# MANAGED FILE — do not remove the two \`x-ever-works-workflow*\` lines below.
# The Ever Works data generator uses them to recognise the copy it owns and to
# upgrade it in place when a newer revision ships. Remove the marker, or edit
# this file while keeping the same version number, and the platform will leave
# your copy alone.
#
# x-ever-works-workflow: data-repo-release
# x-ever-works-workflow-version: 1

name: Release data

on:
  push:
    branches:
      - main
      - master
    # Content-bearing paths only. A settings-only \`.works/works.yml\` edit is
    # deliberately NOT a release trigger; use the manual run for that.
    paths:
      - 'data/**'
      - 'markdown/**'
      - 'pages/**'
      - 'categories.yml'
      - 'collections.yml'
      - 'tags.yml'
      - 'references.yml'
  workflow_dispatch:
    inputs:
      version:
        description: 'Explicit version to release (e.g. 1.2.3). Leave empty to auto-increment.'
        required: false
        type: string

# Declare the minimum explicitly rather than inheriting the repository default:
# pushing a tag and creating a release both need \`contents: write\`.
permissions:
  contents: write

# Serialize releases per branch. \`cancel-in-progress\` is deliberately FALSE —
# cancelling a half-finished tag bump loses a release, and the data generator
# pushes several commits in quick succession.
concurrency:
  group: ever-works-data-release-\${{ github.ref }}
  cancel-in-progress: false

jobs:
  release:
    name: Tag and release
    runs-on: ubuntu-latest
    timeout-minutes: 15
    # A manual run only makes sense on the branch the data actually lives on.
    if: >-
      github.event_name != 'workflow_dispatch' ||
      github.ref_name == github.event.repository.default_branch

    steps:
      - name: Check out the full history and tags
        uses: actions/checkout@v7
        with:
          fetch-depth: 0

      - name: Resolve the next version
        id: resolve
        env:
          REQUESTED_VERSION: \${{ inputs.version }}
        run: |
          set -euo pipefail

          semver_re='^[0-9]+\\.[0-9]+\\.[0-9]+$'
          tag_re='^v[0-9]+\\.[0-9]+\\.[0-9]+$'

          tag_exists() {
            git rev-parse -q --verify "refs/tags/$1" >/dev/null 2>&1
          }

          # Same rollover rules as DataRepository.getNextVersion() in the
          # Ever Works platform, so tags and \`.works/works.yml\` stay in step.
          bump() {
            local base="$1" major rest minor patch
            # \`10#\` forces base 10: a stray leading zero would otherwise be
            # read as octal and \`08\` would abort the arithmetic.
            major=$((10#\${base%%.*}))
            rest="\${base#*.}"
            minor=$((10#\${rest%%.*}))
            patch=$((10#\${rest##*.}))
            patch=$((patch + 1))
            if [ "$patch" -ge 100 ]; then
              patch=0
              minor=$((minor + 1))
            fi
            if [ "$minor" -ge 10 ]; then
              minor=0
              patch=0
              major=$((major + 1))
            fi
            printf '%s.%s.%s' "$major" "$minor" "$patch"
          }

          # Never release the same commit twice — keeps re-runs idempotent.
          already="$(git tag --points-at HEAD | grep -E "$tag_re" | head -n 1 || true)"
          if [ -n "$already" ]; then
            echo "HEAD is already released as $already — nothing to do."
            echo 'release=false' >> "$GITHUB_OUTPUT"
            exit 0
          fi

          next=''

          requested="\${REQUESTED_VERSION:-}"
          if [ -n "$requested" ]; then
            requested="$(printf '%s' "$requested" | tr -d "\\"' " | sed -e 's/^v//')"
            if ! printf '%s' "$requested" | grep -Eq "$semver_re"; then
              echo "::error::The requested version is not a MAJOR.MINOR.PATCH version."
              exit 1
            fi
            if tag_exists "v$requested"; then
              echo "::error::Tag v$requested already exists."
              exit 1
            fi
            next="$requested"
            echo "Using the requested version $next"
          fi

          if [ -z "$next" ] && [ -f .works/works.yml ]; then
            line="$(grep -m 1 -E '^version:[[:space:]]*' .works/works.yml || true)"
            candidate="$(printf '%s' "$line" \\
              | sed -e 's/^version:[[:space:]]*//' -e 's/[[:space:]]*$//' \\
              | tr -d "\\"'" \\
              | sed -e 's/^v//')"
            if printf '%s' "$candidate" | grep -Eq "$semver_re" && ! tag_exists "v$candidate"; then
              next="$candidate"
              echo "Using version $next from .works/works.yml"
            fi
          fi

          if [ -z "$next" ]; then
            # Strict \`vMAJOR.MINOR.PATCH\` only: a prerelease or a differently
            # shaped tag must not become the base we increment from.
            latest="$(git tag --list 'v[0-9]*' --sort=-v:refname | grep -E "$tag_re" | head -n 1 || true)"
            base="\${latest#v}"
            if printf '%s' "$base" | grep -Eq "$semver_re"; then
              next="$(bump "$base")"
              echo "Incrementing $latest -> v$next"
            else
              next='0.1.0'
              echo "No previous release found — starting at v$next"
            fi
          fi

          # A tag pushed while this run was queued must not collide with ours.
          attempts=0
          while tag_exists "v$next" && [ "$attempts" -lt 50 ]; do
            next="$(bump "$next")"
            attempts=$((attempts + 1))
          done
          if tag_exists "v$next"; then
            echo "::error::Could not find an unused version after $attempts attempts (last tried v$next)."
            exit 1
          fi

          {
            echo 'release=true'
            echo "version=$next"
            echo "tag=v$next"
          } >> "$GITHUB_OUTPUT"

      - name: Create the tag and the GitHub release
        if: steps.resolve.outputs.release == 'true'
        uses: ncipollo/release-action@v1
        with:
          tag: \${{ steps.resolve.outputs.tag }}
          name: \${{ steps.resolve.outputs.tag }}
          commit: \${{ github.sha }}
          # No explicit \`body\`: GitHub builds the notes from the commits made
          # since the previous release.
          generateReleaseNotes: true
          allowUpdates: false
          skipIfReleaseExists: true
          prerelease: false
          makeLatest: true
          token: \${{ secrets.GITHUB_TOKEN }}

      - name: Report the outcome
        if: always()
        env:
          RELEASED: \${{ steps.resolve.outputs.release }}
          TAG: \${{ steps.resolve.outputs.tag }}
        run: |
          set -euo pipefail
          if [ "\${RELEASED:-}" = 'true' ]; then
            echo "Released \\\`\${TAG}\\\`." >> "$GITHUB_STEP_SUMMARY"
          else
            echo 'No release: this commit is already tagged.' >> "$GITHUB_STEP_SUMMARY"
          fi
`;
// </generated from assets/data-repo-release.yml>
