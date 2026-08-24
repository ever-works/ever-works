# Billing / Stripe operations runbook

Operator procedures for the Ever Works money path: publishing the Stripe
catalog, turning payments on per environment, and running/verifying
pay-as-you-go. Behaviour spec:
[`docs/specs/features/billing/spec.md`](../specs/features/billing/spec.md);
architecture: [`docs/advanced/subscription-billing.md`](../advanced/subscription-billing.md).

> Ever Works bills through the SHARED "Ever Tech" Stripe account
> (`acct_1IDnd6DdBrwbGEir`). Every object this platform creates is namespaced
> `ever_works_*` (lookup keys) / `ever_sku` metadata — never touch other Ever
> products' objects, and remember the legacy Chargebee webhook on that account
> is subscribed to `*` and will receive every event you generate.

## 1. Publish / verify the catalog

The catalog (`packages/agent/src/subscriptions/billing/stripe-catalog.data.json`)
is applied idempotently by:

```bash
STRIPE_SECRET_KEY=sk_test_… node scripts/stripe-sync-catalog.mjs --dry-run   # show the plan
STRIPE_SECRET_KEY=sk_test_… node scripts/stripe-sync-catalog.mjs             # apply
STRIPE_SECRET_KEY=sk_test_… node scripts/stripe-sync-catalog.mjs --verify    # drift check, exit 1 on drift
```

The key decides the mode (`sk_test_` = test, `sk_live_` = live; live pauses 10 s
before writing). The script creates/updates:

- 22 flat prices (plans, seats, credit packs) matched on `lookup_key`;
- the **Billing Meter** `ever_works_credits` (sum of `value` by
  `stripe_customer_id`) matched on `event_name` — never deleted;
- the **metered graduated price** `ever_works_payg_credits_monthly`
  (1.00¢ ≤ 5,000 credits/cycle, 0.91¢ ≤ 25,000, 0.80¢ beyond). A tier change
  supersedes the price (`transfer_lookup_key`); existing pay-as-you-go
  subscriptions stay on the price they were created with.

Status: **test mode synced + verified 2026-08-24** (0 drift). Live mode needs
an operator run with the live key — do it BEFORE setting the live
`STRIPE_SECRET_KEY` on any environment, or pay-as-you-go enables will 409 with
`payg-price-missing`.

## 2. Turn payments on for an environment

Per environment, in this order:

1. Catalog synced for that Stripe mode (`--verify` → 0 drift).
2. API env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
   (create a webhook endpoint pointing at `POST /api/billing/webhook`
   subscribing to: `checkout.session.completed`, `payment_intent.succeeded`,
   `charge.refunded`, `charge.dispute.created`, `invoice.paid`,
   `invoice.payment_failed`, `invoice.finalized`, `invoice.voided`,
   `customer.subscription.*`, `payment_method.attached`,
   `payment_method.detached`), `SUBSCRIPTIONS_ENABLED=true`.
3. Web env: `PAYMENTS_ENABLED=true`.
4. Stripe Tax needs no flag — every charging session and the pay-as-you-go
   subscription ask for it unconditionally. It DOES need the account to keep
   Stripe Tax active with current registrations; if a registration lapses,
   sessions still succeed but ship without the tax line.
5. Confirm the Trigger.dev crons are deployed: `credits-daily-grant`
   (00:05 UTC — expiries, daily allowance, monthly plan grants) and
   `credits-meter-flush` (\*/5 min — resends failed meter events).

Note `CREDITS_ENFORCEMENT` needs no flipping: unset, it turns on with the
Stripe key. The lazy daily grant in the dispatch gate covers users until the
first 00:05 UTC sweep.

## 3. Pay-as-you-go operations

- **State per user**: `billing_profiles.payg*` columns; usage mirror in
  `credit_meter_events` (identifier `run:{runId}` is also the Stripe meter
  event identifier).
- **Meter events that never landed**: rows with `status='pending'` are retried
  by `credits-meter-flush`; rows older than Stripe's 35-day backdating window
  flip to `failed` with an ERROR log — reconcile those manually (they were
  consumed but never billed).
- **Reconciliation query** (billed vs mirrored, one cycle):

```sql
SELECT "userId", SUM("credits") AS billed, SUM("writtenOffCredits") AS written_off
FROM credit_meter_events
WHERE "periodStart" >= $1 AND "periodStart" < $2 AND status IN ('pending','sent')
GROUP BY "userId";
```

Compare with the Stripe Dashboard → Billing → Meters → `ever_works_credits`.

- **Customer stuck past_due**: they pay the open invoice via the portal
  (Billing page banner). `invoice.paid` flips `paygStatus` back to `active`
  automatically; nothing manual needed.
- **Kill switch**: `PUT /api/billing/payg {"enabled": false}` per user cancels
  the usage subscription immediately and invoices accrued usage; platform-wide,
  removing `STRIPE_SECRET_KEY` fails everything closed (prepaid balances remain
  intact; no meter events are sent while unconfigured).

## 4. Money invariants (what to check when something looks wrong)

- The ledger is the only truth for prepaid credits; Stripe is the only truth
  for pay-as-you-go rating. The join is `credit_meter_events`.
- Every ledger write is idempotent (`{provider}:evt:{eventId}`, `run:{runId}`,
  `daily:{userId}:{date}`, `grant:plan:{userId}:{monthStart}`,
  `expiry:{entryId}`). Replaying a webhook or re-running a cron moves nothing.
- Nothing beyond the user's cap is ever billed: the overshoot is recorded as
  `writtenOffCredits` and absorbed.
- A run is never failed or delayed by billing: settlement, overflow, grants and
  notifications are all best-effort by contract.
