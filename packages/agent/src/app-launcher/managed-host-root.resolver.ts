/**
 * APW-11 (App Launcher) — the two ports the launcher reads a Work's *published*
 * address through, and the fail-safe default the platform binds until APW-06
 * replaces it.
 *
 * Spec FR-55 (`spec.md:240-244`) and plan §4.6 (plan.md:512-557, corrected by
 * APW11-G01/APW11-G09 at plan.md:532-553); the port contract is CONTRACTS §3
 * (`CONTRACTS.md:375`).
 *
 * ## Why `managedRoot` is a port and never an environment read inside the pure module
 *
 * `launcher-address.ts` refuses to build `<label>.<root>` unless it is handed a
 * root, which is what makes FR-55's guarantee hold no matter who is bound. The
 * apex a managed label was **allocated on** is a deployment fact:
 *
 *   - a kind-`app` Work's label is allocated by `SubdomainAllocator` on the apps
 *     apex — `EVER_WORKS_APPS_DOMAIN` when set, otherwise `EVER_WORKS_DOMAIN`
 *     (CONTRACTS §7: "defaults to `EVER_WORKS_DOMAIN` (`ever.works`)");
 *   - every other kind's label is allocated on the platform's own domain.
 *
 * APW-06 T48 binds `AppManagedHostRootResolver` over this token in P1 and its
 * value wins; this default exists so APW-11 P1 is correct **before** that task
 * merges, which is what keeps this epic's "depends on nothing" claim true.
 *
 * The two environment variables are read here, directly from `process.env`, the
 * same way `subdomain-allocator.service.ts:192` and
 * `cloudflare-dns.provider.ts:430` read them: `packages/agent/src/config/index.ts`
 * has no accessor for either name, and this epic owns neither that file nor the
 * config module.
 *
 * ## The one asymmetry, and why it is deliberate
 *
 * For a kind other than `app` the resolver answers the platform's managed root,
 * falling back to the documented `ever.works` exactly as the allocator and
 * `ingressHostFor` do — a directory Work's label really was allocated there, so
 * answering `null` would drop a tile that has a working address.
 *
 * For a kind-`app` Work it answers `EVER_WORKS_APPS_DOMAIN`, else
 * `EVER_WORKS_DOMAIN`, else **`null`**. It never falls back to the literal
 * default there, because an App Work's label only exists when one of those two
 * variables was configured (`EVER_WORKS_APPS_DNS_ZONE_ID` unset means no managed
 * subdomains at all, CONTRACTS §7) — so `null` invents nothing, and an App Work
 * can never be listed under a host nobody allocated for it (ACC-11-41).
 */

import type { Work } from '../entities/work.entity';

/**
 * The `work.kind` an App Work carries.
 *
 * APW-01 adds `'app'` to the shared `WORK_KINDS` union additively; until that
 * lands, `Work.kind` is typed as a union that does not contain it and every
 * comparison here goes through {@link isLauncherAppWorkKind}, which compares
 * strings. Nothing in this epic edits the shared union (CONTRACTS R-26) and
 * nothing breaks when APW-01 adds the member.
 */
export const LAUNCHER_APP_WORK_KIND = 'app';

/**
 * The managed root the platform uses when `EVER_WORKS_DOMAIN` is unset — the
 * documented default of `subdomain-allocator.service.ts:192` and
 * `cloudflare-dns.provider.ts:430`, restated once so the launcher and the
 * allocator cannot disagree about where a non-App label lives.
 */
export const LAUNCHER_PLATFORM_DEFAULT_ROOT = 'ever.works';

/** Whether a `work.kind` value names an App Work (see {@link LAUNCHER_APP_WORK_KIND}). */
export function isLauncherAppWorkKind(kind: string | null | undefined): boolean {
    return (typeof kind === 'string' ? kind.trim().toLowerCase() : '') === LAUNCHER_APP_WORK_KIND;
}

/**
 * The apex a Work's managed label lives under, or `null` when the installation
 * has not configured one (in which case the caller **skips** the synthesised
 * candidate instead of inventing a host).
 *
 * APW-06 T48's `AppManagedHostRootResolver` implements this and returns
 * `config.everWorks.apps.getDomain()` for kind `app`, delegating every other kind
 * to {@link DefaultManagedHostRootResolver}.
 */
export interface ManagedHostRootResolver {
    /** @param work only `id` and `kind` are read — never the Work's name or address. */
    resolve(work: Pick<Work, 'id' | 'kind'>): string | null;
}

/** DI token for {@link ManagedHostRootResolver} (CONTRACTS §3). */
export const MANAGED_HOST_ROOT_RESOLVER = Symbol('MANAGED_HOST_ROOT_RESOLVER');

/**
 * The default binding: the apps apex for kind `app`, the platform root for every
 * other kind, each read from `process.env` at call time so a test (or a boot
 * that sets the variable late) sees the current value.
 *
 * APW-06 T48 provides this token with `useClass: AppManagedHostRootResolver`,
 * which delegates non-App kinds back to this class.
 */
export class DefaultManagedHostRootResolver implements ManagedHostRootResolver {
    resolve(work: Pick<Work, 'id' | 'kind'>): string | null {
        const platformRoot = configuredDomain('EVER_WORKS_DOMAIN');
        if (isLauncherAppWorkKind(work?.kind)) {
            return configuredDomain('EVER_WORKS_APPS_DOMAIN') ?? platformRoot ?? null;
        }
        return platformRoot ?? LAUNCHER_PLATFORM_DEFAULT_ROOT;
    }
}

/**
 * One instance the service falls back to when the token is unbound.
 *
 * `@Optional()` injection means a lean bootstrap (a unit test, a CLI context)
 * may have no binding at all; falling back to the same class the module binds
 * keeps APW-11 correct there too, and the fallback is stateless so one shared
 * instance is safe.
 */
export const DEFAULT_MANAGED_HOST_ROOT_RESOLVER = new DefaultManagedHostRootResolver();

/**
 * The address the platform **publishes** for an App Work (plan §4.6:548-553,
 * CONTRACTS §3).
 *
 * APW-06's `AppHostsService` binds this token: "the verified custom domain the
 * owner marked primary, else `<managedSubdomain>.<apps-domain>`, else `null`".
 * When it answers, that address is the App Work's tile; when it is unbound or
 * answers `null`, the FR-16 order applies unchanged
 * (`launcher-address.ts` → `resolveAppWorkAddress`).
 *
 * The port is `@Optional()` in `AppLauncherService` and appended last, so the
 * launcher is complete without it. **APW-06 must import this token** rather than
 * declare a second one: two `Symbol('APP_PUBLISHED_HOSTS')` values are different
 * keys, and a second declaration would silently leave the port unbound.
 */
export interface AppPublishedHostsPort {
    /** The Work's published primary address, or `null` when it publishes none. */
    primary(workId: string): Promise<string | null>;
}

/** DI token for {@link AppPublishedHostsPort} (CONTRACTS §3). */
export const APP_PUBLISHED_HOSTS = Symbol('APP_PUBLISHED_HOSTS');

/** `process.env[name]`, trimmed, or `null` when unset/blank. */
function configuredDomain(name: string): string | null {
    const value = process.env[name]?.trim();
    return value ? value : null;
}
