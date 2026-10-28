import { expect } from '@playwright/test';

/**
 * What a notification-channel test-send (`POST /api/notification-channels/:id/test`)
 * truthfully returns in the e2e stack.
 *
 * Every channel plugin is BOUND: since #2988 the plugin loader materializes CommonJS
 * disk plugins that have no default export, so the facade no longer fails with
 * "Failed to materialize plugin" / "plugin not found" for a real plugin id. The plugin
 * itself answers, and the specs connect channels with FICTITIOUS credentials, so a
 * test-send can never deliver. It always ends `status:'failed'`, for one of three
 * reasons, each with its own helper below:
 *
 *   1. `expectConfigRefused`  — the plugin refused the target config BEFORE making any
 *      request (missing field, off-host webhook URL, SSRF-unsafe host). Network-free and
 *      deterministic, so the full error string is pinned.
 *   2. `expectProviderRejected` — the config is well-formed, the plugin called the
 *      provider, and the provider rejected the fictitious credentials. The plugin wraps
 *      the provider's HTTP status as `<prefix> (<status>): <provider reason>`. The prefix
 *      and the status are pinned; the provider's own prose is not (it is theirs to word).
 *   3. `expectPluginNotBound` — the pluginId names no registered channel plugin (e.g.
 *      `email`, `webhook`, a made-up id). The facade's exact wording is pinned.
 *
 * A `delivered` status, or any `providerMessageId`, would be a fabricated success, and
 * every helper fails on it.
 *
 * Provider answers for the fictitious credentials the specs use (probed 2026-10-28 with
 * the same requests the plugins make):
 *   slack-channel    unknown incoming webhook                     → 404 (`no_team`)
 *   discord-channel  unknown webhook id                           → 404 (code 10015 "Unknown Webhook")
 *   telegram-channel well-formed but unknown bot token (`123:abc`) → 401 "Unauthorized"
 *                    malformed bot token (`x`, `x:y`)             → 404 "Not Found"
 *   whatsapp-channel unparseable access token                     → 401 (OAuthException 190)
 *   novu-channel     unknown API key                              → 401 "API Key not found"
 * These calls leave the CI runner for the real provider hosts: the plugins pin their
 * hosts (and refuse loopback / private ranges), so they cannot be pointed at a local fake.
 */

export interface ChannelTestResult {
    status: string;
    error?: string;
    providerMessageId?: string;
}

/** The first part of each bound plugin's delivery-failure error, before ` (<status>): `. */
const DELIVERY_FAILURE_PREFIX = {
    'slack-channel': 'Slack webhook failed',
    'discord-channel': 'Discord webhook failed',
    'telegram-channel': 'Telegram sendMessage failed',
    'whatsapp-channel': 'WhatsApp send failed',
    'novu-channel': 'Novu trigger failed',
} as const;

export type BoundChannelPluginId = keyof typeof DELIVERY_FAILURE_PREFIX;

/** The Slack plugin's refusal of any webhook URL not on `https://hooks.slack.com/`. */
export const SLACK_OFF_HOST_REFUSAL =
    'slack-channel: targetConfig.webhookUrl must start with https://hooks.slack.com/';

/** The Discord plugin's refusal of any webhook URL not on a Discord host. */
export const DISCORD_OFF_HOST_REFUSAL =
    'discord-channel: targetConfig.webhookUrl must be a Discord webhook URL';

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The send FAILED and nothing claims a delivery: `status:'failed'`, no provider message
 * id, and an error string. Returns that error for the caller's exact assertion.
 */
export function expectNotDelivered(result: ChannelTestResult, label: string): string {
    expect(result.status, `${label}: a fictitious target can never be delivered`).toBe('failed');
    expect(result.providerMessageId, `${label}: no provider message id on a failure`).toBe(
        undefined,
    );
    expect(typeof result.error, `${label}: the failure carries its reason`).toBe('string');
    return result.error as string;
}

/** The plugin refused the target config before any request; `expected` is its exact error. */
export function expectConfigRefused(result: ChannelTestResult, expected: string): void {
    expect(expectNotDelivered(result, expected)).toBe(expected);
}

/**
 * The plugin reached the provider, which rejected the fictitious credentials with
 * `httpStatus`. Pins the plugin's own prefix and the provider's status code.
 */
export function expectProviderRejected(
    result: ChannelTestResult,
    pluginId: BoundChannelPluginId,
    httpStatus: number,
): void {
    const error = expectNotDelivered(result, pluginId);
    expect(error, `${pluginId}: the provider's rejection, wrapped by the plugin`).toMatch(
        new RegExp(`^${escapeRegExp(DELIVERY_FAILURE_PREFIX[pluginId])} \\(${httpStatus}\\): `),
    );
}

/** The pluginId names no registered notification-channel plugin. */
export function expectPluginNotBound(result: ChannelTestResult, pluginId: string): void {
    expect(expectNotDelivered(result, pluginId)).toBe(
        `Notification channel plugin not found or disabled: ${pluginId}`,
    );
}
