import { Injectable, Inject, NestMiddleware } from '@nestjs/common';
import { CallerContextService } from './caller-context.service.js';

/**
 * Opens the per-request caller-context frame.
 *
 * Middleware — not a guard — because only middleware has a `next()` to
 * wrap: `AsyncLocalStorage.run(store, () => next())` keeps every later
 * step of the request (guard, controller, the MCP tools handler, the
 * tool method, and the upstream `fetch`) inside the same frame. A Nest
 * guard's `canActivate` merely returns a boolean, so a `run()` opened
 * there would already have closed by the time the tool executes.
 *
 * This middleware deliberately does **not** read or trust any header.
 * It only creates an empty frame; `ApiKeyGuard` seeds the identity into
 * it after its credential checks pass. Opening the frame and deciding
 * who the caller is therefore stay separate concerns, and an
 * unauthenticated request runs with an empty frame.
 *
 * Mirrors `ScopeContextMiddleware` in
 * `apps/api/src/scope/scope-context.middleware.ts`.
 */
@Injectable()
export class CallerContextMiddleware implements NestMiddleware {
	constructor(@Inject(CallerContextService) private readonly callerContext: CallerContextService) {}

	use(_req: unknown, _res: unknown, next: () => void): void {
		this.callerContext.run(() => next());
	}
}
