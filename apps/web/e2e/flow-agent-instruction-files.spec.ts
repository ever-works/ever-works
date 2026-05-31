import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { createAgentViaAPI } from './helpers/agents-tasks';

/**
 * Agent instruction files (FULL) — multi-file persistence, optimistic-concurrency
 * conflicts, and the controlled-textarea UI editor round-trip.
 *
 * Phase-4 of the Agents/Skills/Tasks surface stores the FIVE canonical Agent
 * definition files DB-inline for tenant-scoped agents:
 *   SOUL.md · AGENTS.md · HEARTBEAT.md · TOOLS.md · agent.yml
 *
 * Verified against the live stack (sqlite in-memory, same driver CI uses):
 *
 *   GET  /api/agents/:id/files/:name
 *        → 200 { name, body, hash, storage:'db' }
 *        Untouched files report body '' and hash ''. The `hash` field is the
 *        SHARED sha256 of the canonical 5-file concatenation (the agent's
 *        `contentHash` / ETag) — so after ANY edit, every file's GET reports
 *        the SAME hash, while each retains its OWN independent `body`.
 *
 *   PUT  /api/agents/:id/files/:name  { body, expectedHash? }
 *        → 200 { newHash }  (64-hex). Each successful write recomputes the
 *        shared content hash, so editing one file advances the hash but leaves
 *        the OTHER files' bodies byte-for-byte intact (independence is asserted
 *        on BODY, not on the shared hash).
 *        Optimistic concurrency: when `expectedHash` is supplied and does NOT
 *        equal the agent's current contentHash, the write is REJECTED with
 *        HTTP 400 (BadRequestException — NOT 409) and the message
 *        "Agent file was modified elsewhere — reload and try again (etag mismatch)."
 *        The rejected write is a no-op: the persisted body does not change.
 *        Invalid file names → 400 with an allow-list message.
 *
 * The whole feature is deterministic — no LLM, no Trigger.dev — so it is fully
 * assertable in CI.
 *
 * Isolation policy: API-only orchestration (flows 1 & 2) runs on FRESH
 * registered users so the shared in-memory DB stays clean for sibling specs.
 * The UI round-trip (flow 3) must use the SEEDED user, because the page is
 * server-rendered against the browser's logged-in session (storageState) and
 * can only read an agent that the seeded user owns.
 */

const HEX64 = /^[0-9a-f]{64}$/;
const CONFLICT_MESSAGE =
    'Agent file was modified elsewhere — reload and try again (etag mismatch).';

const ALL_FILES = ['SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'TOOLS.md', 'agent.yml'] as const;
type CanonicalFile = (typeof ALL_FILES)[number];

interface AgentFile {
    name: string;
    body: string;
    hash: string;
    storage: 'git' | 'db';
}

async function registerFreshToken(request: APIRequestContext): Promise<string> {
    const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const res = await request.post(`${API_BASE}/api/auth/register`, {
        data: {
            username: `instr${stamp}`.slice(0, 30),
            email: `instr-${stamp}@test.local`,
            password: 'TestPass1!secure',
        },
    });
    expect(res.status(), `register body=${await res.text().catch(() => '')}`).toBe(201);
    const json = await res.json();
    expect(json.access_token, 'register returns a 32-char opaque access_token').toBeTruthy();
    return json.access_token;
}

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    // LOGIN DTO is whitelisted — ONLY {email,password}; passing `name` → 400.
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status()).toBe(200);
    return (await res.json()).access_token;
}

