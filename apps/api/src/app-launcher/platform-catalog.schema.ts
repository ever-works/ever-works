/**
 * APW-11 (App Launcher) — the platform catalog's reader-side rules.
 *
 * Spec: `docs/specs/features/app-works/APW-11-app-launcher/spec.md` FR-9…FR-14;
 * plan: `…/plan.md` §5.1 (the repository), §5.2 (the reader) and §9.2 (the
 * failure modes). This module is the **twin of the published JSON Schema**
 * (`…/catalog-draft/schema/platforms.schema.json`, which the catalog repository
 * carries) and of the CI check beside it: a catalog accepted here and refused
 * there — or the other way round — is the drift this file exists to prevent.
 * The two rules JSON Schema cannot express (unique ids, the icon byte cap) and
 * the three rules it does not carry (the SVG deny patterns, the entry cap's
 * positional ordering, the address safety rules) are all enforced here as well,
 * because the reader must never trust that CI ran.
 *
 * ## Why a hand-written schema and not zod (plan §5.2 says "a zod schema")
 *
 * `apps/api` does not depend on `zod`: it is declared by the agent package
 * (`packages/agent/package.json`) and is not linked into this app's
 * `node_modules`, so importing it here would need a dependency change outside
 * this task's file list. The rules below are therefore written out in plain
 * TypeScript, one function per rule, with the same shape a zod schema would
 * have had (`parseCatalogDocument` is the `safeParse`): a `{ ok: true, … }` or
 * `{ ok: false, error }` result and **never** a throw on untrusted input. Every
 * rule names the plan/spec line it comes from, so porting them into a zod
 * schema later is mechanical and cannot silently drop one.
 *
 * ## What is deliberately strict
 *
 *   - **The document**: `schemaVersion` must be `1` and top-level keys are
 *     closed. A version this reader does not understand is a **failed read**,
 *     never a partially-read catalog — guessing at a newer shape is how a
 *     poisoned entry reaches a tile.
 *   - **The entry**: keys are closed (the published schema sets
 *     `additionalProperties: false`), `id` matches
 *     `^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$`, `name` ≤ 40, `description` ≤ 80,
 *     `order` an integer 0…9999, `status` one of `available | beta`, `icon` the
 *     path pattern `^icons/[a-z0-9-]+\.(svg|png)$`.
 *   - **Any address that fails the safety rule drops the whole entry**
 *     (reason `unsafeUrl`, FR-11/ACC-11-08). Dropping only the offending
 *     environment would let the same entry render from another environment and
 *     would hide a poisoned catalog from the reader's own log.
 *   - **The cap is positional** (FR-11): the catalog is truncated to
 *     {@link APP_LAUNCHER_CATALOG_MAX_ENTRIES} entries *before* validation, so
 *     the 25th entry is dropped as `overLimit` and an invalid entry at
 *     position 3 can never promote the 25th into the list.
 *
 * Nothing here reads the environment, the clock or the network: every rule is a
 * pure function of its argument, which is what makes the catalog's failure
 * modes testable one fixture case at a time.
 */

import {
    APP_LAUNCHER_CATALOG_MAX_ENTRIES,
    APP_LAUNCHER_DESCRIPTION_MAX_LENGTH,
    APP_LAUNCHER_ENVIRONMENTS,
    APP_LAUNCHER_ICON_MAX_BYTES,
    APP_LAUNCHER_PLATFORM_STATUSES,
    isAppLauncherEnvironment,
    type AppLauncherEnvironment,
    type AppLauncherPlatformStatus,
} from '@ever-works/contracts';

/**
 * The catalog file's shape version (plan §5.1:613, the published schema's
 * `schemaVersion: { const: 1 }`). A document carrying anything else is refused
 * whole — see the header.
 */
export const CATALOG_SCHEMA_VERSION = 1;

/**
 * SSRF containment for `EVER_WORKS_PLATFORM_CATALOG_REPO` (plan §5.2:633-635,
 * "same as `SAFE_REPO_RE`", `works-template-catalog.service.ts:114`): the
 * catalog is only ever read from a repository in the `ever-works` org, so a
 * hostile environment value cannot point the reader at `attacker/…` or at a
 * path that escapes the raw host.
 */
