import { UnknownElementException } from '@nestjs/core/errors/exceptions/unknown-element.exception';

/**
 * Look a provider up by token and answer `undefined` when the container simply
 * does not have it.
 *
 * ## Why this exists
 *
 * `moduleRef.get(Token, { strict: false })` and `appContext.get(Token, …)` do
 * NOT return `undefined` for an absent provider. They THROW
 * `UnknownElementException` (`@nestjs/core/injector/instance-links-host.js`:
 * *"this provider does not exist in the current context"*).
 *
 * The codebase holds both beliefs. `terminal-session.task.ts` and
 * `data-repo-sync-dispatcher.task.ts` wrap the call in `try`, and say why.
 * Several others were written as
 *
 * ```ts
 * const x = ref.get(X, { strict: false });
 * if (!x) return null; // "unbound → safe default"
 * ```
 *
 * where the `if (!x)` branch can never run: an absent provider throws before it
 * is reached. Each of those documents a graceful answer for an unbound
 * dependency and delivers an exception instead. In the API graph the providers
 * exist and it never shows; in any narrower graph — a worker context, a module
 * compiled alone — the "safe default" is a 500 or a failed job.
 *
 * ## Only "not provided" is swallowed
 *
 * Everything else still throws. `InvalidClassScopeException` (asking a
 * request-scoped provider for a static instance) is a real wiring fault and
 * must not be mistaken for "unbound".
 */
export function getOptionalProvider<T = unknown>(
    resolver: { get(token: unknown, options?: { strict?: boolean }): unknown },
    token: unknown,
): T | undefined {
    try {
        return resolver.get(token, { strict: false }) as T;
    } catch (error) {
        if (error instanceof UnknownElementException) return undefined;
        throw error;
    }
}