async function readFile(
    request: APIRequestContext,
    token: string,
    agentId: string,
    name: CanonicalFile,
): Promise<AgentFile> {
    const res = await request.get(`${API_BASE}/api/agents/${agentId}/files/${name}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `read ${name} body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

/** Raw PUT — returns the APIResponse so callers can assert status + body on rejection. */
async function putFileRaw(
    request: APIRequestContext,
    token: string,
    agentId: string,
    name: CanonicalFile,
    body: string,
    expectedHash?: string,
) {
    return request.put(`${API_BASE}/api/agents/${agentId}/files/${name}`, {
        headers: authedHeaders(token),
        data: expectedHash === undefined ? { body } : { body, expectedHash },
    });
}

async function writeFile(
    request: APIRequestContext,
    token: string,
    agentId: string,
    name: CanonicalFile,
    body: string,
    expectedHash?: string,
): Promise<{ newHash: string }> {
    const res = await putFileRaw(request, token, agentId, name, body, expectedHash);
    expect(res.status(), `write ${name} body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

test.describe('Agent instruction files (full) — multi-file persistence + concurrency', () => {
    test('all 5 canonical files persist independent bodies behind one shared content hash', async ({
        request,
    }) => {
        const token = await registerFreshToken(request);
        const stamp = Date.now().toString(36);

        const agent = await createAgentViaAPI(request, token, {
            name: `Instruction Files ${stamp}`,
            scope: 'tenant',
        });
        expect(agent.scope).toBe('tenant');

        // 1. All five files start empty (body '', hash '') — the agent has no
        //    contentHash yet, so the shared ETag is the empty string.
        for (const name of ALL_FILES) {
            const f = await readFile(request, token, agent.id, name);
            expect(f.name).toBe(name);
            expect(f.body).toBe('');
            expect(f.hash).toBe('');
            expect(f.storage).toBe('db');
        }

        // Author a distinct body per file. The trailing per-file token lets us
        // prove later that the right body landed in the right column.
        const bodies: Record<CanonicalFile, string> = {
            'SOUL.md': `# Soul ${stamp}\n\nYou are meticulous and cite sources. [soul:${stamp}]`,
            'AGENTS.md': `# Operating manual ${stamp}\n\nFollow the playbook strictly. [agents:${stamp}]`,
            'HEARTBEAT.md': `# Heartbeat ${stamp}\n\nCheck the queue every cycle. [heartbeat:${stamp}]`,
            'TOOLS.md': `# Tools ${stamp}\n\nPrefer the read-only tools first. [tools:${stamp}]`,
            'agent.yml': `name: instruction-files-${stamp}\nmodel: gpt-omni\n# [yml:${stamp}]`,
        };

        // 2. PUT each file in turn. Every write returns a fresh 64-hex hash, and
        //    because the hash is the 5-file concatenation, each successive write
        //    produces a DIFFERENT hash from the previous one (a real edit moved
        //    real bytes). Collect them to prove uniqueness.
        const seenHashes: string[] = [];
        let prevHash = ''; // current shared ETag; '' before the first write.
        for (const name of ALL_FILES) {
            // Supplying the (correct) current hash exercises the optimistic-
            // concurrency happy path on every write, not just the no-hash path.
            const { newHash } = await writeFile(
                request,
                token,
                agent.id,
                name,
                bodies[name],
                prevHash,
            );
            expect(newHash, `${name} newHash should be 64-hex`).toMatch(HEX64);
            expect(newHash).not.toBe('');
            expect(newHash, `${name} edit must advance the shared hash`).not.toBe(prevHash);
            seenHashes.push(newHash);
            prevHash = newHash;
        }

        // All five writes produced five DISTINCT shared hashes.
        expect(new Set(seenHashes).size, 'each edit yields a unique content hash').toBe(5);
        const finalHash = seenHashes[seenHashes.length - 1];

        // 3. Read every file back: each retains its OWN body, and every file now
        //    reports the SAME shared content hash (the final ETag). Editing one
        //    did NOT clobber any other file's body.
        for (const name of ALL_FILES) {
            const f = await readFile(request, token, agent.id, name);
            expect(f.body, `${name} body persisted exactly`).toBe(bodies[name]);
            expect(f.hash, `${name} reports the shared final content hash`).toBe(finalHash);
            expect(f.hash).toMatch(HEX64);
        }

        // 4. Targeted independence proof: re-edit ONLY agent.yml and confirm the
        //    four MD files' bodies are byte-for-byte unchanged while the shared
        //    hash advances again.
        const ymlV2 = `${bodies['agent.yml']}\nrevision: 2`;
        const afterYml = await writeFile(request, token, agent.id, 'agent.yml', ymlV2, finalHash);
        expect(afterYml.newHash).toMatch(HEX64);
        expect(afterYml.newHash).not.toBe(finalHash);

        for (const name of ['SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'TOOLS.md'] as const) {
            const f = await readFile(request, token, agent.id, name);
            expect(f.body, `${name} survived the agent.yml re-edit`).toBe(bodies[name]);
            expect(f.hash, `${name} now reflects the latest shared hash`).toBe(afterYml.newHash);
        }
        const ymlNow = await readFile(request, token, agent.id, 'agent.yml');
        expect(ymlNow.body).toBe(ymlV2);

        // 5. Invalid file name is rejected by the controller allow-list (400),
        //    and never touches stored state.
        const evil = await request.put(`${API_BASE}/api/agents/${agent.id}/files/EVIL.md`, {
            headers: authedHeaders(token),
            data: { body: 'nope' },
        });
        expect(evil.status()).toBe(400);
        const evilBody = await evil.json();
        expect(String(evilBody.message)).toContain('Invalid Agent file name');
        expect(String(evilBody.message)).toContain('SOUL.md');
    });

    test('stale expectedHash is rejected with the etag-mismatch contract and is a no-op', async ({
        request,
    }) => {
        const token = await registerFreshToken(request);
        const stamp = Date.now().toString(36);

        const agent = await createAgentViaAPI(request, token, {
            name: `Conflict Agent ${stamp}`,
            scope: 'tenant',
        });

        // v1 — first write (no expectedHash). Establishes hash H1.
        const v1Body = `# version one ${stamp}`;
        const { newHash: h1 } = await writeFile(request, token, agent.id, 'SOUL.md', v1Body);
        expect(h1).toMatch(HEX64);

        // v2 — second write carrying the CORRECT current hash H1 → succeeds, H2.
        //      This is the optimistic-concurrency happy path. H1 is now STALE.
        const v2Body = `# version two ${stamp}`;
        const { newHash: h2 } = await writeFile(request, token, agent.id, 'SOUL.md', v2Body, h1);
        expect(h2).toMatch(HEX64);
        expect(h2).not.toBe(h1);

        // v3 — third write replaying the STALE H1 → MUST be rejected. The service
        //      throws BadRequestException, so the HTTP status is 400 (NOT 409),
        //      with the exact etag-mismatch message.
        const stale = await putFileRaw(
            request,
            token,
            agent.id,
            'SOUL.md',
            `# version three ${stamp}`,
            h1,
        );
        expect(stale.status(), `stale PUT body=${await stale.text().catch(() => '')}`).toBe(400);
        const staleJson = await stale.json();
        expect(staleJson.message).toBe(CONFLICT_MESSAGE);
        expect(staleJson.error).toBe('Bad Request');
        expect(staleJson.statusCode).toBe(400);

        // The rejected write is a NO-OP: the persisted body is still v2, and the
        // hash is still H2 (the stale attempt did not mutate anything).
        const afterReject = await readFile(request, token, agent.id, 'SOUL.md');
        expect(afterReject.body).toBe(v2Body);
        expect(afterReject.hash).toBe(h2);

        // An empty-string expectedHash against an already-hashed file is ALSO a
        // mismatch (current hash is H2, not '') → rejected the same way. This
        // distinguishes "omit expectedHash" (bypass, allowed) from "send the
        // wrong hash" (guarded, rejected).
        const wrongEmpty = await putFileRaw(request, token, agent.id, 'SOUL.md', 'x', '');
        expect(wrongEmpty.status()).toBe(400);
        expect((await wrongEmpty.json()).message).toBe(CONFLICT_MESSAGE);

        // Recovery: re-read to get the live hash, then retry with it → succeeds.
        const live = await readFile(request, token, agent.id, 'SOUL.md');
        const v3Body = `# version three reconciled ${stamp}`;
        const { newHash: h3 } = await writeFile(
            request,
            token,
            agent.id,
            'SOUL.md',
            v3Body,
            live.hash,
        );
        expect(h3).toMatch(HEX64);
        expect(h3).not.toBe(h2);
        const final = await readFile(request, token, agent.id, 'SOUL.md');
        expect(final.body).toBe(v3Body);
        expect(final.hash).toBe(h3);
    });

    test('UI editor: edit SOUL.md via the controlled textarea, autosave ✓, reload, cross-check API', async ({
        page,
        request,
    }) => {
        // The Instructions page is server-rendered against the browser session
        // (storageState = seeded user), so the agent MUST be owned by the seeded
        // user for the SSR file fetch to succeed.
        const token = await seededToken(request);
        const stamp = Date.now().toString(36);

        const agent = await createAgentViaAPI(request, token, {
            name: `Instruction UI ${stamp}`,
            scope: 'tenant',
        });

        // Seed a known SOUL.md body so we prove the editor renders persisted
        // state on first paint (and so we can detect the edit replacing it).
        const seeded = `# Seeded soul ${stamp}\noriginal first paragraph`;
        await writeFile(request, token, agent.id, 'SOUL.md', seeded);

        // Routes are unprefixed (next-intl localePrefix:'never').
        await page.goto(`/agents/${agent.id}/instructions`, { waitUntil: 'domcontentloaded' });

        // The editor renders a single textarea for the ACTIVE file (default
        // 'SOUL.md'); its aria-label === the file name (AgentInstructionsEditor).
        const soulTextarea = page.getByRole('textbox', { name: 'SOUL.md' });
        await expect(soulTextarea).toBeVisible({ timeout: 30_000 });

        // Persisted body renders into the editor (dev hydration can lag → poll).
        await expect
            .poll(async () => (await soulTextarea.inputValue()) ?? '', { timeout: 30_000 })
            .toContain(`Seeded soul ${stamp}`);

        // Edit through the UI. The textarea is a CONTROLLED React input
        // (value={buffers[active]}), so fill()/keyboard fight React re-asserting
        // `value`. Set it via the native setter + a dispatched 'input' event —
        // exactly what React's onChange listens to — so the buffer cleanly
        // becomes ONLY the edit, arming the 800ms autosave debounce.
        const edited = `# Edited via UI ${stamp}\n\nThis line was typed in the browser.`;
        await soulTextarea.click();
        await soulTextarea.evaluate((el, val) => {
            const node = el as HTMLTextAreaElement;
            const setter = Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype,
                'value',
            )?.set;
            setter?.call(node, val);
            node.dispatchEvent(new Event('input', { bubbles: true }));
        }, edited);
        await expect
            .poll(async () => (await soulTextarea.inputValue()) ?? '', { timeout: 10_000 })
            .toBe(edited);

        // Autosave success stamps a ✓ on the SOUL.md pill (status 'saved'). The
        // pill is the tab button whose accessible name contains the file name.
        const soulPill = page.getByRole('button', { name: /SOUL\.md/ });
        await expect(soulPill).toContainText('✓', { timeout: 30_000 });

        // Authoritative cross-check: the API now returns the UI-entered body with
        // a fresh 64-hex hash.
        await expect
            .poll(async () => (await readFile(request, token, agent.id, 'SOUL.md')).body, {
                timeout: 30_000,
            })
            .toBe(edited);
        const afterSave = await readFile(request, token, agent.id, 'SOUL.md');
        expect(afterSave.hash).toMatch(HEX64);

        // Reload — the edit must survive (re-read from DB on SSR).
        await page.reload({ waitUntil: 'domcontentloaded' });
        const soulReloaded = page.getByRole('textbox', { name: 'SOUL.md' });
        await expect(soulReloaded).toBeVisible({ timeout: 30_000 });
        await expect
            .poll(async () => (await soulReloaded.inputValue()) ?? '', { timeout: 30_000 })
            .toContain(`Edited via UI ${stamp}`);

        // Final API cross-check after the reload — DB still holds the UI edit.
        const finalSoul = await readFile(request, token, agent.id, 'SOUL.md');
        expect(finalSoul.body).toBe(edited);
        expect(finalSoul.hash).toMatch(HEX64);

        // Independence sanity at the UI layer: switch to the AGENTS.md pill and
        // confirm its textarea is empty (the SOUL.md edit never touched it).
        await page.getByRole('button', { name: /AGENTS\.md/ }).click();
        const agentsTextarea = page.getByRole('textbox', { name: 'AGENTS.md' });
        await expect(agentsTextarea).toBeVisible({ timeout: 15_000 });
        await expect
            .poll(async () => (await agentsTextarea.inputValue()) ?? '', { timeout: 15_000 })
            .toBe('');
    });
});
