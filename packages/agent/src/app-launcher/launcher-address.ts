/**
 * APW-11 (App Launcher) — the pure address model.
 *
 * Spec: `docs/specs/features/app-works/APW-11-app-launcher/spec.md` FR-16
 * (spec.md:232-235) and FR-55 (spec.md:240-244); plan
 * `…/plan.md` §4.6 (plan.md:512-557) is the normative signature and rule list.
 *
 * Nothing here reads the database, the environment or a clock: every input is a
 * parameter, so the whole preference order is testable at its boundaries. The
 * caller (`AppLauncherService`, APW-11 T6) resolves the Work's rows and hands
 * them in.
 *
 * ## The order (FR-16)
 *
 *   1. the **earliest-added verified production custom domain** — so adding a
 *      second domain never silently moves the tile (ACC-11-10);
 *   2. otherwise the **managed subdomain** address, and only when BOTH the label
 *      and the root are known;
 *   3. otherwise the address the **latest successful production deployment**
 *      reported.
 *
 * ## Why `managedRoot` is an input and never read here (plan §4.6:528-530)
 *
 * The apex a managed label lives under is a deployment fact, not a launcher
 * fact: an App Work's label is allocated on the apps apex (APW-06 T48 binds
 * `AppManagedHostRootResolver`), every other kind's on the platform's own
 * domain. This module therefore never reads `EVER_WORKS_DOMAIN` and never
 * synthesises one: `null` **skips** the managed-subdomain candidate instead of
 * inventing a host. That is what makes spec FR-55's guarantee — an App Work
 * whose label was allocated elsewhere is never listed under the platform's own
 * domain — hold no matter which binding is present.
 *
 * ## Why a bad candidate falls through instead of blanking the tile
 *
 * Every candidate passes {@link toSafeLauncherUrl}; the first one that yields a
 * safe address wins. A single malformed domain row therefore degrades to the
 * next candidate rather than removing the tile from the panel entirely — the
 * additive posture CONTRACTS R-26 requires, and the reason the fall-through is
 * asserted by its own test.
 */

/**
 * A launcher address that passed every safety rule: `https` (or `http` on a
 * local development installation), a bare origin, and no credential.
 *
 * `host` travels beside `url` so a caller never re-parses the string
 * (`AppLauncherItem.host`, plan.md:261).
 */
export interface LauncherAddress {
    /** `https://<host>/` — path reset to `/`, query and fragment dropped. */
    url: string;
    /** `host[:port]`, the same value `url` is built from. */
    host: string;
}

/** Options shared by every validator in this module. */
export interface LauncherAddressOptions {
    /**
     * Plan §4.6:522 — `NODE_ENV !== 'production'`. When `true`, and **only**
     * then, `http://localhost` and `http://127.0.0.1` are accepted as well
     * (spec FR-32, spec.md:312-313). Absent or `false` means `https` only.
     */
    allowHttpLocalhost?: boolean;
}

/** One verified production custom domain, with the time it was added. */
export interface LauncherCustomDomainCandidate {
    domain: string;
    createdAt: Date;
}

/** Everything {@link resolveLauncherAddress} needs, all of it supplied. */
export interface ResolveLauncherAddressInput extends LauncherAddressOptions {
    /**
     * The Work's verified production domains. Earliest `createdAt` wins; the
     * function sorts defensively, so an unsorted caller is still correct and the
     * result never depends on the order they arrived in.
     */
    verifiedProductionDomains?: ReadonlyArray<LauncherCustomDomainCandidate> | null;
    /** The Work's managed label, or `null`. */
    managedSubdomain?: string | null;
    /**
     * The apex that label was allocated under — `EVER_WORKS_APPS_DOMAIN` for a
     * kind-`app` Work, the platform root otherwise. `null` (neither configured)
     * skips the candidate rather than inventing a host (plan §4.6:540-546).
     */
    managedRoot?: string | null;
    /** The address the latest `READY` production deployment reported, or `null`. */
    latestReadyWebsite?: string | null;
}

