#!/usr/bin/env bash
# EW-643 Phase 3 — static gate for KB body content in telemetry events.
#
# Acceptance criterion A40 (spec acceptance.md / spec.md §22):
#
#   > No KB body content appears in webhooks, telemetry, or activity-log
#   > payloads (verified by a static-grep CI check on event-emitter call
#   > sites).
#
# This script implements that check. It greps every call site that passes a
# payload object to PostHog (`capture(`), the activity-log facade
# (`activityLogService.create(`), and the typed KB event emitter
# (`emitKbEvent(`) and looks for any object literal property keyed with one
# of the forbidden body-ish names enumerated in
# `packages/monitoring/src/posthog/kb-events.ts`
# (`KB_EVENTS_FORBIDDEN_PROPERTY_KEYS`).
#
# Forbidden keys (must stay in sync with kb-events.ts):
#   body, content, markdown, text, html, excerpt, snippet, chunk, raw, preview
#
# Exit codes:
#   0 — no violations
#   1 — one or more violations (CI fails)
#   2 — environment/usage error
#
# The check is intentionally conservative: it scans only directories where
# KB-related code lives, and explicitly whitelists `kb-events.ts` (the
# defining module) plus any line marked `// kb-events-allow:<reason>`.

set -euo pipefail

ROOT="${1:-.}"

# Directories likely to emit telemetry events. Keep tight so the grep stays
# fast on the full monorepo (~7000 TS files).
SCOPE=(
    "$ROOT/apps/api/src"
    "$ROOT/apps/web/src"
    "$ROOT/apps/mcp/src"
    "$ROOT/apps/cli/src"
    "$ROOT/packages/agent/src"
    "$ROOT/packages/tasks/src"
)

FORBIDDEN='\b(body|content|markdown|text|html|excerpt|snippet|chunk|raw|preview)\b\s*:'

# Find emit-event-like call sites first (cheap), then check whether the next
# ~10 lines after that call contain a forbidden property literal. This avoids
# false positives on unrelated code that happens to use "content" as a prop
# name far away from any analytics emit.
EMIT_CALLERS='(emitKbEvent\(|posthog\.capture\(|posthogClient\.capture\(|activityLogService\.create\(|activityLog\.create\()'

violations=0
exists=0
for dir in "${SCOPE[@]}"; do
    if [ ! -d "$dir" ]; then continue; fi
    exists=1
    while IFS= read -r -d '' file; do
        # Skip the defining module + its tests.
        case "$file" in
            */kb-events.ts|*/kb-events.spec.ts|*/no-kb-body-in-events.sh)
                continue
                ;;
        esac
        # Use awk to find emit calls and inspect the next 12 lines for forbidden keys.
        # `kb-events-allow:<reason>` comment on the property line whitelists it.
        if awk -v pat="$EMIT_CALLERS" -v forbidden="$FORBIDDEN" '
            BEGIN { window=0; found=0 }
            /kb-events-allow:/ { allow_line=NR }
            $0 ~ pat { window=12; emit_line=NR; emit_text=$0 }
            window > 0 {
                if ($0 ~ forbidden && NR != allow_line) {
                    printf("%s:%d: forbidden body-ish property near emit on line %d (%s)\n",
                        FILENAME, NR, emit_line, $0)
                    found=1
                }
                window--
            }
            END { exit found }
        ' "$file"; then
            :
        else
            violations=$((violations + 1))
        fi
    done < <(find "$dir" -type f \( -name '*.ts' -o -name '*.tsx' \) -print0)
done

if [ "$exists" -eq 0 ]; then
    echo "no-kb-body-in-events: no scope directories found under '$ROOT' (root flag wrong?)" >&2
    exit 2
fi

if [ "$violations" -gt 0 ]; then
    echo "no-kb-body-in-events: FAILED — $violations call site(s) include forbidden KB body content" >&2
    echo "  Add '// kb-events-allow: <short reason>' on the property line to whitelist intentional cases." >&2
    exit 1
fi

echo "no-kb-body-in-events: OK — no body-ish properties near event emitters."
exit 0
