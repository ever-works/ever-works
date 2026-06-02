import { Injectable, Logger, NestMiddleware, NotFoundException } from '@nestjs/common';
import { OrganizationRepository, UserRepository } from '@ever-works/agent/database';
import { EMPTY_SCOPE, ScopeContext } from './scope-context.types';
import { ScopeContextService } from './scope-context.service';

/**
 * Minimal request/response/next shapes we read here. Avoids dragging
 * the full `express` types into ts-jest, which resolves them
 * differently than SWC at runtime and trips up the build.
 */
interface MiddlewareRequest {
    params: Record<string, string | undefined>;
    headers: Record<string, string | string[] | undefined>;
}
type NextFn = (err?: unknown) => void;

/**
 * Security: matches C0 control chars (U+0000–U+001F, incl. CR/LF and the
 * ESC at U+001B that begins ANSI escape sequences), DEL (U+007F), and the
 * C1 range (U+0080–U+009F). Built from a string so no raw control bytes
 * live in the source. Used to neutralize untrusted slug values before they
 * are embedded in log lines so they cannot forge extra entries.
 */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]+', 'g');

/**
 * EW-659 (Tenants & Organizations Phase 7) — slug routing middleware.
 *
 * Resolves the request's scope from either a `:slug` URL segment
 * (when the request comes through a `/api/<slug>/...` route) or the
 * `X-Scope-Slug` HTTP header (when the web client calls a non-prefixed
 * endpoint but wants its scope honored). Populates
 * [`ScopeContextService`](./scope-context.service.ts) via `runWith`
 * so the rest of the request — including the Phase 5b
 * [`ScopeStampingSubscriber`](./scope-stamping.subscriber.ts) — sees
 * the resolved `{ tenantId, organizationId }`.
 *
 * **Resolution order** (per [spec.md §4.2](../../../../docs/specs/features/tenants-and-organizations/spec.md#42-slug-resolution)):
 *
 *   1. Read slug from `req.params.slug`, falling back to the
 *      `x-scope-slug` HTTP header.
 *   2. If the slug is empty / absent, run the request under
 *      `EMPTY_SCOPE` (legacy un-prefixed routes — both shapes
 *      coexist per NN #20 "additive only").
 *   3. Try `OrganizationRepository.findBySlug(slug)`. On hit, the
 *      scope is `{ tenantId: org.tenantId, organizationId: org.id }`.
 *   4. Fall back to `UserRepository.findBySlug(slug)`. On hit, the
 *      scope is `{ tenantId: user.tenantId ?? null, organizationId: null }`
 *      (the bare-Tenant surface). This is also the "personal account"
 *      scope for a user who hasn't created any Organizations yet —
 *      `user.tenantId` is then `null` and the scope is effectively
 *      `EMPTY_SCOPE`, which is correct.
 *   5. On no hit: 404 (`NotFoundException`). Distinguishes from
 *      "exists but you can't see it" (403) — slug lookup is a public
 *      operation; either the slug exists or it doesn't.
 *
 * The `users.slug` ↔ `organizations.slug` namespace is globally
 * unique (the [`UsernameAllocatorService`](../users/services/username-allocator.service.ts)
 * collides-checks both tables on every allocation), so steps 3 and 4
 * can never both hit for the same slug.
 *
 * **Wraps `next()` in `runWith`** so the ALS context propagates
 * through async/await chains for the rest of the request. Without
 * this, the scope would be set at middleware time and lost by the
 * time the controller awaits the database.
 */
@Injectable()
export class ScopeResolverMiddleware implements NestMiddleware {
    private readonly logger = new Logger(ScopeResolverMiddleware.name);

    constructor(
        private readonly scopeContext: ScopeContextService,
        private readonly userRepository: UserRepository,
        private readonly organizationRepository: OrganizationRepository,
    ) {}

    async use(req: MiddlewareRequest, _res: unknown, next: NextFn): Promise<void> {
        const slug = this.extractSlug(req);

        if (!slug) {
            // Legacy un-prefixed route, or an exempt path. Run under
            // EMPTY_SCOPE so the subscriber's beforeInsert hook sees
            // `null` for both fields and doesn't stamp anything.
            this.scopeContext.runWith(EMPTY_SCOPE, () => next());
            return;
        }

        const scope = await this.resolveScope(slug);
        if (!scope) {
            throw new NotFoundException(`Slug '${slug}' not found`);
        }

        this.scopeContext.runWith(scope, () => next());
    }

    /**
     * Pulls the slug from the URL `:slug` route param first, then
     * from the `X-Scope-Slug` header. Normalizes whitespace + empty
     * strings to `null`.
     *
     * Handles array-valued headers (HTTP proxies + load balancers
     * sometimes merge duplicate `X-Scope-Slug` values into a `string[]`
     * — Express surfaces them as-is). Take the first non-empty entry;
     * silently dropping the header would let an attacker bypass scope
     * resolution by sending two values. (Greptile P2 on PR #1059.)
     */
    private extractSlug(req: MiddlewareRequest): string | null {
        const fromParam = req.params.slug;
        if (typeof fromParam === 'string' && fromParam.trim().length > 0) {
            return fromParam.trim();
        }
        const headerValue = req.headers['x-scope-slug'];
        const headerStr = Array.isArray(headerValue)
            ? headerValue.find((v) => typeof v === 'string' && v.trim().length > 0)
            : headerValue;
        if (typeof headerStr === 'string' && headerStr.trim().length > 0) {
            return headerStr.trim();
        }
        return null;
    }

    /**
     * Resolve a slug to `{ tenantId, organizationId }`. Returns
     * `null` on no hit (which the caller maps to 404).
     */
    private async resolveScope(slug: string): Promise<ScopeContext | null> {
        const org = await this.organizationRepository.findBySlug(slug);
        if (org) {
            return { tenantId: org.tenantId, organizationId: org.id };
        }

        const user = await this.userRepository.findBySlug(slug);
        if (user) {
            return {
                tenantId: user.tenantId ?? null,
                organizationId: null,
            };
        }

        // Security: `slug` originates from the untrusted `X-Scope-Slug`
        // header / URL param and is only whitespace-trimmed upstream, so it
        // can carry newlines or ANSI escapes that would forge extra log
        // lines (log injection). Collapse control chars to a single space
        // and cap length before embedding it in the log string.
        const safeSlug = slug.replace(CONTROL_CHARS, ' ').slice(0, 128);
        this.logger.debug(`Scope resolution miss for slug='${safeSlug}'`);
        return null;
    }
}
