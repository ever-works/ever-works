import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE, registerUserViaAPI, type RegisteredUser } from './helpers/api';
import {
    assignTaskToAgent,
    createAgentViaAPI,
    createTaskViaAPI,
    listAgentRuns,
} from './helpers/agents-tasks';
import { loginViaUI } from './helpers/auth';

/**
 * Content-Security-Policy — strict. Deepens security-headers-strict.
 * The platform's helmet config sets a CSP. We don't pin specific
 * directive values (they evolve), just family-level invariants:
 *
 *   - default-src or script-src is set (not 'unsafe-inline' alone)
 *   - object-src 'none' (no Flash / Java plugins)
 *   - frame-ancestors 'none'|'self' (clickjacking, complements XFO)
 *   - no obvious wildcard for script-src
 */

function parseCsp(csp: string): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const part of csp.split(';')) {
        const [key, ...values] = part.trim().split(/\s+/);
        if (!key) continue;
        map.set(key.toLowerCase(), values);
    }
    return map;
}

function uniq(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * An Agent + Task + dispatch. The dispatch legitimately fails without a job
 * runtime (the e2e default) but the run row is still persisted, which is all
 * the attach-token route needs. Mirrors `flow-terminal-attach-contract.spec.ts`.
 * Returns `runId: null` when the environment produced no run at all.
 */
async function seedRun(
    request: APIRequestContext,
    user: RegisteredUser,
): Promise<{ agentId: string; runId: string | null }> {
    const agent = await createAgentViaAPI(request, user.access_token, {
        name: `csp-agent-${uniq()}`,
    });
    const task = await createTaskViaAPI(request, user.access_token, {
        title: `csp-task-${uniq()}`,
    });
    await assignTaskToAgent(request, user.access_token, agent.id, task.id);
    const runs = await listAgentRuns(request, user.access_token, agent.id);
    return { agentId: agent.id, runId: runs[0]?.id ?? null };
}

/** The `connect-src` the web tier serves, read off a real navigation. */
async function connectSrcOf(page: Page, web: string): Promise<string[]> {
    const res = await page.goto(`${web}/en/login`, { waitUntil: 'domcontentloaded' });
    const csp =
        res?.headers()['content-security-policy'] ||
        res?.headers()['content-security-policy-report-only'];
    expect(csp, 'the web tier must set a Content-Security-Policy').toBeTruthy();
    return parseCsp(csp as string).get('connect-src') ?? [];
}

test.describe('CSP — API surface', () => {
    test('GET /api/health sets Content-Security-Policy', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/health`);
        const csp = res.headers()['content-security-policy'];
        if (!csp) {
            test.skip(true, 'API does not set Content-Security-Policy — helmet possibly disabled');
        }
        expect(csp!.length).toBeGreaterThan(0);
    });

    test('API CSP does not use script-src *', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/health`);
        const csp = res.headers()['content-security-policy'];
        if (!csp) test.skip(true, 'no CSP set');
        const directives = parseCsp(csp!);
        const scriptSrc = directives.get('script-src') ?? directives.get('default-src') ?? [];
        // A literal `*` in script-src would let any origin run JS —
        // it defeats the entire point of CSP. We don't require a
        // specific allowlist; we just refuse the wildcard.
        expect(
            scriptSrc.includes('*'),
            `script-src includes wildcard: "${scriptSrc.join(' ')}"`,
        ).toBe(false);
    });

    test('API CSP sets object-src none (or default-src none)', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/health`);
        const csp = res.headers()['content-security-policy'];
        if (!csp) test.skip(true, 'no CSP set');
        const directives = parseCsp(csp!);
        const objectSrc = directives.get('object-src');
        const defaultSrc = directives.get('default-src') ?? [];
        // Either explicit `object-src 'none'`, or a default-src that
        // covers it with 'none'/'self'. We don't accept absence here —
        // object-src is the canonical Flash/Java attack surface.
        const explicitNone = objectSrc?.includes("'none'");
        const defaultCovers = defaultSrc.includes("'none'") && objectSrc === undefined;
        if (!explicitNone && !defaultCovers) {
            test.skip(
                true,
                `object-src not pinned: object-src=${objectSrc?.join(' ') ?? '(unset)'}, default-src=${defaultSrc.join(' ')}`,
            );
        }
        expect(explicitNone || defaultCovers).toBe(true);
    });

    test('API CSP sets frame-ancestors none|self', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/health`);
        const csp = res.headers()['content-security-policy'];
        if (!csp) test.skip(true, 'no CSP set');
        const directives = parseCsp(csp!);
        const fa = directives.get('frame-ancestors');
        if (!fa) {
            test.skip(true, 'frame-ancestors not declared — relying on XFO');
        }
        const safe = fa!.some((v) => v === "'none'" || v === "'self'");
        expect(safe, `frame-ancestors not safe: "${fa!.join(' ')}"`).toBe(true);
    });
});