export const CATALOG_REPO_RE = /^ever-works\/[a-z0-9-]+$/;

/** The repository the catalog is read from when nothing is configured. */
export const DEFAULT_CATALOG_REPO = 'ever-works/platforms';

/** The entry id pattern (published schema `$defs.platform.properties.id`). */
export const PLATFORM_ID_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

/** The icon path pattern — a file inside `icons/`, nothing else (FR-14). */
export const PLATFORM_ICON_PATH_RE = /^icons\/[a-z0-9-]+\.(svg|png)$/;

/** `catalogVersion` is a semver, surfaced verbatim to the client (FR-12). */
export const CATALOG_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;

/** FR-9: an entry's display name is at most 40 characters. */
export const PLATFORM_NAME_MAX_LENGTH = 40;

/** FR-9/plan §5.2: the ordering number is an integer 0…9999. */
export const PLATFORM_ORDER_MAX = 9_999;

/**
 * The host name cap FR-31/plan §4.6:527 sets at 253 characters — restated here
 * because a catalog address is validated by the same rule a Work's is.
 */
export const CATALOG_HOST_MAX_LENGTH = 253;

/**
 * The SVG deny patterns (FR-14, plan §5.2:660-662). `<img>` rendering already
 * prevents execution, so this is defence in depth — which is exactly why a hit
 * costs the **icon** and never the platform (plan §9.2:916).
 *
 * `on[a-z]+=` is written as an attribute boundary (`\son…=`) so a legitimate
 * attribute such as `data-on=…` or a text node spelling "on" is not refused;
 * the four names are the plan's.
 */
export const SVG_DENY_PATTERNS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> =
    [
        { name: 'scriptElement', pattern: /<\s*script/i },
        { name: 'eventHandlerAttribute', pattern: /\son[a-z]+\s*=/i },
        { name: 'javascriptUrl', pattern: /javascript:/i },
        { name: 'foreignObject', pattern: /<\s*foreignobject/i },
    ];

/** A catalog address that passed every safety rule: bare origin, no credential. */
export interface CatalogAddress {
    /** `https://<host>/` — path reset to `/`, query and fragment dropped. */
    url: string;
    /** `host[:port]`, the same value `url` is built from. */
    host: string;
}

/**
 * One validated catalog entry, holding **all** environments' addresses. The
 * environment is chosen per read (`PlatformCatalogService.read(environment)`),
 * never here: the cached read is keyed by ref alone (plan §5.2:663-665).
 */
export interface CatalogPlatformEntry {
    id: string;
    name: string;
    description: string;
    /** The `icons/<id>.svg|png` path — the bytes are fetched by the service. */
    icon: string;
    order: number;
    status: AppLauncherPlatformStatus;
    /** Only the environments the entry actually declares, each already safe. */
    urls: Partial<Record<AppLauncherEnvironment, CatalogAddress>>;
}

/** A catalog document that passed document-level validation. */
export interface CatalogDocument {
    catalogVersion: string;
    /** FR-11 order: by `order`, then by `name`. */
    platforms: CatalogPlatformEntry[];
}

/**
 * Why one entry was dropped (`app_launcher.item.omitted`, plan §9.1:908 and
 * FR-44). These three are the whole vocabulary — an icon problem keeps its
 * entry and is reported separately by the service.
 */
export type CatalogOmissionReason = 'invalidEntry' | 'unsafeUrl' | 'overLimit';

/** One dropped entry, logged with the entry id only (FR-11:221). */
export interface CatalogOmission {
    id: string;
    reason: CatalogOmissionReason;
}

/** Why an icon was not inlined — the entry itself is always kept (plan §9.2:916). */
export type CatalogIconOmissionReason = 'oversizeIcon' | 'unsafeSvg' | 'unreadableIcon';

/** The result of reading a catalog document: `safeParse`, without the throw. */
export type CatalogParseResult =
    | { ok: true; catalog: CatalogDocument; omissions: CatalogOmission[] }
    | { ok: false; error: string };

