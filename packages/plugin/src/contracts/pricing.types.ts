/**
 * Provider pricing declaration for budget tracking and per-call cost
 * accounting. Returned by capability plugins (search, screenshot,
 * content-extractor) so the platform can record an estimated cost
 * per invocation in PluginUsageEvent.
 *
 * AI providers do not implement this — their cost is computed from
 * token usage × model pricing in the AI facade.
 */
export interface PluginPricing {
	/**
	 * Estimated cost per single invocation, in cents of `currency`.
	 * Use 0 when the call is free at the provider level.
	 */
	readonly costPerCallCents: number;
	/**
	 * ISO-4217 currency code (lowercase). Defaults to 'usd' if omitted.
	 */
	readonly currency?: string;
	/**
	 * Free-form note (e.g. plan tier, "first 1K free", etc.) for display.
	 */
	readonly note?: string;
}