test.describe('CSP — web surface', () => {
    test('login page sets CSP or CSP-Report-Only', async ({ page, baseURL }) => {
        const res = await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        if (!res) test.skip(true, 'no response');
        const csp =
            res!.headers()['content-security-policy'] ||
            res!.headers()['content-security-policy-report-only'];
        if (!csp) {
            test.skip(true, 'web does not set CSP');
        }
        expect(csp!.length).toBeGreaterThan(0);
    });

    test('web connect-src authorises the live-view socket, not just the API origin', async ({
        page,
        baseURL,
    }) => {
        // The Agent computer surface and the streaming terminal open a socket on
        // the API ORIGIN over ws(s) (`lib/api/computer-bff.ts`
        // `toComputerSocketUrl`). CSP3 scheme-part matching does NOT let an
        // http(s) source authorise a ws(s) URL, so a policy that lists only
        // `http://host:port` blocks every live view with "violates … connect-src".
        const res = await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        if (!res) test.skip(true, 'no response');
        const csp =
            res!.headers()['content-security-policy'] ||
            res!.headers()['content-security-policy-report-only'];
        if (!csp) {
            test.skip(true, 'web does not set CSP');
        }
        const connectSrc = parseCsp(csp!).get('connect-src') ?? [];

        const socketSources = connectSrc.filter((source) => /^wss?:\/\//.test(source));
        expect(
            socketSources.length,
            `connect-src has no ws(s) source: "${connectSrc.join(' ')}"`,
        ).toBeGreaterThan(0);

        // The socket URL the browser opens is minted server-side from `API_URL`
        // (`toComputerSocketUrl(API_URL, wsPath)` in the computer attach-token
        // route, the same origin→ws twist in the terminal one). `API_BASE` here
        // IS `process.env.API_URL`, so this is the origin an attach-token
        // response names on this stack — asserted unconditionally, because a
        // policy that authorises some OTHER ws origin blocks the live view just
        // as completely as a policy with no ws source at all.
        const apiOrigin = new URL(API_BASE).origin;
        const bffSocketOrigin = apiOrigin.replace(/^http/, 'ws');
        expect(
            connectSrc,
            `connect-src does not authorise the socket origin the BFF mints (${bffSocketOrigin}): "${connectSrc.join(' ')}"`,
        ).toContain(bffSocketOrigin);

        // And no stray ws source: each one is either the browser-facing API
        // origin's twin (its http source is listed beside it) or the origin the
        // BFF mints from — nothing else, and never a wildcard or bare scheme.
        for (const socket of socketSources) {
            expect(socket, `ws source is not a bare origin: "${socket}"`).toMatch(
                /^wss?:\/\/[a-zA-Z0-9.-]+(?::\d{1,5})?$/,
            );
            expect(
                connectSrc.includes(socket.replace(/^ws/, 'http')) || socket === bffSocketOrigin,
                `ws source "${socket}" belongs to no API origin in the policy`,
            ).toBe(true);
        }
    });

    /**
     * The assertion above derives the socket origin from `API_URL` the same way
     * the BFF does. This one takes the shortcut out of the loop entirely: it
     * asks the web tier for a real attach token and pins the policy against the
     * `wsUrl` that response actually names — the exact string
     * `use-computer-attach.ts` passes to `new WebSocket()`.
     *
     * The streaming terminal's attach-token route is used because its fixture
     * is reachable without a fleet runtime: an Agent, a Task and a dispatch
     * leave a run row behind even when the dispatcher is absent. When the
     * environment cannot produce one, or refuses to mint (no signing secret),
     * the test skips rather than asserting on a fixture that does not exist.
     */
    test('connect-src authorises the socket origin an attach-token response names', async ({
        page,
        request,
        baseURL,
    }) => {
        const web = baseURL || 'http://localhost:3000';
        const user = await registerUserViaAPI(request);
        const { agentId, runId } = await seedRun(request, user);
        test.skip(!runId, 'no AgentRun row was produced by this environment');

        await loginViaUI(page, { email: user.email, password: user.password });

        // Through the WEB tier, with the browser session cookie — this is the
        // route the live surface calls, and the only place `wsUrl` is minted.
        const minted = await page.request.post(
            `${web}/api/agents/${agentId}/runs/${runId as string}/terminal/attach-token`,
            { headers: { 'x-ever-workspace': 'personal' } },
        );
        test.skip(
            minted.status() !== 200,
            `the web tier could not mint an attach token (${minted.status()})`,
        );

        const wsUrl = (await minted.json()).wsUrl as string;
        expect(typeof wsUrl, 'attach-token must name an absolute socket URL').toBe('string');
        expect(wsUrl).toMatch(/^wss?:\/\//);
        const socketOrigin = new URL(wsUrl).origin;

        const connectSrc = await connectSrcOf(page, web);
        expect(
            connectSrc,
            `the browser is told to open ${wsUrl}, but connect-src is "${connectSrc.join(' ')}"`,
        ).toContain(socketOrigin);
    });
});
