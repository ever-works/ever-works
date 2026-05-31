import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { createAgentViaAPI } from './helpers/agents-tasks';

/**
 * Agent instruction files (SOUL.md / AGENTS.md / …) — real edit + persist flow.
 *
 * User ask: "editing an Agent's canonical instruction files persists."
 *
 * The Agents/Skills/Tasks Phase-4 surface stores the five canonical files
 * (SOUL.md, AGENTS.md, HEARTBEAT.md, TOOLS.md, agent.yml) DB-inline for
 * tenant-scoped agents. Each PUT recomputes a single `contentHash` (sha256 of
 * the 5-file concatenation) returned as `newHash` and echoed as `hash` on the
 * next GET. This is fully deterministic — no LLM involved.
 *
 * Two layers are exercised:
 *   1. API contract. SOUL.md starts empty (body '', hash ''); PUT a body and
 *      GET back the exact body with hash === newHash; editing SOUL.md leaves
 *      AGENTS.md's *body* untouched (per-file independence — note the GET
 *      `hash` is the shared content-hash, so independence is asserted on body).
 *   2. UI editor. The Instructions tab (/agents/:id/instructions) renders a
 *      textarea per canonical file (aria-label = file name) with an 800ms
 *      autosave; we confirm the API-persisted SOUL.md body renders, edit it
 *      through the textarea, wait for the autosave "saved" indicator, reload,
 *      assert the new content survives the reload, and cross-check the API GET
 *      returns the same body.
 */

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status()).toBe(200);
    return (await res.json()).access_token;
}

interface AgentFile {
    name: string;
    body: string;
    hash: string;
    storage: 'git' | 'db';
}

