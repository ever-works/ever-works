import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';

/**
 * Mutable holder stored in the `AsyncLocalStorage`.
 *
 * We store a holder (`{ current }`) rather than the JWT directly because
 * the value is not known when the frame is opened: the middleware opens
 * the frame (it is the only place with a `next()` to wrap), but the
 * *guard* — which runs later, inside that same frame — is what decides
 * whether the credential is acceptable. A guard cannot restart the
 * `run()` frame, so it seeds the holder in place.
 *
 * Same shape, and for the same reason, as `ScopeHolder` in
 * `apps/api/src/scope/scope-context.service.ts`.
 */
interface CallerHolder {
	/** The caller's per-user JWT, or `null` if this request has no verified caller identity. */
	current: string | null;
}

/**
 * Propagates the calling user's identity from the inbound MCP request to
 * the outbound upstream API request.
 *
 * **Why this exists (the P1 it fixes).** Every data tool returned
 * `API Error (401): Unauthorized` in production while the same token,
 * on the same Work, called directly against the API returned 200. The
 * MCP server authenticated the caller correctly and then dropped the
 * identity on the floor.
 *
 * The cause was an object-identity mismatch, not a scoping mistake:
 *
 * - `ApiKeyGuard` receives the raw Express request from
 *   `ExecutionContext.switchToHttp().getRequest()` and stashed the JWT
 *   on it.
 * - `@rekog/mcp-nest` binds a *different* object to Nest's `REQUEST`
 *   token. Its `ExpressHttpAdapter.adaptRequest()` builds a fresh plain
 *   wrapper `{ url, method, headers, query, body, params, get, raw }`
 *   and the tools handler calls
 *   `moduleRef.registerRequestByContextId(httpRequest, contextId)` with
 *   that *wrapper*.
 *
 * So `@Inject(REQUEST)` yielded the wrapper, whose `__callerJwt` was
 * always `undefined` — the guard's write had landed one level below, on
 * `wrapper.raw`. `ApiClientService` then sent no `Authorization` header
 * at all, and in `per-user-jwt` mode there is no shared key to fall
 * back to, so the upstream rejected every call.
 *
 * **Why `AsyncLocalStorage` and not the alternatives.** Reaching through
 * `request.raw` would be a one-line fix, but it hard-codes a private
 * detail of the library's adapter: the day that wrapper changes shape,
 * the identity silently vanishes again and every tool 401s again, with
 * green unit tests — which is precisely how this defect shipped.
 * Threading the JWT as an explicit parameter through every tool method
 * has the same failure mode by omission: a new tool that forgets to
 * forward it regresses silently. `AsyncLocalStorage` binds to the async
 * context of the request itself, so it does not care which object the
 * transport chooses to hand to the DI container.
 *
 * This mirrors the established house pattern in
 * `apps/api/src/scope/scope-context.service.ts` (`ScopeContextService`),
 * which propagates `{ tenantId, organizationId }` the same way, is
 * seeded by a middleware, and is re-seeded in place by a guard.
 *
 * **Isolation.** Each request gets its own `run()` frame and therefore
 * its own holder; concurrent callers never observe each other's token.
 * `apps/mcp/test/caller-identity.e2e.spec.ts` pins this with two
 * genuinely overlapping tool calls held open at the upstream.
 *
 * **Outside any `run()` frame `getCallerJwt()` returns `null`** — the
 * correct answer for the stdio transport, which has no HTTP request at
 * all and legitimately uses the shared key.
 */
@Injectable()
export class CallerContextService {
	private readonly storage = new AsyncLocalStorage<CallerHolder>();

	/**
	 * Open a fresh caller-context frame for one request and run `fn`
	 * inside it. Called by `CallerContextMiddleware`, which is the only
	 * place in the request lifecycle that can wrap all downstream work
	 * (a guard's `canActivate` returns a boolean and cannot).
	 */
	run<T>(fn: () => T): T {
		return this.storage.run({ current: null }, fn);
	}

	/**
	 * Record the caller's verified identity for the remainder of this
	 * request. Called by `ApiKeyGuard` *after* its credential checks
	 * pass, so an unauthenticated request never seeds an identity.
	 *
	 * Outside a `run()` frame this is a no-op: there is nothing to seed,
	 * and inventing a store here would let a token escape the request
	 * that produced it.
	 */
	setCallerJwt(jwt: string): void {
		const holder = this.storage.getStore();
		if (!holder) return;
		holder.current = jwt;
	}

	/**
	 * The caller's JWT for the request in flight, or `null` when there
	 * is none (stdio transport, or an HTTP request whose guard did not
	 * seed one).
	 */
	getCallerJwt(): string | null {
		return this.storage.getStore()?.current ?? null;
	}
}
