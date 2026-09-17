import { isFleetModelPluginId } from '@ever-works/contracts';
import type { SettingSource } from '@ever-works/plugin';
import { UsageMeter, UsageOutcome, UsagePayer } from '@src/entities/_types';
import { PluginUsageCapability } from '@src/entities/plugin-usage-event.entity';
import { priceFor } from '../subscriptions/billing/credit-pricebook';
import type { CreditPriceList } from './credit-price-list';

/**
 * AW-17 — the meter classification, as a total function.
 *
 *   a unit of spend
 *     ├─ a send (email / notification channel) ─────────► ADDON   (never draws credits)
 *     └─ a metered call
 *          ├─ paid with a credential the Workspace owns ─► MODEL   (recorded, not charged)
 *          └─ otherwise ─────────────────────────────────► CREDITS (priced from the list)
 *                 └─ payer could not be determined ──────► CREDITS, flagged unconfirmed
 *
 * Every input maps to exactly one meter; no input maps to none. Pure — the
 * caller supplies the price list and the provider-cost converter, so this
 * file reads no configuration and no database.
 *
 * Classification happens when the usage row is written
 * (`PluginUsageService.record`) and is stored on the row. It is never
 * recomputed at settlement or at read time.
 */

export interface UsageClassificationInput {
    capability: PluginUsageCapability | string;
    /** The facade operation (`search`, `extract`, `askJson`, …); falls back per capability. */
    operation?: string | null;
    pluginId: string;
    units: number;
    /** The provider's own cost of the call, in cents. */
    costCents: number;
    outcome?: UsageOutcome | null;
    /** Who paid, when the caller already knows. Unknown ⇒ `unconfirmed`. */
    payer?: UsagePayer | null;
}

export interface UsageClassificationContext {
    /** The price list port; absent ⇒ nothing is fixed-priced and no miss is flagged. */
    priceList?: CreditPriceList | null;
    /** Provider cost → whole credits at the published conversion (for `provider-cost` entries). */
    creditsForCostCents?: (costCents: number) => number;
}

export interface UsageClassification {
    meter: UsageMeter;
    payer: UsagePayer;
    outcome: UsageOutcome;
    priceKey: string;
    /** Set only when a fixed `per-unit` price priced the row. */
    priceVersion: number | null;
    creditsCharged: number;
    /** A credits-meter call whose kind has no entry on the price list. */
    priceMissing: boolean;
    /** The payer could not be confirmed. */
    unconfirmed: boolean;
}

/** Sends are covered by a flat monthly add-on line, never by credits. */
const ADDON_CAPABILITIES: ReadonlySet<string> = new Set([
    PluginUsageCapability.EMAIL,
    PluginUsageCapability.NOTIFICATION_CHANNEL,
]);

/**
 * The `capability.operation` price-list key of a call. Never a Plugin id:
 * the key is derived from the capability the call went through, so the
 * Plugin behind it can change without changing the price.
 */
export function priceKeyFor(capability: string, operation?: string | null): string {
    switch (capability) {
        case PluginUsageCapability.SEARCH:
            return 'search.query';
        case PluginUsageCapability.EXTRACTOR:
            return 'extractor.page';
        case PluginUsageCapability.SCREENSHOT:
            return 'screenshot.capture';
        case PluginUsageCapability.AI:
            // Every model operation is managed model access, priced from the
            // model's own metered cost; the operation stays in `metadata`.
            return 'ai.managed';
        case PluginUsageCapability.METRICS:
            return 'metrics.read';
        case PluginUsageCapability.MCP:
            return 'mcp.toolCall';
        case PluginUsageCapability.EMAIL:
            return 'email.send';
        case PluginUsageCapability.NOTIFICATION_CHANNEL:
            return 'notification.send';
        default: {
            const suffix = (operation ?? 'call').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
            return `${String(capability).slice(0, 20)}.${suffix || 'call'}`;
        }
    }
}

/**
 * Where a credential came from → who paid. `user` / `work` settings are the
 * Workspace's own; `admin` / `env` / `default` are the platform's. Anything
 * unresolvable is `unconfirmed` — never silently treated as free.
 */
export function usagePayerFromSettingSource(
    source: SettingSource | string | null | undefined,
): UsagePayer {
    switch (source) {
        case 'user':
        case 'work':
            return UsagePayer.WORKSPACE;
        case 'admin':
        case 'env':
        case 'default':
            return UsagePayer.PLATFORM;
        default:
            return UsagePayer.UNCONFIRMED;
    }
}

export function classifyUsage(
    input: UsageClassificationInput,
    context: UsageClassificationContext = {},
): UsageClassification {
    const outcome = input.outcome ?? UsageOutcome.OK;
    const priceKey = priceKeyFor(String(input.capability), input.operation);
    // A fleet row is model spend billed to the CLI seat on the owner's own
    // machine — bring-your-own by construction, whatever the caller said.
    const payer = isFleetModelPluginId(input.pluginId)
        ? UsagePayer.WORKSPACE
        : (input.payer ?? UsagePayer.UNCONFIRMED);
    const base = {
        payer,
        outcome,
        priceKey,
        priceVersion: null,
        creditsCharged: 0,
        priceMissing: false,
        unconfirmed: payer === UsagePayer.UNCONFIRMED,
    };

    if (ADDON_CAPABILITIES.has(String(input.capability))) {
        return { ...base, meter: UsageMeter.ADDON };
    }
    if (payer === UsagePayer.WORKSPACE) {
        return { ...base, meter: UsageMeter.MODEL };
    }

    const priceList = context.priceList;
    if (!priceList) {
        return { ...base, meter: UsageMeter.CREDITS };
    }
    const entry = priceList.find(priceKey);
    if (!entry) {
        return { ...base, meter: UsageMeter.CREDITS, priceMissing: true };
    }

    if (entry.basis === 'per-unit') {
        return {
            ...base,
            meter: UsageMeter.CREDITS,
            priceVersion: priceList.currentVersion,
            creditsCharged: priceFor(entry, input.units, outcome) ?? 0,
        };
    }

    // `provider-cost`: the provider's own cost at the published conversion.
    // No fixed version — settlement converts the run's summed cost exactly
    // as it always has, so per-row rounding can never inflate a debit.
    const zeroRated = outcome !== UsageOutcome.OK;
    const credits =
        zeroRated || !context.creditsForCostCents
            ? 0
            : context.creditsForCostCents(Math.max(0, input.costCents));
    return {
        ...base,
        meter: UsageMeter.CREDITS,
        creditsCharged: Number.isInteger(credits) && credits > 0 ? credits : 0,
    };
}
