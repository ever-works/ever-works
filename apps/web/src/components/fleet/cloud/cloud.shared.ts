import {
    FLEET_CLOUD_DEFAULT_IDLE_POLICY,
    FLEET_CLOUD_DEFAULT_SOFTWARE,
    FLEET_CLOUD_IDLE_MAX_HOURS,
    FLEET_CLOUD_IDLE_MIN_HOURS,
    FLEET_CLOUD_UNENROLLED_AFTER_MIN,
    clampFleetCloudIdleHours,
    formatFleetCloudMoney,
    isFleetCloudIdlePolicyMode,
    type FleetCloudIdlePolicy,
    type FleetCloudIdlePolicyMode,
    type FleetCloudOptionsView,
    type FleetCloudPhase,
    type FleetCloudSizeView,
    type FleetCloudSoftwareId,
    type FleetCloudUsageRow,
    type FleetCloudUsageView,
    type FleetNodeCloudView,
    type FleetNodeView,
} from '@ever-works/contracts';

/**
 * Cloud computers (FL-17) — the pure half of the web surface: what a row, the
 * Cloud block and the dialog show, decided once and unit-tested
 * (`cloud.shared.unit.spec.ts`). No React, no I/O.
 */

/** True for a Node created at a cloud provider (it carries the Cloud block). */
export function isCloudComputer(node: Pick<FleetNodeView, 'cloud' | 'origin'>): boolean {
    return Boolean(node.cloud) || node.origin === 'cloud';
}

/** `$24` / `$0.036` in the provider's currency. */
export function money(cents: number, currency?: string): string {
    return formatFleetCloudMoney(cents, { currency });
}

export function hourly(cents: number, currency?: string): string {
    return formatFleetCloudMoney(cents, { currency, perHour: true });
}

/** `2 GB`, `512 MB`. */
export function formatMemory(mib: number): string {
    if (!Number.isFinite(mib) || mib <= 0) return '—';
    return mib >= 1024 ? `${Math.round((mib / 1024) * 10) / 10} GB` : `${mib} MB`;
}

/** `3 d 7 h`, `4 h`, `12 min` — how long since an instant. */
export function formatSince(at: string | null | undefined, nowMs: number = Date.now()): string | null {
    const ms = at ? nowMs - Date.parse(at) : NaN;
    if (!Number.isFinite(ms) || ms < 0) return null;
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 60) return `${Math.max(1, minutes)} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours} h`;
    const days = Math.floor(hours / 24);
    const rest = hours - days * 24;
    return rest > 0 ? `${days} d ${rest} h` : `${days} d`;
}

/** The message key under `fleet.cloud.progress` for a phase (camelCase keys, CONTRACTS i18n rule). */
export const CLOUD_PHASE_KEYS: Readonly<Record<FleetCloudPhase, string>> = {
    'asking-provider': 'askingProvider',
    booting: 'booting',
    installing: 'installing',
    enrolling: 'enrolling',
    online: 'online',
    failed: 'failed',
};

/** The create steps in order, for the progress strip (spec §5.2). */
export const CLOUD_PROGRESS: readonly FleetCloudPhase[] = ['asking-provider', 'booting', 'installing', 'enrolling', 'online'];

/**
 * What the row and the block say about a cloud computer right now — one state
 * for the copy to key on (spec §5.2, §5.3).
 */
export type CloudDisplayState =
    | 'creating'
    | 'unenrolled'
    | 'failed'
    | 'running'
    | 'off'
    | 'poweringOff'
    | 'starting'
    | 'destroying'
    | 'gone';

export function cloudDisplayState(
    node: Pick<FleetNodeView, 'status'>,
    cloud: FleetNodeCloudView,
    nowMs: number = Date.now(),
): CloudDisplayState {
    if (cloud.powerState === 'gone') return 'gone';
    if (cloud.pending === 'destroying') return 'destroying';
    if (cloud.phase === 'failed') return 'failed';
    if (cloud.pending === 'powering-off') return 'poweringOff';
    if (cloud.pending === 'starting') return 'starting';
    if (node.status === 'enrolling') {
        const created = Date.parse(cloud.machineCreatedAt ?? '');
        if (Number.isFinite(created) && nowMs - created > FLEET_CLOUD_UNENROLLED_AFTER_MIN * 60_000) {
            return 'unenrolled';
        }
        return 'creating';
    }
    return cloud.powerState === 'off' ? 'off' : 'running';
}

