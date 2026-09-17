import { API_URL } from '@/lib/constants';
import { resolvePublicApiBaseUrl } from '@/lib/fleet-flags';
import { toComputerSocketUrl } from './computer-bff';

/**
 * The API origin a BROWSER is handed for a WebSocket — which is not
 * necessarily the one the web tier itself calls.
 *
 * ## Why this exists
 *
 * Two attach-token BFF routes mint an absolute socket URL and hand it to the
 * page, which opens it verbatim:
 *
 *  - `app/api/agents/[id]/computer/sessions/[sessionId]/attach-token` — the
 *    agent live view (`use-computer-attach.ts` calls `new WebSocket(wsUrl)`)
 *  - `app/api/agents/[id]/runs/[runId]/terminal/attach-token` — the streaming
 *    terminal
 *
 * Both used to derive that URL from `API_URL` alone. `API_URL` is the
 * SERVER-ONLY address the BFF fetches with, and in every shipped deployment
 * where the API sits behind its own ingress it is an in-cluster name
 * (`http://ever-works-api:3100` in `docker-compose.yml` and in the
 * `.deploy/k8s` web Deployments) that a user's laptop cannot resolve. The
 * socket then fails DNS before it is even dialled and the live view renders
 * its "cannot connect" state.
 *
 * ## The precedence, and why it is the one already documented
 *
 * `lib/fleet-flags.ts` `resolvePublicApiBaseUrl()` already states the rule for
 * exactly this split — `NEXT_PUBLIC_API_URL` is the browser-facing origin and
 * wins WHERE IT IS SET — and is already how the fleet settings page hands a
 * node its enrollment URL. This module reuses it rather than growing a third
 * derivation of the same idea.
 *
 * ## What deliberately does NOT change
 *
 * With `NEXT_PUBLIC_API_URL` unset, the resolved base is the **same `API_URL`
 * constant the route already fetches upstream with** — not a re-read of
 * `process.env.API_URL`, so a deployment whose `API_URL` is genuinely
 * browser-reachable (the `apps/web/.env.example` default `http://localhost:3100`,
 * a single-origin install, nothing-set at all) keeps minting byte-for-byte the
 * URL it minted before. The fix only ever ADDS a way to override an
 * unreachable host; it never narrows a configuration that already worked.
 *
 * ## CSP
 *
 * Reaching the host is necessary, not sufficient: `connect-src` must also list
 * the socket origin, and CSP3 scheme-part matching does not let an `https:`
 * source authorise a `wss:` URL. That half belongs to the policy
 * (`next.config.ts` / `src/proxy.ts`), not here. What this resolver guarantees
 * the policy is a closed set: the URL it mints is always the socket twin of
 * EITHER the `NEXT_PUBLIC_API_URL` origin OR the `API_URL` origin — never a
 * third host — so a policy that lists the socket twins of both origins
 * authorises every URL minted here, in every deployment shape.
 */
export function resolveBrowserApiBaseUrl(): string {
    // A literal `process.env.NEXT_PUBLIC_API_URL` member access on purpose:
    // Next inlines `NEXT_PUBLIC_*` reads at build time by textual
    // substitution, and a dynamic lookup would silently opt out of that.
    return process.env.NEXT_PUBLIC_API_URL ? resolvePublicApiBaseUrl() : API_URL;
}

/**
 * Turn the platform's relative `wsPath` into the absolute, browser-reachable
 * socket URL an attach-token response carries (`http`→`ws`, `https`→`wss`).
 *
 * The scheme/origin rewrite itself is not re-implemented here — it is
 * {@link toComputerSocketUrl}, which both attach routes already agreed on;
 * only the base it is given changes.
 */
export function toAttachSocketUrl(wsPath: string): string {
    return toComputerSocketUrl(resolveBrowserApiBaseUrl(), wsPath);
}
