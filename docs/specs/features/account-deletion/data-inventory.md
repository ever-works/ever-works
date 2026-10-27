# Account deletion — personal data inventory

What Ever Works stores about a person and what self-serve account deletion
(Settings → Danger Zone, or the email link at `/delete-account`) does to each
kind of data. Code: `apps/api/src/account-deletion/`; the list of workspace
content that is re-attributed instead of deleted is
`apps/api/src/account-deletion/account-deletion.inventory.ts`.

## Public URLs (deployed app) and the fan-out endpoint

| What | URL |
|---|---|
| Request form (public, signed out) | `https://app.ever.works/delete-account` |
| Confirm page (link target; token in the fragment) | `https://app.ever.works/delete-account/confirm#token=<43-char base64url>` |
| Signed-in delete | `https://app.ever.works/settings/danger` (Settings → Danger Zone) |
| **ever.co fan-out** | `POST https://api.ever.works/api/account-deletion/request` body `{"email":"…","callbackUrl":"https://app.ever.works/delete-account/confirm"}` → always `202 {"status":"accepted"}` |
| Verify (confirm page uses it) | `POST https://api.ever.works/api/account-deletion/verify` `{token}` → 200 preview / 410 |
| Confirm | `POST https://api.ever.works/api/account-deletion/confirm` `{token, confirm:true}` → `200 {"deleted":true,"accounts":1,"workspacesDeleted":0|1}` / 410 |

Stage / dev: `app-stage.ever.works` + `api-stage.ever.works`, `app-dev.ever.works` + `api-dev.ever.works` (same paths).
`callbackUrl` is optional; it is honoured only when its host is `WEB_URL`'s host or listed in the API's
`ALLOWED_CALLBACK_HOSTS` (so `https://ever.co/...` works only if ops add `ever.co` there). Otherwise the link opens
`https://app.ever.works/delete-account/confirm`. The contract's extra body fields (`locale`, `appName`, `appLogo`,
`appSignature`, `appLink`, `companyLink`, `companyName`) are accepted and ignored — Ever Works brands its own email.

## How Ever Works is shaped (so the website copy is right)

- One account per email address (no per-workspace accounts like Gauzy).
- An account owns at most **one workspace** (internally a "Tenant") that holds its **Organizations**; or it is a
  **member** of someone else's workspace (joined by an Organization invitation); or it has neither (personal Works only).
- Roles: the workspace owner (one per workspace), and roster roles `admin` / `member`.

## What a deletion does, per kind of data

| Data | Where | On account deletion |
|---|---|---|
| Account, profile (username, display name, avatar, email, password hash, committer name/email, onboarding answers, inferred interests, preferences) | `users` | **Deleted** |
| Sign-in methods (password credential, Google/GitHub/Ever ID links) | `account`, `external_identities` | **Deleted** (FK cascade) |
| Sessions, refresh tokens | `session`, `refresh_tokens` | **Revoked + deleted** — signed out everywhere |
| Personal API keys and integration keys the account created | `api_keys` | **Deleted** (stop working at once) |
| Email verification / magic-link / reset tokens | columns on `users`, `verification` | **Deleted** |
| Works the account created (personal, or in a workspace that is deleted) — items, categories, generation history, schedules, members, invitations, proposals, builds, agent runs | `works` + children | **Deleted.** The platform's own resources for them are released first (App runtime workloads + stored data, ever.works subdomain, local checkouts) |
| Git repositories those Works created **in the user's own GitHub account** | GitHub | **Not touched** — they are the user's, on GitHub; delete them there |
| Workspace the account owns, **alone** (no other members) | `tenants` → `organizations` → all org content | **Deleted** with all its Organizations, Works, Agents, Missions, Tasks, Goals, Teams, Skills, knowledge base, shared views, email addresses… (cascade) |
| Workspace the account owns, **with other members** | `tenants` | **Kept.** Ownership passes to the longest-standing admin (else member); the confirm screens warn "you are the only owner — ownership passes to X" first |
| Content the account created in a workspace that stays (Works, Agents, Missions, Tasks, Goals, Teams, Skills, task templates, knowledge-base folders, email addresses, usage records) | rows with the account as creator | **Kept, re-attributed** to the workspace owner (otherwise the `users` cascades would delete them) |
| Membership of other people's workspaces / Organizations | `organization_members`, `work_members` | **Deleted** — the account leaves |
| Invitations the account sent / accepted | `organization_invitations`, `work_invitations` | Sent ones **deleted**; "accepted by" set to NULL |
| AI conversations, notifications, notification channels + preferences, activity log, digest settings | `conversations`, `notifications`, `notification_channels`, `user_notification_*`, `activity_log` | **Deleted** (cascade) |
| Third-party connections holding the user's credentials (MCP servers, Composio triggers) | `mcp_server_connections`, `composio_trigger_subscriptions` | **Deleted** (cascade) |
| Uploaded files | storage backend (S3 / local / GitHub storage) + `user_uploads` | **Deleted** (`deleteAllByOwner`) + rows cascade |
| Plan subscription | Stripe (via the billing provider seam), `billing_profiles` | **Canceled** (at period end — no further charges); a provider error stops the deletion so a subscription never outlives the account |
| Pay-as-you-go metered subscription | Stripe | **Stopped now**, accrued usage invoiced |
| Invoices, payments, the Stripe customer | **Stripe** (system of record) | **Kept by the payment provider** as the law requires. The platform's local invoice mirror + billing profile rows go with the account |
| Audit record of the deletion | `account_deletion_requests` | **Kept**: SHA-256 of the lower-cased email, source, timestamps, counts. No name, no clear email, no user id after completion |
| Emails already delivered | recipients' mailboxes | Outside our control |
| Encrypted database backups | backup store | Kept until they roll over |

## Email-link security (as built)

Token = 32 random bytes, base64url, in the URL **fragment**; only `sha256(token)` stored; single use (one conditional
UPDATE); 30-minute expiry (`ACCOUNT_DELETION_TOKEN_TTL_MINUTES`, 5..60); a new request revokes older unused links;
deletion only (never a session); identical `202` for every address, lookup + send after the response; limits 5/min per
IP and 3/hour per address (DB-counted, extras dropped silently); `Cache-Control: no-store`; `<meta name="referrer"
content="no-referrer">` + `Referrer-Policy: no-referrer`; PostHog not started on `/delete-account*`; token and email
never logged (mail log shows `email#<sha256 prefix>`).
