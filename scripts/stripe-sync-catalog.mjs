#!/usr/bin/env node
/**
 * Apply packages/agent/src/subscriptions/billing/stripe-catalog.data.json to Stripe, idempotently.
 *
 *   node scripts/stripe-sync-catalog.mjs --dry-run     # show the plan, touch nothing
 *   node scripts/stripe-sync-catalog.mjs               # apply
 *   node scripts/stripe-sync-catalog.mjs --verify      # report drift only, exit 1 if any
 *
 * Reads STRIPE_SECRET_KEY from the environment. The key decides which mode is written: an
 * `sk_test_…` key syncs test mode, an `sk_live_…` key syncs live. There is no --live flag on
 * purpose — you cannot reach live by forgetting an argument.
 *
 * This is the Ever Works twin of ever-co/ever-website's scripts/stripe-sync-catalog.mjs, and it
 * writes into the SAME shared Stripe account. It differs in three ways, all additive:
 *   1. it syncs ONE product family (Ever Works) rather than a list of them;
 *   2. it also emits per-additional-seat prices (`…_seat_monthly` / `…_seat_annual`);
 *   3. it also emits one-time credit-pack prices (`ever_works_credits_<n>`).
 *
 * ## Idempotency
 * Products are matched on metadata `ever_sku` (a stable per-SKU id); prices on `lookup_key`.
 * Re-running with an unchanged catalog makes zero writes.
 *
 * ## Prices are immutable in Stripe
 * If a catalog amount changes, the existing price cannot be edited. The script creates a new price,
 * moves the lookup_key onto it (`transfer_lookup_key`), then archives the old one. Existing
 * subscriptions stay on the price they were created with — that is Stripe's behaviour, and it is
 * what you want: nobody's bill changes silently.
 *
 * 🛑 The script never deletes anything, and never archives a product. It also never touches an
 * object belonging to another Ever product: every write is gated on the `ever_works_` lookup-key
 * prefix and the `ever_product=works` metadata.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = join(
  HERE,
  '..',
  'packages',
  'agent',
  'src',
  'subscriptions',
  'billing',
  'stripe-catalog.data.json'
);

const DRY_RUN = process.argv.includes('--dry-run');
const VERIFY = process.argv.includes('--verify');
const API = 'https://api.stripe.com/v1';

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) {
  console.error('STRIPE_SECRET_KEY is not set. Refusing to run.');
  process.exit(1);
}
const MODE = KEY.startsWith('sk_live_') ? 'LIVE' : KEY.startsWith('sk_test_') ? 'TEST' : 'UNKNOWN';
if (MODE === 'UNKNOWN') {
  console.error('STRIPE_SECRET_KEY is neither sk_test_ nor sk_live_. Refusing to run.');
  process.exit(1);
}

/* ------------------------------------------------------------------ Stripe */