/** {@link resolveAppWorkAddress} adds APW-06's published primary host. */
export interface ResolveAppWorkAddressInput extends ResolveLauncherAddressInput {
    /**
     * `AppPublishedHostsPort.primary(workId)` (plan §4.6:548-553): the verified
     * custom domain the owner marked primary, else
     * `<managedSubdomain>.<apps-domain>`, else `null`. `null`, `undefined`, or a
     * value that fails validation means the port answered nothing and the FR-16
     * order applies unchanged.
     */
    publishedPrimaryUrl?: string | null;
}

/**
 * DNS's maximum host name length (RFC 1035 §2.3.4), restated by plan §4.6:527
 * as "host ≤ 253 chars". A longer host is not a name any resolver can hold, and
 * a catalog or a Work row carrying one is refused rather than opened.
 */
const LAUNCHER_HOST_MAX_LENGTH = 253;

/** The two hosts spec FR-32 (spec.md:312-313) admits in development. */
const LOCALHOST_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

/**
 * Validate one candidate address (plan §4.6:526-528).
 *
 * A candidate is returned as `{ url, host }` only when **all** of these hold:
 *
 *   - it parses as a URL at all (`new URL()` throws → refused);
 *   - its scheme is `https:`, or `http:` on one of FR-32's two localhost hosts
 *     **and** only while `allowHttpLocalhost` is on;
 *   - it carries no userinfo — a `user:password@` prefix is a credential in a
 *     URL, which spec FR-31 (spec.md:310-311) forbids outright;
 *   - its host is at most {@link LAUNCHER_HOST_MAX_LENGTH} characters.
 *
 * The returned `url` is the origin with the path reset to `/` and the query and
 * fragment dropped (plan §4.6:527), so nothing a Work row carries can smuggle a
 * deep link, a tracking parameter or a fragment into an opened tab
 * (spec FR-31, ACC-11-23).
 */
export function toSafeLauncherUrl(
    candidate: string | null | undefined,
    options: LauncherAddressOptions = {},
): LauncherAddress | null {
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

    if (!isAllowedProtocol(parsed, options.allowHttpLocalhost === true)) {
        return null;
    }

    if (parsed.host.length === 0 || parsed.host.length > LAUNCHER_HOST_MAX_LENGTH) {
        return null;
    }

    return { url: `${parsed.origin}/`, host: parsed.host };
}

/**
 * Resolve a Work's launcher address in spec FR-16's order (plan §4.6:517-524).
 *
 * Returns `null` when no candidate yields a safe address — which is exactly
 * "this Work has no live address", the condition spec FR-15/FR-56 render as
 * **Not live — no address**.
 */
export function resolveLauncherAddress(input: ResolveLauncherAddressInput): LauncherAddress | null {
    const options: LauncherAddressOptions = {
        allowHttpLocalhost: input.allowHttpLocalhost === true,
    };

    // 1. The earliest-added verified production custom domain (FR-16 first
    //    preference). Later domains are never reached while the earliest one
    //    still validates, which is ACC-11-10's "a second domain never moves the
    //    tile".
    for (const domain of earliestAddedFirst(input.verifiedProductionDomains)) {
        const address = fromBareHost(domain, options);
        if (address) {
            return address;
        }
    }

    // 2. The managed subdomain. BOTH halves must be known: a label with no root
    //    (or the reverse) skips the candidate, because the only host this module
    //    could build would be one it made up (FR-55).
    const label = trimmed(input.managedSubdomain);
    const root = trimmed(input.managedRoot);
    if (label && root) {
        const address = fromBareHost(`${label}.${root}`, options);
        if (address) {
            return address;
        }
    }

    // 3. What the latest READY production deployment reported (FR-16 last).
    return toSafeLauncherUrl(input.latestReadyWebsite, options);
}