/** Whether the computer can be powered off / on from here (the server still decides). */
export function cloudPowerChoice(state: CloudDisplayState): 'off' | 'on' | null {
    if (state === 'running' || state === 'unenrolled') return 'off';
    if (state === 'off') return 'on';
    return null;
}

/**
 * CONTRACTS R-36 on the page: "Remove from Fleet" is disabled with the reason
 * for a cloud computer whose machine may still bill, and enabled once it is
 * gone at the provider or was never created. The server refuses the same way.
 */
export function cloudRemoveAvailability(node: Pick<FleetNodeView, 'cloud'>): {
    allowed: boolean;
    reasonKey: 'removeUnavailable.line' | null;
} {
    if (!node.cloud) return { allowed: true, reasonKey: null };
    return node.cloud.removable ? { allowed: true, reasonKey: null } : { allowed: false, reasonKey: 'removeUnavailable.line' };
}

// ─── The dialog ───────────────────────────────────────────────────────────

export interface CloudForm {
    pluginId: string;
    name: string;
    regionId: string;
    sizeId: string;
    software: FleetCloudSoftwareId[];
}

export function initialCloudForm(pluginId = ''): CloudForm {
    return { pluginId, name: '', regionId: '', sizeId: '', software: [...FLEET_CLOUD_DEFAULT_SOFTWARE] };
}

/** The sizes offered in a region (a size with no region list is offered everywhere). */
export function sizesForRegion(options: FleetCloudOptionsView | null, regionId: string): FleetCloudSizeView[] {
    if (!options) return [];
    return options.sizes.filter((size) => size.available && (size.regions.length === 0 || size.regions.includes(regionId)));
}

/**
 * The form once options arrived: the first available region, and a size that
 * fits it — the second-cheapest when there are three or more (the spec's
 * illustrated default is the middle of the usual three), else the cheapest.
 */
export function withOptionDefaults(form: CloudForm, options: FleetCloudOptionsView): CloudForm {
    const region =
        options.regions.find((entry) => entry.id === form.regionId && entry.available) ??
        options.regions.find((entry) => entry.available);
    const regionId = region?.id ?? '';
    const sizes = sizesForRegion(options, regionId);
    const keep = sizes.find((size) => size.id === form.sizeId);
    const size = keep ?? (sizes.length >= 3 ? sizes[1] : sizes[0]);
    return { ...form, regionId, sizeId: size?.id ?? '' };
}

/** "Create · $24/mo" — the Create button carries the price (spec §0, FR-6). */
export function createLabelPrice(size: FleetCloudSizeView | null, currency?: string): string | null {
    return size ? money(size.priceMonthlyCents, currency) : null;
}

/** The current monthly price an `invalid` refusal carried (the price changed, spec U9), or null. */
export function changedPriceOf(error: { code: string; details?: Record<string, unknown> } | null): number | null {
    if (!error || error.code !== 'invalid') return null;
    const value = error.details?.currentPriceCents;
    return typeof value === 'number' && Number.isFinite(value) && error.details?.field === 'acknowledgedPriceCents'
        ? value
        : null;
}

/** The message key under `fleet.cloud.create.softwareNames` of a preset. */
export const CLOUD_SOFTWARE_KEYS: Readonly<Record<FleetCloudSoftwareId, string>> = {
    docker: 'docker',
    node: 'node',
    'claude-code': 'claudeCode',
    codex: 'codex',
    'overlay-vpn': 'overlayVpn',
};

// ─── Idle policy and usage (P2, spec §5.6, §5.7) ─────────────────────────────

