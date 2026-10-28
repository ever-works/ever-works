# Ever Works account deletion: screenshots (local run, 2026-10-28)

All screenshots come from a local run of `ever-works/ever-works` PR #2986 (`feat/account-deletion-email-link`).
The setup was the web app on `localhost:3060`, the API on `localhost:3061`, Postgres 17, and a local SMTP catcher
for email. The accounts (alice / bob / carol / dave `@test.local`) are test data. The dark theme is the app default.

## In-product delete (Settings → Danger Zone)

Alice owns the workspace "Acme Labs". Bob is a member of it.

| File | What it shows |
|---|---|
| `01-danger-zone.png` | Settings → Danger Zone, before anything is clicked. |
| `02-danger-zone-what-will-be-deleted.png` | After clicking "Delete My Account", the page shows what will be deleted. Alice owns a workspace that has another member, so the workspace and its content are kept and **bob becomes its owner**. A sole-owner warning appears ("You are the only owner. Ownership… passes to bob"). The "Kept" list covers invoices with the payment provider, the hashed audit record, backups, and repositories in the user's own GitHub account. |
| `03-danger-zone-typed-confirmation.png` | The account email typed as confirmation. The match is case-insensitive, so `Alice@Test.local` works. The red button is enabled. |
| `04-signed-out-account-deleted.png` | After deletion the user is signed out and sent to `/login?accountDeleted=1`, which shows "Your account was deleted…". The sign-in page also links to the email flow ("Want to delete your account? Request a deletion link"). |
| `05-account-deleted-email.png` | The "Your account was deleted" email, captured by the local catcher. It says the workspace was handed to another member and that sessions and API keys were revoked. |

## Email-link deletion (public, signed out)

Carol is the only member of her workspace "Carol Studio".

| File | What it shows |
|---|---|
| `06-request-form.png` | `/delete-account`, the public request form, reached from the sign-in page link. It asks for an email address only. |
| `07-request-sent.png` | The answer after submitting. It is the same whether or not an account exists ("If an account exists for …"). |
| `08-deletion-link-email.png` | The email with the link, which works once and expires in 30 minutes. The link is `…/delete-account/confirm#token=<43-char token>`, so the token is in the URL fragment. |
| `09-confirm-page-what-will-be-deleted.png` | `/delete-account/confirm` after opening the link. The token has already been removed from the address bar. The page shows the masked email (`c***@test.local`) and what will be deleted: Carol is the only member, so the workspace, its organizations and all their content go. Nothing has been deleted at this point. |
| `10-confirm-page-typed-delete.png` | Typed confirmation (`DELETE`). The delete button is enabled. |
| `11-account-deleted.png` | The result: "Your account was deleted". A confirmation email was sent. |
| `12-deleted-account-cannot-sign-in.png` | Signing in as carol now fails with "Invalid email or password". |
| `13-used-link-refused.png` | Opening the same link again shows "This link can no longer be used" (the API answers `410`). |

## Checked alongside the screenshots (API and database)

- Alice: user row deleted. The tenant "Acme Labs" now belongs to bob, and her missions were re-attributed to bob
  (`contentReassigned: 2`). Her API key and 7 sessions are gone. The audit row is `in_product / completed` with a
  hashed email, the user id cleared and counts only.
- Carol: user, workspace, organization, missions, API key and sessions are deleted. Her old API key returns `401`,
  and signing in returns `401`. Reusing the link returns `410` from both verify and confirm. The audit row is
  `email_link / completed`.
- Dave: four requests within one minute gave four identical `202` answers. Three emails were sent, and the fourth
  request was dropped silently (3 per hour per address). The two older links were `revoked`. Seven quick requests
  from one IP gave `202` then `429` (5 per minute per IP).
- `/delete-account` and `/delete-account/confirm` send `Cache-Control: no-store` and `Referrer-Policy: no-referrer`,
  and include `<meta name="referrer" content="no-referrer">` and `noindex`. PostHog is not loaded on them. The API
  log shows the address only as a hash handle (`email#<sha256 prefix>`) and the mail log as `[redacted]`; the token appears nowhere in either log.