/** The keys a catalog entry may carry (published schema `additionalProperties: false`). */
const ENTRY_KEYS: ReadonlyArray<string> = [
    'id',
    'name',
    'description',
    'icon',
    'order',
    'status',
    'urls',
];

/** The keys the document may carry — `$comment` is the human note the draft ships. */
const DOCUMENT_KEYS: ReadonlyArray<string> = [
    '$comment',
    'schemaVersion',
    'catalogVersion',
    'platforms',
];

/** The id logged for an entry that has no usable one (never the raw value). */
export const UNKNOWN_ENTRY_ID = '<unknown>';

/**
 * Validate one candidate address (FR-9: every address is `https`).
 *
 * The rule is plan §4.6's `toSafeLauncherUrl`
 * (`packages/agent/src/app-launcher/launcher-address.ts:131-163`) with the
 * catalog's stricter first step: the catalog never admits `http`, not even on
 * `localhost`, because FR-9 says the catalog carries `https` addresses and a
 * local installation has no reason to launcher-link to one of its own services.
 *
 * Restated rather than imported because `packages/agent/package.json` exports
 * no `./app-launcher` subpath yet (T6 owns that file), so the agent module is
 * not importable from `apps/api` — `apps/api` resolves workspace packages
 * through their `exports` map, like every other subpath import in this app.
 * When that subpath lands this function's body becomes
 * `toSafeLauncherUrl(candidate)`; the spec asserts the rules below so the swap
 * cannot quietly change behaviour.
 */
export function toSafeCatalogUrl(candidate: unknown): CatalogAddress | null {
    if (typeof candidate !== 'string') {
        return null;
    }
    const trimmed = candidate.trim();
    if (trimmed.length === 0) {
        return null;
    }

    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        return null;
    }

    if (parsed.username.length > 0 || parsed.password.length > 0) {
        return null;
    }
    if (parsed.protocol !== 'https:') {
        return null;
    }
    if (parsed.host.length === 0 || parsed.host.length > CATALOG_HOST_MAX_LENGTH) {
        return null;
    }

    return { url: `${parsed.origin}/`, host: parsed.host };
}

/**
 * Which deny pattern an SVG icon hits, or `null` when it is clean (FR-14).
 * Exported so the service's log can name the pattern that refused the file.
 */
export function unsafeSvgPattern(source: string): string | null {
    for (const { name, pattern } of SVG_DENY_PATTERNS) {
        if (pattern.test(source)) {
            return name;
        }
    }
    return null;
}

/**
 * Inline an icon's bytes as a `data:` URI (FR-14, plan §5.2:663).
 *
 * Fails closed per icon and never per entry (plan §9.2:916): an oversize file,
 * an SVG carrying a deny pattern and anything that is not readable bytes all
 * return a reason, and the caller keeps the platform with an initials tile.
 * The bytes are never truncated into an unrenderable icon — a partial SVG is
 * worse than none.
 */