/** Stripe wants application/x-www-form-urlencoded with bracketed nesting. */
function encodeForm(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object' && !Array.isArray(v)) encodeForm(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

async function stripe(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      // Kept in step with the account-wide sync script so both see the same API shape.
      'Stripe-Version': '2025-02-24.acacia'
    },
    body: body ? encodeForm(body).join('&') : undefined
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Stripe ${method} ${path} -> ${res.status}: ${json?.error?.message ?? 'unknown error'}`);
  }
  return json;
}

/** Walk a list endpoint to completion. */
async function listAll(path) {
  const items = [];
  let startingAfter;
  for (;;) {
    const qs = new URLSearchParams({ limit: '100' });
    if (startingAfter) qs.set('starting_after', startingAfter);
    const page = await stripe('GET', `${path}${path.includes('?') ? '&' : '?'}${qs}`);
    items.push(...page.data);
    if (!page.has_more || page.data.length === 0) return items;
    startingAfter = page.data[page.data.length - 1].id;
  }
}

/* ----------------------------------------------------------------- catalog */

const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
const PRODUCT = catalog.product;
const CURRENCY = catalog.currency;

/** Guard: everything this script writes must start with this. */
const KEY_PREFIX = `ever_${PRODUCT}_`;

const planSkuId = (plan) => `ever_${PRODUCT}_${plan.hosting}_${plan.tier}`;
const seatSkuId = (plan) => `ever_${PRODUCT}_${plan.hosting}_${plan.tier}_seat`;
const creditSkuId = (pack) => `ever_${PRODUCT}_${pack.packId.replace(/-/g, '_')}`;

const planLookupKey = (plan, interval) => `ever_${PRODUCT}_${plan.hosting}_${plan.tier}_${interval}`;
const seatLookupKey = (plan, interval) => `ever_${PRODUCT}_${plan.hosting}_${plan.tier}_seat_${interval}`;
const creditLookupKey = (pack) => `ever_${PRODUCT}_${pack.packId.replace(/-/g, '_')}`;

const hostingLabel = (h) => (h === 'cloud' ? 'Cloud' : 'Self-Hosted');
const planProductName = (plan) => `${catalog.name} ${hostingLabel(plan.hosting)} — ${plan.tierName}`;
const seatProductName = (plan) => `${planProductName(plan)} — Additional Seat`;
const creditProductName = (pack) => `${catalog.name} — ${pack.label}`;

/** Catalog interval -> the Stripe recurrence it produces. `null` = one-off. */
function recurringInterval(interval) {
  if (interval === 'lifetime') return null;
  return interval === 'annual' ? 'year' : 'month';
}

function priceShape(interval) {
  const r = recurringInterval(interval);
  return r ? { recurring: { interval: r } } : {};
}

/** True when an existing Stripe price still matches what the catalog wants. */
function priceMatches(existing, amountCents, interval) {
  if (existing.unit_amount !== amountCents) return false;
  if (existing.currency !== CURRENCY) return false;
  return (existing.recurring?.interval ?? null) === recurringInterval(interval);
}

/**
 * Flatten the catalog into the full list of (product, price) intents.
 * Doing this up front means the sync loop, the dry run and --verify all read the same list.
 */
function buildIntents() {
  const intents = [];

  for (const plan of catalog.plans) {
    const baseMeta = {
      ever_product: PRODUCT,
      ever_hosting: plan.hosting,
      ever_tier: plan.tier,
      ever_site: catalog.site
    };

    // --- the plan itself. An empty `prices` array is a free download: no Stripe object at all.
    if (plan.prices.length > 0) {
      const sku = planSkuId(plan);
      for (const price of plan.prices) {
        intents.push({
          kind: 'plan',
          sku,
          productName: planProductName(plan),
          productMeta: { ...baseMeta, ever_sku: sku },
          lookupKey: planLookupKey(plan, price.interval),
          amountCents: price.amountCents,
          interval: price.interval,
          priceMeta: { ...baseMeta, ever_sku: sku, ever_interval: price.interval }
        });
      }
    }

    // --- the per-additional-seat add-on. Skipped where seats are unbounded.
    if (plan.seatsIncluded !== null && plan.seatCentsPerMonth !== null) {
      const sku = seatSkuId(plan);
      for (const interval of ['monthly', 'annual']) {
        // Additional seats carry NO annual discount: the annual rate is exactly 12x the monthly
        // one, matching Gauzy's flat "$5 per month" wording.
        const amountCents = interval === 'annual' ? plan.seatCentsPerMonth * 12 : plan.seatCentsPerMonth;
        intents.push({
          kind: 'seat',
          sku,
          productName: seatProductName(plan),
          productMeta: { ...baseMeta, ever_sku: sku, ever_unit: 'seat' },
          lookupKey: seatLookupKey(plan, interval),
          amountCents,
          interval,
          priceMeta: {
            ...baseMeta,
            ever_sku: sku,
            ever_unit: 'seat',
            ever_interval: interval,
            ever_seats_included: String(plan.seatsIncluded)
          }
        });
      }
    }
  }

  // --- one-time credit packs. Hosting- and tier-agnostic by design.
  for (const pack of catalog.creditPacks) {
    const sku = creditSkuId(pack);
    intents.push({
      kind: 'credits',
      sku,
      productName: creditProductName(pack),
      productMeta: {
        ever_product: PRODUCT,
        ever_sku: sku,
        ever_site: catalog.site,
        ever_unit: 'credits',
        ever_pack_id: pack.packId,
        ever_credits: String(pack.credits)
      },
      lookupKey: creditLookupKey(pack),
      amountCents: pack.amountCents,
      interval: 'lifetime', // one-off
      priceMeta: {
        ever_product: PRODUCT,
        ever_sku: sku,
        ever_unit: 'credits',
        ever_pack_id: pack.packId,
        ever_credits: String(pack.credits)
      }
    });
  }

  return intents;
}

/* -------------------------------------------------------------------- sync */

const changes = [];
const note = (verb, what, detail) => {
  changes.push({ verb, what, detail });
  console.log(`  ${DRY_RUN ? '[dry-run] ' : ''}${verb.padEnd(7)} ${what}${detail ? '  ' + detail : ''}`);
};

async function main() {
  const intents = buildIntents();

  console.log(`\nEver Works Stripe catalog sync — mode ${MODE}${DRY_RUN ? ' (dry run)' : VERIFY ? ' (verify)' : ''}`);
  console.log(`Catalog v${catalog.version}, product "${PRODUCT}", currency ${CURRENCY}`);
  console.log(`${intents.length} price intents across ${new Set(intents.map((i) => i.sku)).size} products\n`);

  // Belt and braces: this script must never write outside the Ever Works namespace.
  const stray = intents.filter((i) => !i.lookupKey.startsWith(KEY_PREFIX));
  if (stray.length) {
    throw new Error(`Refusing to run: ${stray.length} intent(s) outside the "${KEY_PREFIX}" namespace`);
  }

  if (MODE === 'LIVE' && !DRY_RUN && !VERIFY) {
    console.log('🛑 Writing to LIVE mode.');
    console.log('   Confirm first that the legacy Chargebee webhook subscribed to * is disabled,');
    console.log('   or every price created here is delivered into Chargebee.');
    console.log('   Ctrl-C within 10s to abort.\n');
    await new Promise((r) => setTimeout(r, 10_000));
  }

  const existingProducts = await listAll('/products?active=true');
  const existingPrices = await listAll('/prices?active=true');

  const productBySku = new Map();
  for (const p of existingProducts) {
    if (p.metadata?.ever_sku) productBySku.set(p.metadata.ever_sku, p);
  }
  const priceByLookup = new Map();
  for (const p of existingPrices) {
    if (p.lookup_key) priceByLookup.set(p.lookup_key, p);
  }

  const drift = [];

  for (const intent of intents) {
    // ---------------------------------------------------------------- product
    let product = productBySku.get(intent.sku);
    if (!product) {
      if (VERIFY) {
        drift.push(`missing product ${intent.sku} (${intent.productName})`);
      } else {
        note('create', `product ${intent.productName}`);
        if (DRY_RUN) {
          // Record a placeholder so the next price intent for this same product does not report a
          // second "create". Without it the dry run over-counts every multi-price product and the
          // change total stops matching what a real run would do.
          product = { id: `dry_run_${intent.sku}`, name: intent.productName, metadata: intent.productMeta };
          productBySku.set(intent.sku, product);
        } else {
          product = await stripe('POST', '/products', {
            name: intent.productName,
            metadata: intent.productMeta
          });
          productBySku.set(intent.sku, product);
        }
      }
    } else if (product.name !== intent.productName) {
      if (VERIFY) {
        drift.push(`product ${intent.sku} named "${product.name}", catalog says "${intent.productName}"`);
      } else {
        note('rename', `product ${product.name}`, `-> ${intent.productName}`);
        if (!DRY_RUN) {
          await stripe('POST', `/products/${product.id}`, {
            name: intent.productName,
            metadata: intent.productMeta
          });
        }
      }
    }

    // ------------------------------------------------------------------ price
    const existing = priceByLookup.get(intent.lookupKey);

    if (existing && priceMatches(existing, intent.amountCents, intent.interval)) continue; // correct

    if (VERIFY) {
      drift.push(
        existing
          ? `price ${intent.lookupKey} is ${existing.unit_amount} ${existing.currency}` +
            `/${existing.recurring?.interval ?? 'one-time'}, catalog says ${intent.amountCents} ` +
            `${CURRENCY}/${recurringInterval(intent.interval) ?? 'one-time'}`
          : `missing price ${intent.lookupKey} (${intent.amountCents} ${CURRENCY} ${intent.interval})`
      );
      continue;
    }

    if (existing) {
      // Immutable: supersede rather than edit.
      note('replace', `price ${intent.lookupKey}`, `${existing.unit_amount} -> ${intent.amountCents}`);
      if (!DRY_RUN) {
        const created = await stripe('POST', '/prices', {
          product: product.id,
          currency: CURRENCY,
          unit_amount: intent.amountCents,
          lookup_key: intent.lookupKey,
          transfer_lookup_key: 'true',
          metadata: intent.priceMeta,
          ...priceShape(intent.interval)
        });
        await stripe('POST', `/prices/${existing.id}`, { active: 'false' });
        priceByLookup.set(intent.lookupKey, created);
      }
      continue;
    }

    note(
      'create',
      `price ${intent.lookupKey}`,
      `${intent.amountCents} ${CURRENCY} ${recurringInterval(intent.interval) ?? 'one-time'}`
    );
    if (!DRY_RUN) {
      const created = await stripe('POST', '/prices', {
        product: product.id,
        currency: CURRENCY,
        unit_amount: intent.amountCents,
        lookup_key: intent.lookupKey,
        metadata: intent.priceMeta,
        ...priceShape(intent.interval)
      });
      priceByLookup.set(intent.lookupKey, created);
    }
  }

  if (VERIFY) {
    if (drift.length === 0) {
      console.log(`Stripe matches the catalog — ${intents.length} price(s) verified, 0 drift.\n`);
      return;
    }
    console.error(`\n${drift.length} drift item(s):`);
    for (const d of drift) console.error(`  - ${d}`);
    console.error('');
    process.exit(1);
  }

  console.log(
    `\n${
      changes.length === 0
        ? 'Already in sync — no changes.'
        : `${changes.length} change(s)${DRY_RUN ? ' would be applied.' : ' applied.'}`
    }\n`
  );
}

main().catch((err) => {
  console.error(`\n${err.message}\n`);
  process.exit(1);
});
