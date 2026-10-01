import { Injectable, Logger, NestMiddleware, Optional } from '@nestjs/common';

/**
 * Minimal request/response/next shapes, copied from
 * `apps/api/src/scope/scope-resolver.middleware.ts:11-15` for the reason that file records: dragging the
 * full `express` types in makes ts-jest resolve them differently from SWC at runtime and trips the build
 * with errors that do not exist at run time. What this middleware touches is exactly three things.
 */
interface MiddlewareRequest {
    method?: string;
    headers: Record<string, string | string[] | undefined>;
}

interface MiddlewareResponse {
    setHeader(name: string, value: string): unknown;
    status(code: number): { end(): unknown };
}

type NextFn = (err?: unknown) => void;

/**
 * APW-11 T26 — the delegated-read CORS middleware (plan §4.7).
 *
 * The App Launcher runs on **other people's pages** (`packages/app-launcher` is a web component a
 * customer site embeds), so its two read routes are the only ones in this API that answer a
 * cross-origin browser at all. Everything about this middleware follows from that:
 *
 *   - **An exact allow-list, not a pattern.** `EVER_WORKS_APP_LAUNCHER_ORIGINS` carries up to
 *     {@link APP_LAUNCHER_MAX_ORIGINS} exact `https://` origins. An origin is scheme + host + port and
 *     nothing else, so `https://apps.example.com/` (trailing slash), `http://…`, `*` and
 *     `https://a.example.com,https://b.example.com` written as one entry are all refused rather than
 *     silently coerced.
 *   - **Invalid entries fail boot in production**, exactly as `apps/api/src/cors-validation.ts` does for
 *     `ALLOWED_ORIGINS`: a misconfigured deploy must not come up serving a launcher that no browser can
 *     read. Outside production the invalid entries are dropped with a warning, so a developer's typo is
 *     not a boot failure.
 *   - **`Access-Control-Allow-Credentials` is never sent.** The delegated read is bearer-token only
 *     (APW-12's `@DelegatedRead('apps:read')`), and a cross-origin call from an arbitrary customer page
 *     that could carry cookies is the one thing this surface must not permit (spec S22). The header is
 *     absent by construction, and a test asserts its absence rather than trusting the comment.
 *   - **The token never travels in a URL** (APW-12's `NoTokenInQueryGuard` owns that), so the only
 *     allowed request header is `Authorization`.
 *
 * Preflight answers `204` for every origin: a browser asking about an origin that is not on the list
 * must get a clean, header-less answer (it then blocks the read), not a 4xx that looks like a bug in
 * the caller.
 */

/** The environment variable that carries the allow-list (plan §1, CONTRACTS §7). */
export const APP_LAUNCHER_ORIGINS_ENV = 'EVER_WORKS_APP_LAUNCHER_ORIGINS';

/** The plan's ceiling for the list (plan §4.7: "≤ 50 exact `https://` origins"). */
export const APP_LAUNCHER_MAX_ORIGINS = 50;

/**
 * An exact `https://` **origin**: scheme, host and an optional port, with no path, no query, no
 * credentials and no wildcard. Deliberately anchored on both ends — `https://evil.example.com.attacker.tld`
 * and `https://apps.example.com/` both fail it.
 */
const ORIGIN_PATTERN =
    /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i;

export interface LauncherOriginsParse {
    /** The entries that are valid exact origins, in the order they were written. */
    origins: string[];
    /** The entries that are not, verbatim, for the boot message. */
    invalid: string[];
    /** `true` when the list carries more than {@link APP_LAUNCHER_MAX_ORIGINS} valid entries. */
    tooMany: boolean;
}

/** Splits, trims and classifies the raw value. Pure — the caller decides what to do about it. */
export function parseLauncherOrigins(raw: string | undefined | null): LauncherOriginsParse {
    const entries = (raw ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);

    const origins: string[] = [];
    const invalid: string[] = [];

    for (const entry of entries) {
        if (ORIGIN_PATTERN.test(entry)) {
            // De-duplicate case-insensitively, keeping the first spelling: origins are
            // case-insensitive in their host part, and a duplicate would only ever be a mistake.
            if (!origins.some((origin) => origin.toLowerCase() === entry.toLowerCase())) {
                origins.push(entry);
            }
        } else {
            invalid.push(entry);
        }
    }

    return { origins, invalid, tooMany: origins.length > APP_LAUNCHER_MAX_ORIGINS };
}

const bootLogger = new Logger('LauncherDelegatedCors');

/**
 * The allow-list the middleware uses, validated at boot.
 *
 * Production: any invalid entry, or more than {@link APP_LAUNCHER_MAX_ORIGINS} of them, throws — the
 * same posture as `assertProductionCorsConfig`. Everywhere else the valid entries are kept and the rest
 * are dropped with a warning, and the list is truncated to the ceiling so a runaway variable cannot
 * silently widen the surface.
 */
export function resolveLauncherOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
    const { origins, invalid, tooMany } = parseLauncherOrigins(env[APP_LAUNCHER_ORIGINS_ENV]);
    const production = env.NODE_ENV === 'production';

    if (invalid.length > 0) {
        const message =
            `${APP_LAUNCHER_ORIGINS_ENV} carries ${invalid.length} entry/entries that are not exact ` +
            `https:// origins: ${invalid.join(', ')}. Each entry must be scheme + host + optional port ` +
            `with no path, query or wildcard, e.g. "https://apps.example.com".`;

        if (production) {
            throw new Error(message);
        }
        bootLogger.warn(`${message} Ignored outside production.`);
    }

    if (tooMany) {
        const message =
            `${APP_LAUNCHER_ORIGINS_ENV} carries ${origins.length} origins; the maximum is ` +
            `${APP_LAUNCHER_MAX_ORIGINS} (plan §4.7).`;

        if (production) {
            throw new Error(message);
        }
        bootLogger.warn(`${message} Truncated outside production.`);
        return origins.slice(0, APP_LAUNCHER_MAX_ORIGINS);
    }

    return origins;
}

@Injectable()
export class LauncherDelegatedCorsMiddleware implements NestMiddleware {
    private readonly origins: readonly string[];

    constructor(@Optional() origins?: readonly string[]) {
        // `@Optional()` is load-bearing, NOT decoration. Without it Nest reads this parameter as an
        // injectable dependency and refuses to boot the whole API:
        //   UnknownDependenciesException: Nest can't resolve dependencies of the
        //   LauncherDelegatedCorsMiddleware (?). … argument at index [0] …
        //   dependencies: [ [Function: Object] ]
        // because a `readonly string[]` parameter has no provider token to resolve. `@Optional()`
        // makes Nest inject `undefined` when the token is absent, which is the "read the environment"
        // arm below — exactly what a running process wants. The parameter stays so tests can pass an
        // explicit list (see the spec), and the default reads the environment once, at construction,
        // so a running process cannot change its allow-list without a restart.
        this.origins = origins ?? resolveLauncherOrigins();
    }

    use(req: MiddlewareRequest, res: MiddlewareResponse, next: NextFn): void {
        const header = req.headers.origin;
        const origin = typeof header === 'string' ? header : undefined;

        if (origin && this.origins.includes(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
            res.setHeader('Access-Control-Allow-Headers', 'Authorization');
            // No `Access-Control-Allow-Credentials`, ever — see the class docstring. Its absence is
            // asserted by the spec, not merely intended here.
        }

        if (req.method === 'OPTIONS') {
            res.status(204).end();
            return;
        }

        next();
    }
}