export function toCatalogIconDataUri(
    iconPath: string,
    bytes: Uint8Array | null | undefined,
): { ok: true; dataUri: string } | { ok: false; reason: CatalogIconOmissionReason } {
    if (!bytes || bytes.byteLength === 0) {
        return { ok: false, reason: 'unreadableIcon' };
    }
    if (bytes.byteLength > APP_LAUNCHER_ICON_MAX_BYTES) {
        return { ok: false, reason: 'oversizeIcon' };
    }

    const isSvg = iconPath.toLowerCase().endsWith('.svg');
    if (isSvg && unsafeSvgPattern(Buffer.from(bytes).toString('utf8')) !== null) {
        return { ok: false, reason: 'unsafeSvg' };
    }

    const mime = isSvg ? 'image/svg+xml' : 'image/png';
    return { ok: true, dataUri: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` };
}

/**
 * Validate one catalog document (FR-9…FR-11, plan §5.2:656-662).
 *
 * Entries are dropped **individually** and reported in `omissions`, in the
 * order they were dropped; the document itself is refused only when the reader
 * could not make sense of it at all. The returned list is already in FR-11's
 * order — by `order`, then by `name` — so every caller renders the same
 * sequence without repeating the rule (spec FR-26 sorts on the same key).
 */
export function parseCatalogDocument(raw: unknown): CatalogParseResult {
    if (!isRecord(raw)) {
        return { ok: false, error: 'the catalog is not a JSON object' };
    }

    const unexpected = Object.keys(raw).filter((key) => !DOCUMENT_KEYS.includes(key));
    if (unexpected.length > 0) {
        return { ok: false, error: `unexpected catalog field(s): ${unexpected.join(', ')}` };
    }
    if (raw.schemaVersion !== CATALOG_SCHEMA_VERSION) {
        return {
            ok: false,
            error: `unsupported schemaVersion ${describeValue(raw.schemaVersion)} (this reader understands ${CATALOG_SCHEMA_VERSION})`,
        };
    }
    if (typeof raw.catalogVersion !== 'string' || !CATALOG_VERSION_RE.test(raw.catalogVersion)) {
        return { ok: false, error: 'catalogVersion is missing or is not a semver string' };
    }
    if (!Array.isArray(raw.platforms)) {
        return { ok: false, error: 'platforms is not an array' };
    }

    const omissions: CatalogOmission[] = [];
    const entries: CatalogPlatformEntry[] = [];
    const seenIds = new Set<string>();

    // The cap is positional and applied FIRST (FR-11: "at most 24 entries are
    // read; entries past the 24th … are dropped"): an invalid entry inside the
    // first 24 never promotes the 25th into the catalog.
    for (const beyond of raw.platforms.slice(APP_LAUNCHER_CATALOG_MAX_ENTRIES)) {
        omissions.push({ id: omissionId(beyond), reason: 'overLimit' });
    }

    for (const candidate of raw.platforms.slice(0, APP_LAUNCHER_CATALOG_MAX_ENTRIES)) {
        const parsed = parsePlatformEntry(candidate);
        // `'reason' in parsed` rather than `!parsed.ok`: this app compiles with
        // `strictNullChecks: false`, under which a boolean-literal discriminant
        // does not narrow a union.
        if ('reason' in parsed) {
            omissions.push({ id: parsed.id, reason: parsed.reason });
            continue;
        }
        // Unique ids are the CI workflow's check, not the schema's — but pins
        // are keyed `platform:<id>`, so a duplicate would merge two platforms
        // into one preference row. The second occurrence loses.
        if (seenIds.has(parsed.entry.id)) {
            omissions.push({ id: parsed.entry.id, reason: 'invalidEntry' });
            continue;
        }
        seenIds.add(parsed.entry.id);
        entries.push(parsed.entry);
    }

    entries.sort(compareEntries);

    return {
        ok: true,
        catalog: { catalogVersion: raw.catalogVersion, platforms: entries },
        omissions,
    };
}

type EntryParseResult =
    | { ok: true; entry: CatalogPlatformEntry }
    | { ok: false; id: string; reason: CatalogOmissionReason };

/**
 * Validate one entry. Every branch that refuses an entry names the field it
 * refused, so an operator reading the `app_launcher.item.omitted` line knows
 * which end of the catalog to fix — while the **id only** reaches the log
 * (FR-11:221), never the rejected value.
 */
function parsePlatformEntry(candidate: unknown): EntryParseResult {
    const fallbackId = omissionId(candidate);
    const invalid = (): EntryParseResult => ({ ok: false, id: fallbackId, reason: 'invalidEntry' });

    if (!isRecord(candidate)) {
        return invalid();
    }

    const id = candidate.id;
    if (typeof id !== 'string' || !PLATFORM_ID_RE.test(id)) {
        return invalid();
    }
    const refused = (reason: CatalogOmissionReason): EntryParseResult => ({
        ok: false,
        id,
        reason,
    });

    if (Object.keys(candidate).some((key) => !ENTRY_KEYS.includes(key))) {
        return refused('invalidEntry');
    }
    if (
        typeof candidate.name !== 'string' ||
        candidate.name.length === 0 ||
        candidate.name.length > PLATFORM_NAME_MAX_LENGTH
    ) {
        return refused('invalidEntry');
    }
    if (
        typeof candidate.description !== 'string' ||
        candidate.description.length === 0 ||
        candidate.description.length > APP_LAUNCHER_DESCRIPTION_MAX_LENGTH
    ) {
        return refused('invalidEntry');
    }
    if (typeof candidate.icon !== 'string' || !PLATFORM_ICON_PATH_RE.test(candidate.icon)) {
        return refused('invalidEntry');
    }
    if (!isValidOrder(candidate.order)) {
        return refused('invalidEntry');
    }
    if (!isPlatformStatus(candidate.status)) {
        return refused('invalidEntry');
    }

    const urls = parseEntryUrls(candidate.urls);
    if (urls === null) {
        // `urls` carried a key this reader does not know, or nothing usable.
        return refused('invalidEntry');
    }
    if (urls === 'unsafe') {
        // An address that fails the safety rule drops the whole entry
        // (FR-11/ACC-11-08): the entry is what renders a tile, not the address.
        return refused('unsafeUrl');
    }

    return {
        ok: true,
        entry: {
            id,
            name: candidate.name,
            description: candidate.description,
            icon: candidate.icon,
            order: candidate.order,
            status: candidate.status,
            urls,
        },
    };
}

/**
 * Validate an entry's `urls` map.
 *
 * `null` = refuse the entry as `invalidEntry` (an unknown environment key, or
 * no usable address at all — the published schema requires at least one);
 * `'unsafe'` = refuse it as `unsafeUrl` (a declared address failed the rule).
 */
function parseEntryUrls(
    raw: unknown,
): Partial<Record<AppLauncherEnvironment, CatalogAddress>> | 'unsafe' | null {
    if (!isRecord(raw)) {
        return null;
    }
    const keys = Object.keys(raw);
    if (keys.length === 0) {
        return null;
    }
    if (keys.some((key) => !isAppLauncherEnvironment(key))) {
        return null;
    }

    const urls: Partial<Record<AppLauncherEnvironment, CatalogAddress>> = {};
    for (const environment of APP_LAUNCHER_ENVIRONMENTS) {
        const value = raw[environment];
        if (value === undefined) {
            continue;
        }
        const safe = toSafeCatalogUrl(value);
        if (!safe) {
            return 'unsafe';
        }
        urls[environment] = safe;
    }

    return Object.keys(urls).length > 0 ? urls : null;
}

/** FR-11's ordering: by `order`, ties broken by name. */
function compareEntries(a: CatalogPlatformEntry, b: CatalogPlatformEntry): number {
    if (a.order !== b.order) {
        return a.order - b.order;
    }
    if (a.name === b.name) {
        return 0;
    }
    return a.name < b.name ? -1 : 1;
}

function isValidOrder(value: unknown): value is number {
    return (
        Number.isInteger(value) && (value as number) >= 0 && (value as number) <= PLATFORM_ORDER_MAX
    );
}

function isPlatformStatus(value: unknown): value is AppLauncherPlatformStatus {
    return (
        typeof value === 'string' &&
        (APP_LAUNCHER_PLATFORM_STATUSES as readonly string[]).includes(value)
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The id to log for a refused entry, or {@link UNKNOWN_ENTRY_ID}.
 *
 * Deliberately narrow: only a short, plain identifier is echoed, so a hostile
 * catalog cannot put a newline, a control character or a megabyte of text into
 * an operator's log (the entry id is the *only* field FR-11 lets this path
 * report).
 */
function omissionId(candidate: unknown): string {
    const id = isRecord(candidate) ? candidate.id : undefined;
    return typeof id === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(id) ? id : UNKNOWN_ENTRY_ID;
}

/** A short, safe rendering of an unexpected value, for a document-level error. */
function describeValue(value: unknown): string {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return JSON.stringify(value);
    }
    return value === null ? 'null' : typeof value;
}
