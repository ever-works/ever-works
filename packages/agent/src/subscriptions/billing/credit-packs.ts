/**
 * Server-side credit-pack table (billing PRD §3.2).
 *
 * THE SECURITY POINT: checkout takes a **pack id**, never an amount. The
 * price and the credits granted are read from this table on the server,
 * so a client cannot ask for 25,000 credits at $1 by editing a request
 * body. `POST /api/credits/checkout` rejects any body carrying an amount,
 * price or credits field (`forbidNonWhitelisted` on the DTO) rather than
 * silently ignoring it — see `CreditsCheckoutController`.
 *
 * The three packs mirror the packs published on the marketing site. They
 * are deliberately NOT env-configurable: a pricing change is a code
 * change that ships with a test, not an env var an operator can drift.
 *
 * Credits are USD-denominated (1 credit = 1¢ of platform-billed usage at
 * the default `CREDITS_PER_DOLLAR=100`), so the $10 pack is exactly at
 * par and the larger packs carry a volume bonus:
 *
 *   | pack             | price | credits | bonus vs. par |
 *   |------------------|-------|---------|---------------|
 *   | credits-1000     |  $10  |   1,000 | —             |
 *   | credits-5500     |  $50  |   5,500 | +10%          |
 *   | credits-25000    | $200  |  25,000 | +25%          |
 */
export interface CreditPack {
    /** Stable id — the ONLY thing a client may send. */
    readonly id: string;
    /** Price charged by the payment provider, in cents. */
    readonly priceCents: number;
    /** Credits added to the ledger when the payment settles. */
    readonly credits: number;
    /** ISO currency for the charge. */
    readonly currency: string;
    /** Display label (i18n-independent; the UI formats amounts itself). */
    readonly label: string;
}

export const CREDIT_PACKS: readonly CreditPack[] = [
    {
        id: 'credits-1000',
        priceCents: 1000,
        credits: 1000,
        currency: 'usd',
        label: '1,000 credits',
    },
    {
        id: 'credits-5500',
        priceCents: 5000,
        credits: 5500,
        currency: 'usd',
        label: '5,500 credits',
    },
    {
        id: 'credits-25000',
        priceCents: 20000,
        credits: 25000,
        currency: 'usd',
        label: '25,000 credits',
    },
];

export const CREDIT_PACK_IDS: readonly string[] = CREDIT_PACKS.map((pack) => pack.id);

/** Look a pack up by id. Unknown ids return `undefined` — never a default. */
export function findCreditPack(packId: string | null | undefined): CreditPack | undefined {
    if (typeof packId !== 'string' || packId.length === 0) {
        return undefined;
    }
    return CREDIT_PACKS.find((pack) => pack.id === packId);
}

/**
 * The pack a threshold-triggered auto-recharge should buy when the
 * profile carries no explicit choice. Smallest pack — an automatic charge
 * should be the least surprising amount, not the largest.
 */
export function defaultAutoRechargePack(): CreditPack {
    return CREDIT_PACKS[0];
}