/**
 * Build `https://<host>/` from a value that is supposed to be a **bare host**,
 * and accept it only when the URL that comes back really is that host.
 *
 * The equality check is the point. A stored value that is not a bare host —
 * `http://insecure.example.test`, `evil.test/path`, `user@evil.test` — would
 * otherwise be glued onto `https://` and re-parsed into something else
 * entirely (`https://http://insecure.example.test/` parses as the host `http`),
 * quietly turning a malformed row into an address nobody wrote. Comparing the
 * parsed host against the intended one refuses that whole class rather than
 * enumerating the characters that cause it, so a form nobody thought of is
 * refused too.
 */
function fromBareHost(host: string, options: LauncherAddressOptions): LauncherAddress | null {
    const address = toSafeLauncherUrl(`https://${host}/`, options);
    if (!address) {
        return null;
    }
    // `URL` lowercases the host; compare in the same case.
    return address.host.toLowerCase() === host.toLowerCase() ? address : null;
}

/**
 * Resolve a **kind-`app`** Work's launcher address (plan §4.6:548-553,
 * spec FR-55).
 *
 * The platform's published primary address wins whenever the port answers with
 * a usable one; only when it is unbound, answers `null`, or answers something
 * that fails validation does the FR-16 order apply unchanged.
 *
 * The two halves of FR-55's guarantee live in one place each: this function
 * prefers the published host, and {@link resolveLauncherAddress} refuses to
 * build a managed host it was not handed a root for. Between them, a Work whose
 * label was allocated on a dedicated apps apex can never be listed at
 * `<label>.<the platform's own domain>` (ACC-11-41).
 */
export function resolveAppWorkAddress(input: ResolveAppWorkAddressInput): LauncherAddress | null {
    const published = toSafeLauncherUrl(input.publishedPrimaryUrl, {
        allowHttpLocalhost: input.allowHttpLocalhost === true,
    });
    if (published) {
        return published;
    }
    return resolveLauncherAddress(input);
}

/** Whether the parsed address's scheme is one FR-32 admits for this installation. */
function isAllowedProtocol(parsed: URL, allowHttpLocalhost: boolean): boolean {
    if (parsed.protocol === 'https:') {
        return true;
    }
    if (parsed.protocol !== 'http:') {
        return false;
    }
    return allowHttpLocalhost && LOCALHOST_HOSTNAMES.has(parsed.hostname);
}

/**
 * FR-16's "earliest-added ... wins", applied defensively: the domains are
 * sorted here rather than trusted to arrive sorted, and an unparseable
 * `createdAt` sorts last instead of throwing. Equal timestamps fall back to the
 * domain string so the winner is the same on every run — the module's stable
 * order rule, and the reason ACC-11-10 cannot flicker between two rows added in
 * the same millisecond.
 */
function earliestAddedFirst(
    domains: ReadonlyArray<LauncherCustomDomainCandidate> | null | undefined,
): string[] {
    return [...(domains ?? [])]
        .filter((entry) => trimmed(entry?.domain).length > 0)
        .map((entry) => ({
            domain: trimmed(entry.domain),
            addedAt: timeValue(entry.createdAt, Number.POSITIVE_INFINITY),
        }))
        .sort((a, b) => {
            if (a.addedAt !== b.addedAt) {
                return a.addedAt - b.addedAt;
            }
            return compareStrings(a.domain, b.domain);
        })
        .map((entry) => entry.domain);
}

/** `Date` → millis, with a caller-chosen value for "missing or unparseable". */
function timeValue(value: Date | string | number | null | undefined, fallback: number): number {
    if (value instanceof Date) {
        const time = value.getTime();
        return Number.isFinite(time) ? time : fallback;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : fallback;
    }
    if (typeof value === 'string') {
        const time = Date.parse(value);
        return Number.isFinite(time) ? time : fallback;
    }
    return fallback;
}

/** Locale-independent string comparison, so the stable-order rule is portable. */
function compareStrings(a: string, b: string): number {
    if (a === b) {
        return 0;
    }
    return a < b ? -1 : 1;
}

function trimmed(value: string | null | undefined): string {
    return typeof value === 'string' ? value.trim() : '';
}
