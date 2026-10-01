/**
 * The Ever ID fixture provider for the Playwright lane (APW-12 T48).
 *
 * ## Why it exists
 *
 * "Sign in with Ever ID" is an OpenID Connect relying party: the API discovers the
 * provider, exchanges codes, verifies ID / access / logout tokens against its key set,
 * and the browser is redirected to the provider and back. The `oidc-identity` package
 * ships a fake provider for exactly this (`@ever-works/oidc-identity/testing`, built to
 * `packages/plugins/oidc-identity/dist/testing/`): discovery, JWKS (ES256), an
 * auto-approving authorize endpoint (PKCE S256 checked), the token endpoint, device
 * authorization, end-session, and logout-token minting. This script runs it as a
 * process the API can reach BEFORE it boots, on a fixed port, so its issuer is stable
 * for the whole run and the API's key cache never sees a second key set.
 *
 * ## Running it
 *
 *     node apps/web/e2e/fakes/ever-id/server.mjs   # EVER_ID_FAKE_PORT, default 3950
 *
 * The issuer is `http://localhost:<port>` — accepted by the plugin only outside
 * production, which is what keeps this fixture out of any real deployment. The API is
 * pointed at it with `EVER_ID_ISSUER_URL`, `EVER_ID_CLIENT_ID=ever-works-web` and
 * `EVER_ID_CLIENT_SECRET=<EVER_ID_FAKE_CLIENT_SECRET>`; Ever ID itself stays OFF until a
 * spec turns it on through the administrator route (`e2e/helpers/ever-id.ts`).
 *
 * ## Control routes (port + 1, never part of the provider)
 *
 *   - `GET  /_control/health`             — `{ status, issuer }`
 *   - `POST /_control/user`               — body `{ subject, email, emailVerified?, name? }`: the person approved next
 *   - `POST /_control/claims`             — body `{ ...claims }`: extra claims on the next ID tokens
 *   - `POST /_control/sid`                — body `{ sid }`: the provider session id the next tokens carry
 *   - `POST /_control/approve`            — approves every pending device code
 *   - `POST /_control/mint-access`        — body `{ subject?, scopes?, authorizedParty?, audience? }` → `{ token }`
 *   - `POST /_control/backchannel-logout` — body `{ url, subject?, sid?, jti? }` → the API's answer
 *   - `GET  /_control/calls`              — every provider request (method + path only)
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The provider port the lane points `EVER_ID_ISSUER_URL` at. */
export const DEFAULT_PORT = 3950;

/** CI-only client secret, obviously fake. The lane passes the same value to the API. */
export const DEFAULT_CLIENT_SECRET = 'e2e-ever-id-client-secret-not-real';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_MODULE = path.resolve(
    here,
    '../../../../../packages/plugins/oidc-identity/dist/testing/fake-oidc-provider.js',
);

async function readJson(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
}

/**
 * Start the provider and its control server. Exported so a unit spec can drive it on
 * ephemeral ports without a second process.
 */
export async function createEverIdFake({
    port = Number(process.env.EVER_ID_FAKE_PORT || DEFAULT_PORT),
    controlPort = port + 1,
    clientSecret = process.env.EVER_ID_FAKE_CLIENT_SECRET || DEFAULT_CLIENT_SECRET,
} = {}) {
    const { FakeOidcProvider } = await import(pathToFileURL(FAKE_MODULE).href);
    const provider = await FakeOidcProvider.start({
        clientId: 'ever-works-web',
        clientSecret,
        localClients: [{ kind: 'cli', clientId: 'ever-works-cli' }],
        devicePollIntervalSeconds: 1,
    });
    if (port !== 0) {
        // Re-listen on the fixed port so the issuer the API is configured with is stable.
        await provider.stop();
        await provider.listen(port);
    }

    const control = http.createServer(async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        const send = (status, body) => {
            response.writeHead(status, {
                'content-type': 'application/json',
                'cache-control': 'no-store',
            });
            response.end(JSON.stringify(body));
        };
        try {
            if (request.method === 'GET' && url.pathname === '/_control/health') {
                return send(200, { status: 'ok', issuer: provider.issuer });
            }
            if (request.method === 'GET' && url.pathname === '/_control/calls') {
                return send(200, {
                    calls: provider.calls.map((call) => ({ method: call.method, path: call.path })),
                });
            }
            if (request.method !== 'POST') return send(404, { error: 'not_found' });
            const body = await readJson(request);
            switch (url.pathname) {
                case '/_control/user':
                    provider.setUser(body);
                    return send(200, { ok: true });
                case '/_control/claims':
                    provider.setIdTokenClaims(body);
                    return send(200, { ok: true });
                case '/_control/sid':
                    provider.setSessionId(String(body.sid));
                    return send(200, { ok: true });
                case '/_control/approve':
                    return send(200, { approved: provider.approveDeviceAuthorization() });
                case '/_control/mint-access':
                    return send(200, {
                        token: await provider.mintAccessToken({
                            subject: body.subject,
                            scopes: body.scopes,
                            authorizedParty: body.authorizedParty,
                            audience: body.audience,
                        }),
                    });
                case '/_control/backchannel-logout':
                    return send(
                        200,
                        await provider.postBackchannelLogout(body.url, undefined, {
                            subject: body.subject ?? null,
                            sid: body.sid ?? null,
                            ...(body.jti ? { jti: body.jti } : {}),
                        }),
                    );
                default:
                    return send(404, { error: 'not_found' });
            }
        } catch (error) {
            // The detail goes to this process's log (the lane prints it when a run
            // fails), never back to the caller.
            console.error('Ever ID fake: control route failed:', error);
            return send(500, { error: 'fake_control_error' });
        }
    });
    await new Promise((resolve) => control.listen(controlPort, '127.0.0.1', resolve));
    const address = control.address();

    return {
        provider,
        issuer: provider.issuer,
        controlUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : controlPort}`,
        async stop() {
            await new Promise((resolve) => control.close(() => resolve(undefined)));
            await provider.stop();
        },
    };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    createEverIdFake()
        .then((fake) => {
            console.log(`Ever ID fake provider: issuer ${fake.issuer}, control ${fake.controlUrl}`);
        })
        .catch((error) => {
            console.error('Ever ID fake provider failed to start:', error);
            process.exit(1);
        });
}