async function readAgentFile(
    request: APIRequestContext,
    token: string,
    agentId: string,
    name: string,
): Promise<AgentFile> {
    const res = await request.get(`${API_BASE}/api/agents/${agentId}/files/${name}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `readFile ${name} body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

async function writeAgentFile(
    request: APIRequestContext,
    token: string,
    agentId: string,
    name: string,
    body: string,
    expectedHash?: string,
): Promise<{ newHash: string }> {
    const res = await request.put(`${API_BASE}/api/agents/${agentId}/files/${name}`, {
        headers: authedHeaders(token),
        data: expectedHash === undefined ? { body } : { body, expectedHash },
    });
    expect(res.status(), `writeFile ${name} body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

const HEX64 = /^[0-9a-f]{64}$/;

test.describe('Agent instruction files — edit + persist', () => {
    test('API: SOUL.md persists with a fresh content hash and is independent of AGENTS.md', async ({
        request,
    }) => {
        const token = await seededToken(request);
        const stamp = Date.now().toString(36);

        const agent = await createAgentViaAPI(request, token, {
            name: `Instruction Agent API ${stamp}`,
            scope: 'tenant',
        });
        expect(agent.scope).toBe('tenant');

        // 1. Both canonical files start empty (body '', hash '').
        const soul0 = await readAgentFile(request, token, agent.id, 'SOUL.md');
        expect(soul0.name).toBe('SOUL.md');
        expect(soul0.body).toBe('');
        expect(soul0.hash).toBe('');
        expect(soul0.storage).toBe('db');

        const agents0 = await readAgentFile(request, token, agent.id, 'AGENTS.md');
        expect(agents0.body).toBe('');
        expect(agents0.hash).toBe('');

        // 2. Write a SOUL.md body. The PUT returns a fresh 64-hex content hash.
        const soulBody = [
            `# Soul ${stamp}`,
            '',
            'You are a meticulous, friendly agent.',
            'Always cite your sources and keep answers concise.',
        ].join('\n');
        const { newHash } = await writeAgentFile(request, token, agent.id, 'SOUL.md', soulBody);
        expect(newHash, `newHash should be 64-hex, got "${newHash}"`).toMatch(HEX64);
        expect(newHash).not.toBe('');

        // 3. GET it back — exact body, hash matches the PUT's newHash.
        const soul1 = await readAgentFile(request, token, agent.id, 'SOUL.md');
        expect(soul1.body).toBe(soulBody);
        expect(soul1.hash).toBe(newHash);

        // 4. Independence: editing SOUL.md left AGENTS.md's body untouched.
        //    (The returned `hash` is the shared 5-file content hash, so it
        //    legitimately moves with any file edit — independence is on body.)
        const agents1 = await readAgentFile(request, token, agent.id, 'AGENTS.md');
        expect(agents1.body).toBe('');

        // 5. Now edit a DIFFERENT file and confirm SOUL.md's body is unchanged.
        const agentsBody = `# Operating manual ${stamp}\n\nFollow the playbook strictly.`;
        const after = await writeAgentFile(
            request,
            token,
            agent.id,
            'AGENTS.md',
            agentsBody,
            newHash,
        );
        expect(after.newHash).toMatch(HEX64);
        expect(after.newHash).not.toBe(newHash); // the shared hash advanced

        const soulStill = await readAgentFile(request, token, agent.id, 'SOUL.md');
        expect(soulStill.body).toBe(soulBody); // SOUL body survived the AGENTS edit
        const agentsNow = await readAgentFile(request, token, agent.id, 'AGENTS.md');
        expect(agentsNow.body).toBe(agentsBody);
    });

    test('UI: the Instructions editor renders, edits and persists SOUL.md across a reload', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const stamp = Date.now().toString(36);

        const agent = await createAgentViaAPI(request, token, {
            name: `Instruction Agent UI ${stamp}`,
            scope: 'tenant',
        });

        // Seed a known SOUL.md body via the API so the editor has something to
        // render on first load (and so we prove the UI reflects persisted state).
        const seeded = `# Seeded soul ${stamp}\noriginal first paragraph`;
        await writeAgentFile(request, token, agent.id, 'SOUL.md', seeded);

        // The Instructions tab lives at /agents/:id/instructions (routes are
        // unprefixed under next-intl localePrefix:'never').
        await page.goto(`/agents/${agent.id}/instructions`, { waitUntil: 'domcontentloaded' });

        // SOUL.md is the default active pill; its textarea carries aria-label
        // === the file name (AgentInstructionsEditor.tsx).
        const soulTextarea = page.getByRole('textbox', { name: 'SOUL.md' });
        await expect(soulTextarea).toBeVisible({ timeout: 30_000 });

        // The persisted body renders into the editor (dev hydration can lag, so
        // poll the value rather than asserting once).
        await expect
            .poll(async () => (await soulTextarea.inputValue()) ?? '', { timeout: 30_000 })
            .toContain(`Seeded soul ${stamp}`);

        // Edit through the UI. The editor is a CONTROLLED React textarea
        // (value={buffers[active]}), so Playwright fill()/keyboard fight React
        // re-asserting `value` and leave the seeded body concatenated/intact.
        // Set the value via the native setter + a dispatched `input` event —
        // exactly what React's onChange listens to — so the buffer cleanly
        // becomes ONLY the edit, arming the 800ms autosave.
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

        // Autosave confirms by stamping a ✓ on the SOUL.md pill (status 'saved').
        // The pill is the tab button containing the file name.
        const soulPill = page.getByRole('button', { name: /SOUL\.md/ });
        await expect(soulPill).toContainText('✓', { timeout: 30_000 });

        // Cross-check: the API now returns the UI-entered body.
        await expect
            .poll(async () => (await readAgentFile(request, token, agent.id, 'SOUL.md')).body, {
                timeout: 30_000,
            })
            .toBe(edited);

        // Reload the page — the edit must survive (read back from the DB on SSR).
        await page.reload({ waitUntil: 'domcontentloaded' });
        const soulTextareaReloaded = page.getByRole('textbox', { name: 'SOUL.md' });
        await expect(soulTextareaReloaded).toBeVisible({ timeout: 30_000 });
        await expect
            .poll(async () => (await soulTextareaReloaded.inputValue()) ?? '', { timeout: 30_000 })
            .toContain(`Edited via UI ${stamp}`);

        // Final authoritative cross-check against the API.
        const finalSoul = await readAgentFile(request, token, agent.id, 'SOUL.md');
        expect(finalSoul.body).toBe(edited);
        expect(finalSoul.hash).toMatch(HEX64);
    });
});
