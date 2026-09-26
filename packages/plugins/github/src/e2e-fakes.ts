/**
 * The App Works acceptance harness' non-production GitHub switch
 * (APW-13 T5; CONTRACTS §7, the `EVER_WORKS_E2E_FAKES` row; plan §8.3
 * "Pointing the platform at it").
 *
 * The acceptance lanes run the platform against a **fake GitHub** instead of the
 * real service. `EVER_WORKS_E2E_FAKES=1` plus `APW_E2E_GITHUB_FAKE_URL` make the
 * GitHub plugin build every provider URL it owns — the API base URL of each
 * Octokit call, the clone URL handed to git, the clickable web URL and the raw
 * content URL — from the fake's origin.
 *
 * Three properties this module keeps, each of them a way the switch can go
 * wrong silently:
 *
 * 1. **Non-production only.** `NODE_ENV === 'production'` refuses the switch
 *    outright, so a production deployment cannot be pointed at a fake even when
 *    the variables are present in its environment.
 * 2. **Explicitly armed.** `EVER_WORKS_E2E_FAKES` must be exactly the string
 *    `'1'`; unset, empty, `'true'` or any other value leaves the plugin on real
 *    GitHub. There is no truthiness here — the switch is a deliberate act.
 * 3. **Read at call time.** The environment is read *inside* the resolver, never
 *    captured at module load, so a lane process (and a unit test) can flip it
 *    between assertions.
 *
 * It lives in its own module rather than in `github.plugin.ts` because
 * `github.plugin.ts` imports `github-api.service.ts`; exporting the resolver
 * from the plugin and importing it in the service would close that import into a
 * cycle. A leaf module is additive for both and cycle-free.
 */

/** Name of the arming variable — the CONTRACTS §7 row of the same name. */
export const APW_E2E_FAKES_SWITCH_ENV = 'EVER_WORKS_E2E_FAKES';

/** Name of the variable carrying the fake's origin (`http://127.0.0.1:3900` in the PR lane). */
export const APW_E2E_GITHUB_FAKE_URL_ENV = 'APW_E2E_GITHUB_FAKE_URL';

/**
 * Resolve the fake GitHub origin this process should use, or `undefined` when
 * the switch does not apply (production, unarmed, or no usable origin).
 *
 * A trailing slash is stripped so every caller can join with `/${owner}/…`
 * without producing a doubled slash; a value that is empty — or nothing but
 * slashes — after trimming counts as "not set", and therefore leaves the switch
 * off rather than yielding an empty origin that would build relative URLs.
 *
 * This resolver never runs the SSRF guard and never sees an admin setting: it
 * reads the process environment only. Callers apply its result *after* the guard
 * has judged the configured `apiBaseUrl`, so a loopback value in the admin
 * setting is refused exactly as before the switch existed.
 */
export function resolveGitHubE2eFakeOrigin(): string | undefined {
	if (process.env.NODE_ENV === 'production') {
		return undefined;
	}
	if (process.env[APW_E2E_FAKES_SWITCH_ENV] !== '1') {
		return undefined;
	}
	const configured = process.env[APW_E2E_GITHUB_FAKE_URL_ENV];
	if (typeof configured !== 'string') {
		return undefined;
	}
	const origin = configured.trim().replace(/\/+$/, '');
	return origin.length > 0 ? origin : undefined;
}
