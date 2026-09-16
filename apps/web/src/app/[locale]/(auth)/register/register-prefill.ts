/**
 * What ever.co/checkout/complete puts on the register URL after a purchase.
 *
 * It reads the finished Stripe Checkout Session and forwards the identity Stripe
 * collected, so someone arriving from checkout is not asked a second time for
 * what they have already typed.
 */
export interface RegisterPrefill {
    email?: string;
    name?: string;
}

/** The raw query as the page receives it from Next. */
export interface RegisterSearchParams {
    email?: string | string[];
    name?: string | string[];
}

/**
 * Next hands a repeated query parameter over as an array, and an empty one as
 * `''`. Neither is something the buyer typed into Stripe, and both would do harm
 * here: the form locks the email whenever one is present, so a blank or
 * ambiguous value would lock the field with nothing usable in it.
 */
function single(value: string | string[] | undefined): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed || undefined;
}

export function prefillFromSearchParams(params: RegisterSearchParams): RegisterPrefill {
    return { email: single(params.email), name: single(params.name) };
}