/** The editor's working copy: the mode, and the hours as typed (a field may be empty mid-edit). */
export interface IdlePolicyDraft {
    mode: FleetCloudIdlePolicyMode;
    hours: string;
}

/** The editor starts from the stored policy, or the default "Tell me after 3 h" (spec FR-25, S6). */
export function idlePolicyDraftOf(policy: FleetCloudIdlePolicy | null | undefined): IdlePolicyDraft {
    const mode = policy && isFleetCloudIdlePolicyMode(policy.mode) ? policy.mode : FLEET_CLOUD_DEFAULT_IDLE_POLICY.mode;
    const hours = policy ? clampFleetCloudIdleHours(policy.afterHours) : FLEET_CLOUD_DEFAULT_IDLE_POLICY.afterHours;
    return { mode, hours: String(hours) };
}

/** What Save sends: the hours clamped to 1–72 whole hours (an empty field reads as the default 3). */
export function idlePolicyFromDraft(draft: IdlePolicyDraft): FleetCloudIdlePolicy {
    const typed = draft.hours.trim();
    return {
        mode: isFleetCloudIdlePolicyMode(draft.mode) ? draft.mode : FLEET_CLOUD_DEFAULT_IDLE_POLICY.mode,
        afterHours: typed === '' ? FLEET_CLOUD_DEFAULT_IDLE_POLICY.afterHours : clampFleetCloudIdleHours(typed),
    };
}

/** True when the typed hours are a whole number within 1–72 (the field shows the range otherwise). */
export function idleHoursValid(hours: string): boolean {
    if (!/^\d{1,3}$/.test(hours.trim())) return false;
    const value = Number(hours.trim());
    return value >= FLEET_CLOUD_IDLE_MIN_HOURS && value <= FLEET_CLOUD_IDLE_MAX_HOURS;
}

/** Whether Save would change anything. */
export function idlePolicyChanged(stored: FleetCloudIdlePolicy | null | undefined, draft: IdlePolicyDraft): boolean {
    const next = idlePolicyFromDraft(draft);
    const current = idlePolicyDraftOf(stored);
    if (next.mode !== current.mode) return true;
    return next.mode !== 'nothing' && String(next.afterHours) !== current.hours;
}

/**
 * The block's idle facts (spec S6, S7): idle long enough for the policy, or
 * powered off by it — null when neither (the policy line alone is shown).
 */
export function cloudIdleState(
    cloud: Pick<FleetNodeCloudView, 'idleWindowReached' | 'idleSince' | 'poweredOffByPolicyAt' | 'powerState' | 'pending'>,
): 'idle' | 'poweredOffByPolicy' | null {
    if (cloud.poweredOffByPolicyAt && cloud.powerState === 'off' && cloud.pending === null) return 'poweredOffByPolicy';
    if (cloud.idleWindowReached && cloud.idleSince && cloud.pending === null && cloud.powerState === 'running') return 'idle';
    return null;
}

/**
 * The usage table's rows (spec §5.7): live machines first by this month's
 * cost (highest first), then the ones destroyed this month, newest first.
 */
export function cloudUsageRows(usage: Pick<FleetCloudUsageView, 'machines'> | null | undefined): FleetCloudUsageRow[] {
    const rows = [...(usage?.machines ?? [])];
    const live = rows.filter((row) => !row.destroyedAt).sort((a, b) => b.monthToDateCents - a.monthToDateCents);
    const destroyed = rows
        .filter((row) => Boolean(row.destroyedAt))
        .sort((a, b) => Date.parse(b.destroyedAt ?? '') - Date.parse(a.destroyedAt ?? ''));
    return [...live, ...destroyed];
}

/**
 * The search parameter a "needs a look" item links with to open one of the
 * page's acts (`?cloud=power-off`), or null for anything else.
 */
export function cloudActFromQuery(value: string | null | undefined): 'off' | 'on' | 'destroy' | null {
    if (value === 'power-off') return 'off';
    if (value === 'power-on') return 'on';
    if (value === 'destroy') return 'destroy';
    return null;
}
