import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * flow-account-lifecycle-multistep — DEEP, cross-feature INTEGRATION flows that
 * thread the WHOLE account lifecycle together: profile identity ⇄ the account
 * EXPORT projection ⇄ import/preview/apply ⇄ research opt-out ⇄ email-registry
 * immutability ⇄ (absent) account deletion. Every flow is multi-step and pins a
 * CROSS-cutting invariant the single-purpose account specs leave uncovered.
 *
 * NON-DUPLICATION — surveyed every sibling on this surface and assert only GAPS:
 *   - flow-account-export-import-roundtrip.spec.ts → cross-user WORKS/PLUGIN
 *     materialization counts, masked-secret warnings, conflict strategies
 *     (skip/rename/overwrite), DoS caps, malformed-apply verdicts, auth-gate.
 *   - flow-profile-identity(-deep).spec.ts → committer-email cross-tenant
 *     collision, atomic multi-error DTO reject, JWT /profile-vs-DB /fresh
 *     divergence, avatar host STORE matrix, committerName clear/cap, settings UI.
 *   - flow-account-research-optout.spec.ts → optOut preferences persistence,
 *     PUT alias shapes, refresh gating, in-flight de-dup, Discover render.
 *   - flow-account-deletion-deep.spec.ts → the danger-zone UI double-gate,
 *     anon grace/claim, logout-all revocation.
 * NONE of them assert the COUPLING this file targets:
 *   (a) the export `data.profile` is a strict 3-key {username,email,avatar?}
 *       projection that MIRRORS live username/avatar writes but is BLIND to the
 *       extended identity (committerName/committerEmail/emailBudgetAlerts/
 *       userResearchOptOut) — those live only in /profile/fresh;
 *   (b) import (preview AND apply) IGNORES the payload's `data.profile` — a
 *       cross-account apply never adopts the source's username/email/avatar, so
 *       the target's identity is provably untouched while its works materialize;
 *   (c) research opt-out is ORTHOGONAL to the transfer payload — toggling it
 *       leaves the export byte-stable, and an apply never resets it;
 *   (d) the account email is a READ-ONLY registry — there is no email-management
 *       endpoint, and the profile PUT (forbidNonWhitelisted) rejects `email`, so
 *       the export's profile.email is pinned to the register email for life;
 *   (e) each account facet has its OWN surface — smuggling email/optOut/junk
 *       through PUT /profile is a clean 400, never a silent cross-write;
 *   (f) end-to-end durability: after a full identity+export+opt-out lifecycle,
 *       deletion is unavailable (404) and the export + identity + works survive.
 *
 * PROBED LIVE (curl vs http://127.0.0.1:3100, sqlite in-memory, all flags ON)
 * before any assertion — controller apps/api/src/account/account.controller.ts,
 * service packages/agent/src/account-transfer/account-export.service.ts +
 * account-import.service.ts, DTO apps/api/src/auth/dto/update-profile.dto.ts:
 *   - GET  /api/account/export            → 200 { version:1, exportedAt, includesSecrets,
 *       data:{ profile:{username,email,avatar?}, works:[...], userPlugins:[...] } }.
 *       GET-only: POST/PUT/DELETE → 404. no bearer / garbage bearer → 401.
 *       `?includeSecrets=true` → includesSecrets:true. tail flags with an empty
 *       tail keep version:1 and data keys exactly {profile,userPlugins,works}.
 *   - profile.avatar is OMITTED until one is set; a set avatar appears verbatim.
 *       Anonymous account export → profile {username, email:null} (no avatar).
 *   - PUT /api/auth/profile mirrors username+avatar into the NEXT export; a
 *       committer/budget/optOut write NEVER changes the export bytes.
 *   - PUT /api/auth/profile is whitelist-STRICT (forbidNonWhitelisted): a body
 *       with `email` / `userResearchOptOut` / any unknown key → 400
 *       "property <k> should not exist"; nothing mutates.
 *   - POST /api/account/import/preview echoes payload.data.profile in preview.profile
 *       (informational); POST /api/account/import/apply writes works+userPlugins
 *       ONLY — the caller's user row (username/email/avatar/optOut) is untouched.
 *   - PUT /api/me/work-proposals/preferences {optOut} toggles userResearchOptOut;
 *       the export is byte-identical (minus exportedAt) across a true→false cycle.
 *   - No self-delete endpoint: DELETE /api/account, POST /api/account/delete,
 *       POST /api/auth/delete-account, DELETE /api/auth/profile all → 404.
 *
 * ISOLATION: every flow runs on FRESH registerUserViaAPI() users (the shared
 * in-memory DB + seeded storageState stay clean for sibling specs). API-contract
 * assertions only — no UI nav, no AI/mail/git dependency. Unique suffixes per
 * mutation; ids/slugs matched by toContain (never exact global counts).
 */

const EXPORT_PATH = `${API_BASE}/api/account/export`;
const PREVIEW_PATH = `${API_BASE}/api/account/import/preview`;
const APPLY_PATH = `${API_BASE}/api/account/import/apply`;
const PROFILE_PUT = `${API_BASE}/api/auth/profile`;
const FRESH_PATH = `${API_BASE}/api/auth/profile/fresh`;
const PREFS_PATH = `${API_BASE}/api/me/work-proposals/preferences`;
const TIMEOUT = 25_000;

// Two next/image-allowed hosts (also just valid @IsUrl URLs at the API layer).
const AVATAR_GH = 'https://github.com/octocat.png';
const AVATAR_GOOGLE = 'https://lh3.googleusercontent.com/a/lifecycle.png';

/** Per-test unique suffix — never a module-scope clock at collection time. */
function uniq(tag: string): string {
    return `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

interface ExportProfile {
    username: string;
    email: string | null;
    avatar?: string;
}
interface AccountExport {
    version: number;
    exportedAt: string;
    includesSecrets: boolean;
    data: {
        profile: ExportProfile;
        works: Array<{ slug: string; name: string; [k: string]: unknown }>;
        userPlugins: Array<{ pluginId: string; [k: string]: unknown }>;
        [k: string]: unknown;
    };
}

async function exportAccount(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<AccountExport> {
    const res = await request.get(`${EXPORT_PATH}${query}`, {
        headers: authedHeaders(token),
        timeout: TIMEOUT,
    });
    expect(res.status(), `export status ${res.status()}`).toBe(200);
    return (await res.json()) as AccountExport;
}

/** The export envelope minus the wall-clock field — the stable, comparable core. */
function stableCore(e: AccountExport): string {
    return JSON.stringify({ version: e.version, includesSecrets: e.includesSecrets, data: e.data });
}

async function fresh(request: APIRequestContext, token: string): Promise<Record<string, unknown>> {
    const res = await request.get(FRESH_PATH, { headers: authedHeaders(token), timeout: TIMEOUT });
    expect(res.status(), `fresh status ${res.status()}`).toBe(200);
    const body = await res.json();
    return (body.user ?? body) as Record<string, unknown>;
}

function putProfile(
    request: APIRequestContext,
    token: string,
    patch: Record<string, unknown>,
): Promise<APIResponse> {
    return request.put(PROFILE_PUT, {
        headers: authedHeaders(token),
        data: patch,
        timeout: TIMEOUT,
    });
}

async function putProfileOk(
    request: APIRequestContext,
    token: string,
    patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
    const res = await putProfile(request, token, patch);
    expect(res.status(), `PUT profile body=${await res.text().catch(() => '')}`).toBe(200);
    const body = await res.json();
    return (body.user ?? body) as Record<string, unknown>;
}

async function messageOf(res: APIResponse): Promise<string> {
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    const message = (body as { message?: unknown }).message;
    return Array.isArray(message) ? message.join(' | ') : String(message ?? '');
}

async function applyImport(
    request: APIRequestContext,
    token: string,
    body: unknown,
): Promise<{ status: number; result: any }> {
    const res = await request.post(APPLY_PATH, {
        headers: authedHeaders(token),
        data: body,
        timeout: TIMEOUT,
    });
    return { status: res.status(), result: await res.json().catch(() => null) };
}

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Account lifecycle — identity ⇄ export projection coupling', () => {
    // The export.profile is a strict {username,email,avatar?} MIRROR. avatar is
    // omitted until set; once set it appears verbatim and tracks re-writes across
    // hosts. This is the export-layer identity contract (distinct from the
    // render-time next/image host allow-list the profile-identity siblings cover).
    test('export.profile is a 3-key mirror: avatar omitted until set, then tracks live PUTs across hosts', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;

        // 1. A fresh account has no avatar → the export omits the key entirely.
        const first = await exportAccount(request, token);
        expect(
            Object.keys(first.data.profile).sort(),
            'no-avatar profile is exactly 2 keys',
        ).toEqual(['email', 'username']);
        expect(first.data.profile).not.toHaveProperty('avatar');
        expect(first.data.profile.username, 'mirrors the registered username').toBe(u.name);
        expect(first.data.profile.email, 'mirrors the registered email').toBe(u.email);

        // 2. Set an avatar → the NEXT export carries it verbatim (3-key profile).
        await putProfileOk(request, token, { avatar: AVATAR_GH });
        const withAvatar = await exportAccount(request, token);
        expect(Object.keys(withAvatar.data.profile).sort()).toEqual([
            'avatar',
            'email',
            'username',
        ]);
        expect(withAvatar.data.profile.avatar, 'export reflects the github avatar').toBe(AVATAR_GH);

        // 3. Re-write the avatar to a DIFFERENT host → the export tracks the change
        //    (the export layer stores any valid URL; host allow-listing is a
        //    render-time concern, not an export/transfer one).
        await putProfileOk(request, token, { avatar: AVATAR_GOOGLE });
        const swapped = await exportAccount(request, token);
        expect(swapped.data.profile.avatar, 'export tracks the avatar re-write').toBe(
            AVATAR_GOOGLE,
        );
        expect(swapped.data.profile.avatar).not.toBe(AVATAR_GH);
    });

    // A username change flows into the export; the EXTENDED identity fields
    // (committerName/committerEmail/emailBudgetAlerts) do NOT — they are absent
    // from the projection even though they persist in /profile/fresh. One flow
    // proves both the reflection AND the blindness.
    test('username reflects in the export but committer/budget writes never enter the projection', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;

        const newName = uniq('renamed');
        const committerEmail = `${uniq('bot')}@third-party.test`;
        const updated = await putProfileOk(request, token, {
            username: newName,
            committerName: 'Identity Bot',
            committerEmail,
            emailBudgetAlerts: false,
        });
        // The extended fields DID persist (visible on the DB-fresh view)…
        expect(updated.committerName).toBe('Identity Bot');
        expect(updated.committerEmail).toBe(committerEmail);
        expect(updated.emailBudgetAlerts).toBe(false);

        const exported = await exportAccount(request, token);
        // …username IS mirrored…
        expect(exported.data.profile.username, 'username change reflects in the export').toBe(
            newName,
        );
        // …but the export.profile carries ONLY the 3 canonical keys — no committer/
        // budget leakage into the portable payload.
        expect(Object.keys(exported.data.profile).sort()).toEqual(['email', 'username']);
        const profileBytes = JSON.stringify(exported.data.profile);
        expect(profileBytes.includes('Identity Bot'), 'committerName absent from export').toBe(
            false,
        );
        expect(profileBytes.includes(committerEmail), 'committerEmail absent from export').toBe(
            false,
        );
        expect(
            profileBytes.toLowerCase().includes('budget'),
            'budget flag absent from export',
        ).toBe(false);
    });

    // The email is a READ-ONLY registry: there is NO email-management endpoint and
    // the profile PUT rejects `email` outright, so the export's profile.email is
    // welded to the register email through arbitrary identity churn.
    test('account email is immutable through identity churn — export.email stays the register email', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;

        // Attempt to change the email via the profile surface → rejected 400
        // (forbidNonWhitelisted: `email` is not a profile-DTO field).
        const hijack = await putProfile(request, token, { email: 'hijack@evil.test' });
        expect(hijack.status(), 'email is not a mutable profile field').toBe(400);
        expect(await messageOf(hijack)).toContain('property email should not exist');

        // Now churn every field that IS mutable — username + avatar + committer.
        await putProfileOk(request, token, {
            username: uniq('churn'),
            avatar: AVATAR_GH,
            committerName: 'Churn',
        });

        // Through all of that, the export.email (and /fresh.email) never moved off
        // the register email — the "email registry" is authoritative and read-only.
        const exported = await exportAccount(request, token);
        expect(exported.data.profile.email, 'export.email pinned to register email').toBe(u.email);
        expect((await fresh(request, token)).email, '/fresh.email agrees').toBe(u.email);
        expect(exported.data.profile.email).not.toBe('hijack@evil.test');
    });

    // export.email is the SAME string /profile/fresh reports — the two identity
    // surfaces agree. (There is no /api/me or email-list registry; this export IS
    // the canonical portable email record.)
    test('export.profile identity is consistent with /profile/fresh (single source of identity truth)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const name = uniq('consistent');
        await putProfileOk(request, token, { username: name, avatar: AVATAR_GOOGLE });

        const exported = await exportAccount(request, token);
        const dbRow = await fresh(request, token);
        expect(exported.data.profile.username, 'username matches the DB row').toBe(dbRow.username);
        expect(exported.data.profile.email, 'email matches the DB row').toBe(dbRow.email);
        expect(exported.data.profile.avatar, 'avatar matches the DB row').toBe(dbRow.avatar);
    });

    // An ANONYMOUS (zero-friction) account is a first-class lifecycle state whose
    // export serializes a NULL-email identity and omits avatar — the transfer
    // payload faithfully represents an un-emailed account.
    test('anonymous account exports a null-email, avatar-less identity with empty works/plugins', async ({
        request,
    }) => {
        const anonRes = await request.post(`${API_BASE}/api/auth/anonymous`, {
            data: {},
            timeout: TIMEOUT,
        });
        expect(anonRes.status(), 'anonymous session minted').toBeLessThan(300);
        const anonToken = (await anonRes.json()).access_token as string;
        expect(anonToken, 'anonymous bearer issued').toBeTruthy();

        const exported = await exportAccount(request, anonToken);
        expect(exported.version, 'anon export is a v1 envelope').toBe(1);
        expect(exported.data.profile.email, 'anonymous account has a null export email').toBeNull();
        expect(exported.data.profile).not.toHaveProperty('avatar');
        expect(exported.data.profile.username, 'anon carries a generated username').toBeTruthy();
        expect(exported.data.works, 'a fresh anon owns no works').toEqual([]);
        expect(exported.data.userPlugins, 'a fresh anon owns no plugins').toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Account lifecycle — profile PUT is a strict per-facet whitelist', () => {
    // The profile surface refuses to be a catch-all writer: email, opt-out, and
    // unknown keys each 400 with the exact class-validator whitelist message, and
    // the underlying state is provably unchanged — every account facet keeps its
    // own dedicated endpoint.
    test('smuggling email / optOut / unknown fields through PUT /profile is a clean 400 no-op', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;

        // (a) email — not a profile field.
        const emailAttempt = await putProfile(request, token, { email: 'x@x.test' });
        expect(emailAttempt.status()).toBe(400);
        expect(await messageOf(emailAttempt)).toContain('property email should not exist');

        // (b) userResearchOptOut — owned by /api/me/work-proposals/preferences.
        const optAttempt = await putProfile(request, token, { userResearchOptOut: true });
        expect(optAttempt.status()).toBe(400);
        expect(await messageOf(optAttempt)).toContain(
            'property userResearchOptOut should not exist',
        );

        // (c) an arbitrary unknown key.
        const junkAttempt = await putProfile(request, token, { totallyUnknownField: 'x' });
        expect(junkAttempt.status()).toBe(400);
        expect(await messageOf(junkAttempt)).toContain(
            'property totallyUnknownField should not exist',
        );

        // None of the three rejected writes changed anything: the export identity
        // is still the register identity, and opt-out is still its default (false),
        // proving each rejected key was refused BEFORE any facet moved.
        const exported = await exportAccount(request, token);
        expect(exported.data.profile.email).toBe(u.email);
        expect(
            (await fresh(request, token)).userResearchOptOut,
            'opt-out untouched by the smuggle',
        ).toBe(false);
    });

    // The opt-out facet DOES move through its OWN endpoint — proving the 400 above
    // was a routing/whitelist boundary, not a stuck column. This closes the loop:
    // the field is writable, just not via /profile.
    test('opt-out is settable via its dedicated preferences endpoint though PUT /profile refuses it', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;

        // Refused on /profile…
        const viaProfile = await putProfile(request, token, { userResearchOptOut: true });
        expect(viaProfile.status()).toBe(400);
        expect((await fresh(request, token)).userResearchOptOut).toBe(false);

        // …accepted on the preferences endpoint.
        const viaPrefs = await request.put(PREFS_PATH, {
            headers: authedHeaders(token),
            data: { optOut: true },
            timeout: TIMEOUT,
        });
        expect(viaPrefs.status(), `prefs PUT body=${await viaPrefs.text().catch(() => '')}`).toBe(
            200,
        );
        expect((await viaPrefs.json()).optOut).toBe(true);
        expect(
            (await fresh(request, token)).userResearchOptOut,
            'the dedicated surface persisted it',
        ).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Account lifecycle — research opt-out is orthogonal to the transfer payload', () => {
    // Opt-out is a telemetry/inference gate, not portable account data. Toggling
    // it true→false→true never perturbs the export bytes (opt-out is simply not in
    // the payload) — the export core is stable across the whole cycle.
    test('the export is byte-stable across a full opt-out true→false→true cycle', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        // Give the account a stable, non-trivial identity + one work so the export
        // has real content to be stable ABOUT.
        await putProfileOk(request, token, { username: uniq('stable'), avatar: AVATAR_GH });
        await createWorkViaAPI(request, token, {
            name: `Stable ${uniq('w')}`,
            slug: uniq('stable-w'),
        });

        const baseline = stableCore(await exportAccount(request, token));

        const setOptOut = async (optOut: boolean) => {
            const res = await request.put(PREFS_PATH, {
                headers: authedHeaders(token),
                data: { optOut },
                timeout: TIMEOUT,
            });
            expect(res.status()).toBe(200);
            expect((await res.json()).optOut).toBe(optOut);
        };

        await setOptOut(true);
        expect(
            stableCore(await exportAccount(request, token)),
            'export unchanged after opt-OUT',
        ).toBe(baseline);
        await setOptOut(false);
        expect(
            stableCore(await exportAccount(request, token)),
            'export unchanged after opt-IN',
        ).toBe(baseline);
        await setOptOut(true);
        expect(
            stableCore(await exportAccount(request, token)),
            'export unchanged after re-opt-OUT',
        ).toBe(baseline);
    });

    // An IMPORT never touches the caller's opt-out preference. B opts out, applies
    // A's export (which carries no opt-out at all), and B is STILL opted out — the
    // apply writes works/plugins only, leaving user-preference columns alone.
    test('applying an import never resets the target account opt-out preference', async ({
        request,
    }) => {
        const alice = await registerUserViaAPI(request);
        await createWorkViaAPI(request, alice.access_token, {
            name: `A Work ${uniq('a')}`,
            slug: uniq('a-work'),
        });
        const aliceExport = await exportAccount(request, alice.access_token);

        const bob = await registerUserViaAPI(request);
        // Bob opts OUT first.
        const optRes = await request.put(PREFS_PATH, {
            headers: authedHeaders(bob.access_token),
            data: { optOut: true },
            timeout: TIMEOUT,
        });
        expect(optRes.status()).toBe(200);
        expect((await fresh(request, bob.access_token)).userResearchOptOut).toBe(true);

        // Bob applies Alice's export.
        const { status, result } = await applyImport(request, bob.access_token, {
            payload: aliceExport,
            resolutions: [],
        });
        expect(status).toBe(200);
        expect(result.success).toBe(true);

        // Bob's opt-out survived the import untouched.
        expect(
            (await fresh(request, bob.access_token)).userResearchOptOut,
            "the import did not resurrect Bob's telemetry opt-in",
        ).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Account lifecycle — import ignores the payload identity (isolation crux)', () => {
    // The load-bearing invariant: a cross-account apply MATERIALIZES works but
    // NEVER adopts the payload's data.profile. Bob keeps his own username/email/
    // avatar even though Alice's export carries hers; only Alice's WORK crosses over.
    test('apply materializes the source work but leaves the target identity fully intact', async ({
        request,
    }) => {
        // Alice: a distinct identity + a work.
        const alice = await registerUserViaAPI(request);
        const aliceName = uniq('alice');
        await putProfileOk(request, alice.access_token, { username: aliceName, avatar: AVATAR_GH });
        const aliceSlug = uniq('alice-work');
        await createWorkViaAPI(request, alice.access_token, {
            name: `Alice Work ${aliceSlug}`,
            slug: aliceSlug,
        });
        const aliceExport = await exportAccount(request, alice.access_token);
        expect(aliceExport.data.profile.username).toBe(aliceName);

        // Bob: his own distinct identity, no works.
        const bob = await registerUserViaAPI(request);
        const bobName = uniq('bob');
        await putProfileOk(request, bob.access_token, { username: bobName, avatar: AVATAR_GOOGLE });
        const bobBefore = await fresh(request, bob.access_token);

        // Apply Alice's export into Bob.
        const { status, result } = await applyImport(request, bob.access_token, {
            payload: aliceExport,
            resolutions: [],
        });
        expect(status).toBe(200);
        expect(result.success).toBe(true);
        expect(result.worksCreated, "Alice's work landed in Bob's account").toBe(1);

        // Bob's identity is byte-for-byte what it was — apply never wrote profile.
        const bobAfter = await fresh(request, bob.access_token);
        expect(bobAfter.username, "Bob's username is unchanged").toBe(bobName);
        expect(bobAfter.username, "Bob did NOT inherit Alice's username").not.toBe(aliceName);
        expect(bobAfter.email, "Bob's email is unchanged").toBe(bobBefore.email);
        expect(bobAfter.email, "Bob did NOT inherit Alice's email").not.toBe(alice.email);
        expect(bobAfter.avatar, "Bob's avatar is unchanged").toBe(AVATAR_GOOGLE);

        // And Bob's re-export re-serializes BOB's identity, with Alice's work attached.
        const bobExport = await exportAccount(request, bob.access_token);
        expect(bobExport.data.profile.username).toBe(bobName);
        expect(bobExport.data.profile.email).toBe(bob.email);
        expect(
            bobExport.data.works.map((w) => w.slug),
            "Alice's work is now Bob's",
        ).toContain(aliceSlug);
    });

    // preview ECHOES the incoming payload.data.profile as an informational field —
    // yet that echo is never a mutation. Previewing Alice's export against Bob
    // shows Alice's profile in preview.profile while Bob's own identity is untouched.
    test('import/preview echoes the source profile informationally but mutates nothing', async ({
        request,
    }) => {
        const alice = await registerUserViaAPI(request);
        const aliceName = uniq('src');
        await putProfileOk(request, alice.access_token, { username: aliceName, avatar: AVATAR_GH });
        const aliceExport = await exportAccount(request, alice.access_token);

        const bob = await registerUserViaAPI(request);
        const bobBefore = await fresh(request, bob.access_token);

        const previewRes = await request.post(PREVIEW_PATH, {
            headers: authedHeaders(bob.access_token),
            data: aliceExport,
            timeout: TIMEOUT,
        });
        expect(previewRes.status()).toBe(200);
        const preview = await previewRes.json();
        expect(preview.valid).toBe(true);
        // The preview surfaces the INCOMING profile (so a UI can show "you are
        // importing account X") — Alice's, not Bob's.
        expect(preview.profile.username, 'preview echoes the source username').toBe(aliceName);
        expect(preview.profile.email, 'preview echoes the source email').toBe(alice.email);

        // But Bob's real identity did not move — preview is read-only.
        const bobAfter = await fresh(request, bob.access_token);
        expect(bobAfter.username, "Bob's username untouched by a preview").toBe(bobBefore.username);
        expect(bobAfter.email).toBe(bobBefore.email);
        expect(bobAfter.username, "the echoed source name never became Bob's").not.toBe(aliceName);
    });

    // Symmetry: cross-importing in BOTH directions never bleeds identity either
    // way. After A imports B's export and B imports A's export, each account's
    // export still re-serializes its OWN username/email — identity is per-tenant.
    test('bidirectional cross-import keeps each account identity strictly its own', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);
        const aName = uniq('a-id');
        const bName = uniq('b-id');
        await putProfileOk(request, a.access_token, { username: aName });
        await putProfileOk(request, b.access_token, { username: bName });
        await createWorkViaAPI(request, a.access_token, { name: 'A', slug: uniq('a-w') });
        await createWorkViaAPI(request, b.access_token, { name: 'B', slug: uniq('b-w') });

        const aExport = await exportAccount(request, a.access_token);
        const bExport = await exportAccount(request, b.access_token);

        // A imports B's payload; B imports A's payload.
        expect(
            (await applyImport(request, a.access_token, { payload: bExport, resolutions: [] }))
                .result.success,
        ).toBe(true);
        expect(
            (await applyImport(request, b.access_token, { payload: aExport, resolutions: [] }))
                .result.success,
        ).toBe(true);

        // Each account's identity is still ITS OWN after ingesting the other's data.
        const aAfter = await exportAccount(request, a.access_token);
        const bAfter = await exportAccount(request, b.access_token);
        expect(aAfter.data.profile.username, "A keeps A's name").toBe(aName);
        expect(aAfter.data.profile.email).toBe(a.email);
        expect(bAfter.data.profile.username, "B keeps B's name").toBe(bName);
        expect(bAfter.data.profile.email).toBe(b.email);
        expect(aAfter.data.profile.username, 'no identity bleed A←B').not.toBe(bName);
        expect(bAfter.data.profile.username, 'no identity bleed B←A').not.toBe(aName);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Account lifecycle — export envelope invariants + method/auth gating', () => {
    // The export is a pure, idempotent GET: two back-to-back reads differ ONLY in
    // exportedAt, and every non-GET verb 404s. The envelope is a stable read model.
    test('export is idempotent (only exportedAt varies) and strictly GET-only', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        await putProfileOk(request, token, { username: uniq('idem'), avatar: AVATAR_GH });
        await createWorkViaAPI(request, token, { name: 'Idem', slug: uniq('idem-w') });

        const first = await exportAccount(request, token);
        const second = await exportAccount(request, token);
        expect(stableCore(second), 'two exports share an identical stable core').toBe(
            stableCore(first),
        );
        // The only moving part is the wall-clock stamp (a fresh ISO string each call).
        expect(typeof first.exportedAt).toBe('string');
        expect(new Date(first.exportedAt).getTime(), 'exportedAt parses').toBeGreaterThan(0);

        // Non-GET verbs are unmapped on the export resource.
        for (const method of ['post', 'put', 'delete'] as const) {
            const res = await request[method](EXPORT_PATH, {
                headers: authedHeaders(token),
                timeout: TIMEOUT,
            });
            expect([404, 405], `${method.toUpperCase()} /export → ${res.status()}`).toContain(
                res.status(),
            );
        }
    });

    // The export is single-tenant: it serializes ONLY the caller's own works —
    // one user's owned work never appears in another user's export, even though
    // both hit the identical endpoint. (Complement to import isolation.)
    test('export is caller-scoped — one account never sees another account work', async ({
        request,
    }) => {
        const alice = await registerUserViaAPI(request);
        const aliceSlug = uniq('alice-private');
        await createWorkViaAPI(request, alice.access_token, {
            name: `Alice Private ${aliceSlug}`,
            slug: aliceSlug,
        });
        // Alice's own export DOES contain it.
        const aliceExport = await exportAccount(request, alice.access_token);
        expect(aliceExport.data.works.map((w) => w.slug)).toContain(aliceSlug);

        // A different, fresh account's export never leaks Alice's work.
        const bob = await registerUserViaAPI(request);
        const bobExport = await exportAccount(request, bob.access_token);
        expect(bobExport.data.works, "Bob's fresh account owns no works").toEqual([]);
        expect(
            bobExport.data.works.map((w) => w.slug),
            "Alice's work never appears in Bob's export",
        ).not.toContain(aliceSlug);
        // …and Bob's export identity is Bob's, not Alice's.
        expect(bobExport.data.profile.email).toBe(bob.email);
        expect(bobExport.data.profile.email).not.toBe(alice.email);
    });

    // The export is single-tenant and auth-gated: no bearer and a garbage bearer
    // both 401, and it is never anonymously reachable.
    test('export requires a valid bearer — anonymous and garbage tokens both 401', async ({
        request,
    }) => {
        const noBearer = await request.get(EXPORT_PATH, { timeout: TIMEOUT });
        expect(noBearer.status(), 'no bearer → 401').toBe(401);

        const garbage = await request.get(EXPORT_PATH, {
            headers: { Authorization: 'Bearer not-a-real-token' },
            timeout: TIMEOUT,
        });
        expect(garbage.status(), 'garbage bearer → 401').toBe(401);
    });

    // The v2-tail feature toggles are opt-in and degrade cleanly: for an account
    // with no agents/skills/tasks, requesting the tail keeps version:1 and the data
    // keys exactly {profile,works,userPlugins} — an empty tail never inflates the
    // envelope. includeSecrets echoes into includesSecrets.
    test('tail toggles on an empty account keep a v1 envelope; includeSecrets echoes the flag', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;

        // Default export → v1, secrets off.
        const plain = await exportAccount(request, token);
        expect(plain.version).toBe(1);
        expect(plain.includesSecrets).toBe(false);
        expect(Object.keys(plain.data).sort()).toEqual(['profile', 'userPlugins', 'works']);

        // Requesting every v2 tail section on an EMPTY account → still v1, no tail keys.
        const withTail = await exportAccount(
            request,
            token,
            '?includeAgents=true&includeSkills=true&includeTasks=true&includeTaskChat=true',
        );
        expect(withTail.version, 'empty tail does not bump the version').toBe(1);
        expect(
            Object.keys(withTail.data).sort(),
            'no agents/skills/tasks keys materialize',
        ).toEqual(['profile', 'userPlugins', 'works']);

        // includeSecrets flips the envelope's boolean (a fresh account has no
        // secrets to mask, so this is a pure flag-echo assertion).
        const withSecrets = await exportAccount(request, token, '?includeSecrets=true');
        expect(withSecrets.includesSecrets, 'includeSecrets echoes into the envelope').toBe(true);
        expect(withSecrets.version).toBe(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Account lifecycle — end-to-end durability + deletion unavailability', () => {
    // The full journey in one flow: register → set identity → create work → export
    // → opt out → export (identity+work still present) → attempt delete (every
    // shape 404) → export STILL works with identity+work intact. The account is a
    // durable record; deletion is intentionally not wired server-side.
    test('a full identity+export+opt-out lifecycle survives every deletion attempt (account is durable)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;

        // Build a real identity + a work.
        const name = uniq('lifecycle');
        await putProfileOk(request, token, { username: name, avatar: AVATAR_GH });
        const slug = uniq('lifecycle-w');
        await createWorkViaAPI(request, token, { name: `Lifecycle ${slug}`, slug });

        // Export captures the identity + work.
        const built = await exportAccount(request, token);
        expect(built.data.profile.username).toBe(name);
        expect(built.data.works.map((w) => w.slug)).toContain(slug);

        // Opt out — a real preference toggle mid-lifecycle.
        const optRes = await request.put(PREFS_PATH, {
            headers: authedHeaders(token),
            data: { optOut: true },
            timeout: TIMEOUT,
        });
        expect(optRes.status()).toBe(200);

        // Attempt EVERY known self-delete shape — all unmapped.
        const deleteShapes = [
            { method: 'delete' as const, path: '/api/account' },
            { method: 'post' as const, path: '/api/account/delete' },
            { method: 'post' as const, path: '/api/auth/delete-account' },
            { method: 'delete' as const, path: '/api/auth/profile' },
        ];
        for (const shape of deleteShapes) {
            const res = await request[shape.method](`${API_BASE}${shape.path}`, {
                headers: authedHeaders(token),
                data: {},
                timeout: TIMEOUT,
            });
            expect(
                [404, 405],
                `${shape.method.toUpperCase()} ${shape.path} → ${res.status()} (no self-delete)`,
            ).toContain(res.status());
        }

        // The account is fully intact: the export STILL resolves, and it still
        // carries the identity AND the work built at the top of the journey.
        const survived = await exportAccount(request, token);
        expect(survived.data.profile.username, 'identity survived the deletion attempts').toBe(
            name,
        );
        expect(survived.data.profile.avatar).toBe(AVATAR_GH);
        expect(
            survived.data.works.map((w) => w.slug),
            'the owned work survived the deletion attempts',
        ).toContain(slug);
        // …and the opt-out set mid-lifecycle is still in effect (no cascade cleared it).
        expect((await fresh(request, token)).userResearchOptOut).toBe(true);
    });

    // Deletion never PARTIALLY fires: after the 404 barrage a fresh login still
    // works and re-registering the same email 409s — the email was never freed
    // because nothing was destroyed. (API-layer complement to the UI-driven sibling.)
    test('the (absent) deletion path frees nothing — login still works and re-register 409s', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;

        for (const path of ['/api/account', '/api/auth/profile']) {
            const res = await request.delete(`${API_BASE}${path}`, {
                headers: authedHeaders(token),
                timeout: TIMEOUT,
            });
            expect([404, 405]).toContain(res.status());
        }

        // A fresh login with the original credentials still succeeds.
        const login = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: u.email, password: u.password },
            timeout: TIMEOUT,
        });
        expect(login.status(), 'account intact — login works after delete attempts').toBe(200);

        // The email was never released → re-registering it is a 409 conflict.
        const dup = await request.post(`${API_BASE}/api/auth/register`, {
            data: { username: uniq('dup'), email: u.email, password: 'AnotherPass1!secure' },
            timeout: TIMEOUT,
        });
        expect(dup.status(), 're-register same email → conflict').toBe(409);
        expect(JSON.stringify(await dup.json()).toLowerCase()).toContain('already exists');
    });
});
