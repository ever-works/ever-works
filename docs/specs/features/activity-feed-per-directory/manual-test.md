# Manual Test Guide — EW-120 Activity Feed (Phases 1-5)

> What's actually testable today **without** the directory-template
> endpoint (Phase 6). The deployed-site source will always show the
> "not_provisioned" degraded banner until Phase 6 lands; that is the
> expected v1 behaviour for new installs.

## 1. Set up the local stack

```powershell
# In the worktree
cd C:\Coding\Worktrees\wt-1503730456875765900-ew120

# One-time: install + build (only needed if you haven't already)
pnpm install
pnpm build

# Set the new env var. 32 random bytes hex-encoded (64 chars).
$env:PLATFORM_ENCRYPTION_KEY = (node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
Write-Host "PLATFORM_ENCRYPTION_KEY=$env:PLATFORM_ENCRYPTION_KEY"

# Start API + Web in two terminals
pnpm dev:api        # port 3100
pnpm dev:web        # port 3000
```

The first time the API starts, the new migration
`1778615285640-AddWorkPlatformSync` runs and adds four columns to the
`works` table.

## 2. Smoke-check the migration

```powershell
# Hit the API root or any work endpoint. Just confirm the API came up
# clean. The interesting probe is whether the migration ran.
curl http://localhost:3100/api/health

# If you have direct DB access (sqlite or psql), inspect the columns:
#   sqlite> .schema works
#   psql=> \d works
# Expect 4 new columns:
#   - platformSyncSecretEncrypted (text, nullable)
#   - platformSyncEnabled (boolean, default true)
#   - platformSyncLastSuccessAt (bigint, nullable)
#   - platformSyncLastError (varchar, nullable)
```

## 3. Visual: Activity Feed tab

1. Log in at <http://localhost:3000>.
2. Open any existing Work, or create one (Dashboard → New Work → fast
   path with a built-in template is fine).
3. Look at the tab strip. The order should now read:
   **Overview · Activity Feed · Items · Generator · Plugins · Deploy · Settings**.
4. Click **Activity Feed**.

Expected:

- Page header reads "Activity Feed" with the subtitle.
- A skeleton list shows for ~200 ms while the first fetch resolves.
- For a fresh Work with no events, the empty state renders.
- For a Work that has been generated or deployed at least once,
  rows appear newest first with relative timestamps ("3 minutes ago").
- A yellow **degraded** banner says
  "Deployed-site events not yet available — Never synced. Will retry on
  next deploy." That's the expected state because Phase 6 isn't merged
  yet. (Or "Last successful sync: ..." once Phase 6 lands and the next
  deploy pushes the secret.)

## 4. Filter chips

1. From the Activity Feed tab, click the chip labelled **Deployment**.
2. The list narrows to deploy entries (or shows zero if you haven't
   deployed). The URL gains `?category=deployment`.
3. Reload the page. The chip stays selected — the page hydrates from
   the URL.
4. Click **Users**. The deployed-site chips (Users / Submissions /
   Reports) should appear visibly dimmed because the deployed-site
   source is not provisioned. Clicking them still works but returns
   zero rows — confirms the dim is informational only.
5. Click **All** to clear the filter. URL drops the `category` param.

## 5. Auto-refresh

1. With the Activity Feed tab open, leave the browser tab focused.
2. In another terminal, trigger a platform event for this Work — the
   easiest is to start a generation:
   ```powershell
   # Or do this through the UI: Generator → Regenerate
   ```
3. Within ~5 seconds the new row should appear at the top of the feed
   without clicking anything.
4. Switch to a different browser tab. Trigger another event.
5. Wait 30 seconds. Return to the Activity Feed tab. The poll fires
   once immediately on `visibilitychange`, so the new event should
   appear within 5 s of returning.

## 6. Manual refresh

Click the **Refresh** button in the page header. The icon spins briefly
and the feed refetches. Rows do not unmount — there should be no
visible flash or scroll jump.

## 7. Overview "Recent Activity" widget

1. Click the **Overview** tab.
2. Look at the "Activity Feed" card on the right side of the layout.
3. Confirm it now lists up to 5 real entries (not the hardcoded "Work
   Created" mock from before).
4. Click **View all →** in the card header. You should land on the
   Activity Feed tab.

## 8. Deep links

From the Activity Feed tab:

- Click any **generation** row → should navigate to
  `/works/<id>/generator/history?run=<id>`. The existing History page
  renders the run detail.
- Click any **deployment / plugin / settings** row → URL becomes
  `/activity?entry=<id>`. (The global activity page handles the
  drill-down separately; this is the Phase 4 v1 behaviour. A future
  PR can swap this for an inline `ActivityDetailModal`.)

## 9. Access control

1. Note the Work's ID from the URL (`/works/<id>/activity`).
2. Log out and back in as a user who is **not** the owner or a member
   of that Work.
3. Visit `http://localhost:3000/works/<id>/activity` directly.
4. Expected: a `404 Not Found` (the RSC page calls `workAPI.get(id)`
   server-side, which throws if the viewer lacks access, and the page
   triggers `notFound()`).

## 10. API smoke test (optional)

```powershell
# Replace WORK_ID and the auth cookie value as needed.
curl -H "Cookie: <your-auth-cookie>" "http://localhost:3100/api/works/$WORK_ID/activity-feed?limit=5"

# Expected response shape:
# {
#   "entries": [...],
#   "nextCursor": null,
#   "serverTime": "2026-05-13T...",
#   "degraded": { "directorySite": { "reason": "not_provisioned", ... } }
# }
```

## 11. Degraded-banner sanity check

Toggle `platformSyncEnabled` to `false` on a Work row (via SQL or by
re-saving from the Settings tab once that toggle is wired — currently
only the DB-level flag exists). The banner should switch from
`not_provisioned` to `disabled`, and the deployed-site chips dim.

## 12. What you should NOT expect to see (yet)

- Real user-registration / item-submission / report rows from the
  deployed site. These need Phase 6 (the template-side endpoint) +
  one deploy of the Work after Phase 6 ships.
- A "Sync activity from deployed site" toggle in the directory Settings
  tab. The column exists but the UI control hasn't been added yet (it's
  a small follow-up).
- WebSocket / SSE live updates. The feed polls — explicit v1 scope.
- Per-user read state / unread badges. Not part of this PR.

## Quality-gate snapshot

| Gate | Result |
|---|---|
| Agent jest | 4272 / 4272 pass |
| API jest | 1878 / 1878 pass |
| Web vitest | 36 / 36 pass |
| `pnpm build` | 54 / 54 turbo tasks successful |
| `prettier --check` on touched files | clean after auto-format pass |
| New API endpoint type-check | clean (no new errors above develop baseline) |

## Known limitations that are NOT regressions

1. **Activity-log scope is per viewer, not per Work.** The aggregator
   passes `ctx.userId` to `ActivityLogService.findAll`, which hard-codes
   `WHERE activity.userId = :userId`. So events on a Work performed by
   *other* members aren't visible to the viewer. This matches the
   existing `/dashboard/activity` behaviour. Fixing it requires a new
   `findByWorkId` repo method that drops the userId filter.
   Follow-up ticket, not a blocker for v1.
2. **Old `WorkActivity` i18n keys** (`noActivity`, `created`,
   `workCreated`, `justNow`) are kept in en.json for back-compat with
   the original mock; the rewired component no longer uses them. Safe
   to delete in a future cleanup.
