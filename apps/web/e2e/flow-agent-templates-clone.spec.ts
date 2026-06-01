import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, type RegisteredUser } from './helpers/api';
import { createAgentViaAPI } from './helpers/agents-tasks';

/**
 * Agent-template catalog + clone-an-Agent (export → import round-trip).
 *
 * Probed live against the e2e stack (sqlite in-memory, no GitHub token, no
 * Trigger.dev secret). Sources of truth read for this spec:
 *   - apps/api/src/agents/agent-templates.controller.ts
 *   - apps/api/src/agents/agent-template-catalog.service.ts
 *   - apps/api/src/agents/agents.controller.ts  (export/import + files)
 *   - packages/agent/src/agents/agent-export.service.ts (the clone engine)
 *   - packages/agent/src/agents/types.ts (AgentDto)
 *   - packages/agent/src/entities/agent.entity.ts (enums + AGENT_PERMISSIONS_DEFAULT)
 *
 * CATALOG — `GET /api/agent-templates?entity=agent|skill|task`
 *   - `@Public()` → 200 even unauthenticated; never 4xx/5xx for a cold catalog.
 *   - Returns `AstTemplateEntry[]` { slug, title, description, category?, iconName?, tags? }.
 *   - Backed by the private `ever-works/agents` repo manifest. In CI there is NO
 *     GitHub token, so the service returns `[]` (verified: agent + skill both []).
 *     `entity=skill|task` ALWAYS returns [] (only `agent` is repo-backed). Any
 *     unrecognized `entity` normalizes to `agent`.
 *
 * CLONE — there is NO dedicated `POST /api/agents/:id/clone` (unlike Missions).
 * Cloning an Agent IS the per-Agent export → import envelope round-trip:
 *   - GET  /api/agents/:id/export  → 200 AgentExportEnvelope (version:1) carrying
 *       identity{name,slug,title,capabilities,scope}, model{aiProviderId,modelId,
 *       maxSkillContextTokens}, runtime{permissions,targets,heartbeatCadence,
 *       idleBehavior,pauseAfterFailures}, avatar{mode,icon,imageUploadId},
 *       files{soulMd,agentsMd,heartbeatMd,toolsMd,agentYml}, skillBindings[]
 *       (always [] — Phase 9), budget[] (from AgentBudgetRepository; [] when none).
 *       Cross-user export → 404 (no existence leak). Unauth → 401.
 *   - POST /api/agents/import[?onConflict=skip|overwrite|rename][&scope&missionId
 *       &ideaId&workId] → 201 { created:AgentDto, conflictResolution, originalSlug,
 *       finalSlug }. Default conflict mode is RENAME (slug → "-2", "-3"; name gets
 *       " (imported)" suffix). skip on a clash → 409. overwrite mutates the existing
 *       row in place (resolution:"overwritten", finalSlug==originalSlug).
 *   - The clone ALWAYS lands in status DRAFT regardless of the source's status
 *       (export carries no status; import forces `AgentStatus.DRAFT`).
 *   - Clone copies files (soulMd etc.) + permissions + avatar(icon) + runtime
 *       knobs. `canOpenPullRequests` implies `canCommitToRepo` on import.
 *   - Cross-tenant IMAGE avatar with imageUploadId:null degrades to INITIALS on
 *       import (no dangling upload reference). Verified live.
 *   - Envelope guards: version!==1 → 400 "Unsupported envelope version"; missing
 *       identity.name → 400 "Envelope identity.name is required.".
 *   - Scope-override import (e.g. scope=mission) WITHOUT the matching id → 400.
 *
 * Enum values (agent.entity.ts): scope tenant|mission|idea|work; status draft|
 * active|running|paused|error|archived; avatarMode initials|icon|image;
 * idleBehavior propose|noop|observe. AGENT_PERMISSIONS_DEFAULT = all 8 flags false.
 *
 * Cross-spec isolation: every flow runs on its OWN freshly registered user (never
 * the shared seeded user — agent mutations must not bleed into sibling specs).
 * Names carry a Date.now()+rand suffix; assertions use toContain / .or() and never
 * assert exact global counts.
 */

interface AgentExportEnvelope {
    version: number;
    meta: { exportedAt: string; sourceAgentId: string; sourceUserId: string; appVersion?: string };
    identity: {
        name: string;
        slug: string;
        title: string | null;
        capabilities: string | null;
        scope: string;
    };
    model: { aiProviderId: string | null; modelId: string | null; maxSkillContextTokens: number };
    runtime: {
        permissions: Record<string, boolean>;
        targets: Array<{ type: string; id?: string }> | null;
        heartbeatCadence: string | null;
        idleBehavior: string;
        pauseAfterFailures: number;
    };
    avatar: { mode: string; icon: string | null; imageUploadId: string | null };
    files: {
        soulMd: string | null;
        agentsMd: string | null;
        heartbeatMd: string | null;
        toolsMd: string | null;
        agentYml: string | null;
    };
    skillBindings: unknown[];
    budget: unknown[];
}

interface AgentDto {
    id: string;
    name: string;
    slug: string;
    scope: string;
    status: string;
    title: string | null;
    capabilities: string | null;
    maxSkillContextTokens: number;
    permissions: Record<string, boolean>;
    heartbeatCadence: string | null;
    idleBehavior: string;
    pauseAfterFailures: number;
    avatarMode: string;
    avatarIcon: string | null;
    avatarImageUploadId: string | null;
    hasInlineFiles: boolean;
}

interface ImportResult {
    created: AgentDto;
    conflictResolution: 'none' | 'skipped' | 'overwritten' | 'renamed';
    originalSlug: string;
    finalSlug: string;
}

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function freshToken(
    request: APIRequestContext,
): Promise<{ user: RegisteredUser; token: string }> {
    const user = await registerUserViaAPI(request);
    return { user, token: user.access_token };
}

/** Read one Agent definition file body via the canonical files endpoint. */
async function writeAgentFile(
    request: APIRequestContext,
    token: string,
    agentId: string,
    name: string,
    body: string,
): Promise<void> {
    const res = await request.put(`${API_BASE}/api/agents/${agentId}/files/${name}`, {
        headers: authedHeaders(token),
        data: { body },
    });
    expect(res.status(), `writeFile ${name} body=${await res.text().catch(() => '')}`).toBe(200);
}

async function exportAgent(
    request: APIRequestContext,
    token: string,
    agentId: string,
): Promise<AgentExportEnvelope> {
    const res = await request.get(`${API_BASE}/api/agents/${agentId}/export`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `export body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

async function importEnvelope(
    request: APIRequestContext,
    token: string,
    envelope: AgentExportEnvelope,
    query = '',
): Promise<{ status: number; body: ImportResult | { message?: string } }> {
    const res = await request.post(`${API_BASE}/api/agents/import${query}`, {
        headers: authedHeaders(token),
        data: envelope,
    });
    return { status: res.status(), body: await res.json().catch(() => ({})) };
}

test.describe('Agent template catalog — public, environment-adaptive', () => {
    /**
     * The catalog is a `@Public()` route backed by a private GitHub repo. In CI
     * there is no token, so the contract is "empty array, never an error" and the
     * web layer falls back to its built-in chips. This flow exercises the full
     * surface: anonymous read, all three entity types, entity normalization, and
     * the shape contract — adaptively (asserts entries' shape ONLY when populated).
     */
    test('catalog is publicly readable for every entity type and never errors cold', async ({
        request,
    }) => {
        // Anonymous (no Authorization header) — @Public route must still 200.
        const anon = await request.get(`${API_BASE}/api/agent-templates?entity=agent`);
        expect(anon.status()).toBe(200);
        const anonList = await anon.json();
        expect(Array.isArray(anonList)).toBe(true);

        // skill + task are never repo-backed → always [].
        for (const entity of ['skill', 'task']) {
            const res = await request.get(`${API_BASE}/api/agent-templates?entity=${entity}`);
            expect(res.status()).toBe(200);
            const list = await res.json();
            expect(Array.isArray(list)).toBe(true);
            expect(list.length).toBe(0);
        }

        // Unknown entity normalizes to 'agent' (controller coerces anything that
        // isn't skill|task) — so it returns the same array as ?entity=agent.
        const bogus = await request.get(`${API_BASE}/api/agent-templates?entity=banana`);
        expect(bogus.status()).toBe(200);
        const bogusList = await bogus.json();
        const agentRes = await request.get(`${API_BASE}/api/agent-templates?entity=agent`);
        const agentList = await agentRes.json();
        expect(bogusList.length).toBe(agentList.length);

        // No-query default also normalizes to agent and 200s.
        const noQuery = await request.get(`${API_BASE}/api/agent-templates`);
        expect(noQuery.status()).toBe(200);
        expect(Array.isArray(await noQuery.json())).toBe(true);

        // Shape contract — assert ONLY if the catalog is populated (token present
        // in some non-CI env). In CI agentList is [] and this branch is skipped.
        if (agentList.length > 0) {
            for (const entry of agentList) {
                expect(typeof entry.slug).toBe('string');
                expect(entry.slug.length).toBeGreaterThan(0);
                expect(typeof entry.title).toBe('string');
                expect(typeof entry.description).toBe('string');
                if (entry.tags !== undefined) expect(Array.isArray(entry.tags)).toBe(true);
            }
        } else {
            test.info().annotations.push({
                type: 'note',
                description:
                    'agent-template catalog is empty (no GitHub token in CI) — repo-backed entry shape not asserted; this is the expected fallback contract.',
            });
        }
    });
});

test.describe('Clone an Agent — export → import copies files/permissions/avatar', () => {
    /**
     * The canonical "clone" path. Build a richly-configured source Agent (icon
     * avatar, granted permissions, custom runtime knobs, two inline definition
     * files), export the envelope, import it back, and assert the resulting clone
     * is a faithful DRAFT copy with a uniquely-renamed slug — proving files +
     * permissions + avatar + runtime knobs all round-trip.
     */
    test('full clone faithfully copies files, permissions, avatar and runtime knobs into a DRAFT', async ({
        request,
    }) => {
        const { token } = await freshToken(request);
        const name = `CloneSrc ${uniq()}`;

        const created = await request.post(`${API_BASE}/api/agents`, {
            headers: authedHeaders(token),
            data: {
                scope: 'tenant',
                name,
                title: 'Lead Content Strategist',
                capabilities: 'drafts long-form articles and outlines',
                avatarMode: 'icon',
                avatarIcon: 'bot',
                heartbeatCadence: 'manual',
                idleBehavior: 'observe',
                pauseAfterFailures: 7,
                maxSkillContextTokens: 8000,
                permissions: { canSpend: true, canCommitToRepo: true, canEditSkills: true },
            },
        });
        expect(created.status(), `create body=${await created.text().catch(() => '')}`).toBe(201);
        const source: AgentDto = await created.json();
        expect(source.status).toBe('draft');

        // Two inline files so the clone has real bodies to round-trip.
        await writeAgentFile(
            request,
            token,
            source.id,
            'SOUL.md',
            '# Soul\nBe concise and rigorous.',
        );
        await writeAgentFile(
            request,
            token,
            source.id,
            'AGENTS.md',
            '# Playbook\nAlways cite sources.',
        );

        const envelope = await exportAgent(request, token, source.id);
        expect(envelope.version).toBe(1);
        expect(envelope.meta.sourceAgentId).toBe(source.id);
        expect(envelope.identity.name).toBe(name);
        expect(envelope.files.soulMd).toContain('Be concise');
        expect(envelope.files.agentsMd).toContain('cite sources');
        expect(envelope.avatar).toMatchObject({ mode: 'icon', icon: 'bot' });
        expect(envelope.runtime.permissions.canSpend).toBe(true);
        expect(envelope.skillBindings).toEqual([]);
        expect(Array.isArray(envelope.budget)).toBe(true);

        // Clone = import the envelope. No conflict yet? There IS one (same user,
        // same slug) → default RENAME kicks in.
        const imported = await importEnvelope(request, token, envelope);
        expect(imported.status).toBe(201);
        const result = imported.body as ImportResult;
        expect(result.conflictResolution).toBe('renamed');
        expect(result.originalSlug).toBe(source.slug);
        expect(result.finalSlug).toBe(`${source.slug}-2`);

        const clone = result.created;
        // Clone is a DRAFT regardless of source status; name carries " (imported)".
        expect(clone.status).toBe('draft');
        expect(clone.name).toBe(`${name} (imported)`);
        expect(clone.id).not.toBe(source.id);
        // Faithful copies:
        expect(clone.title).toBe('Lead Content Strategist');
        expect(clone.capabilities).toBe(source.capabilities);
        expect(clone.maxSkillContextTokens).toBe(8000);
        expect(clone.heartbeatCadence).toBe('manual');
        expect(clone.idleBehavior).toBe('observe');
        expect(clone.pauseAfterFailures).toBe(7);
        expect(clone.avatarMode).toBe('icon');
        expect(clone.avatarIcon).toBe('bot');
        expect(clone.permissions.canSpend).toBe(true);
        expect(clone.permissions.canCommitToRepo).toBe(true);
        expect(clone.permissions.canEditSkills).toBe(true);
        expect(clone.hasInlineFiles).toBe(true);

        // The clone's files endpoint serves the copied bodies.
        const soul = await request.get(`${API_BASE}/api/agents/${clone.id}/files/SOUL.md`, {
            headers: authedHeaders(token),
        });
        expect(soul.status()).toBe(200);
        expect((await soul.json()).body).toContain('Be concise');
    });

    /**
     * Repeated cloning yields monotonically-suffixed slugs (-2, -3, …) and each
     * clone is independent — editing the source after cloning must NOT mutate the
     * earlier clones. Proves the rename ladder + copy-on-clone independence.
     */
    test('repeated clone produces -2/-3 slug ladder and clones are independent of the source', async ({
        request,
    }) => {
        const { token } = await freshToken(request);
        const source = await createAgentViaAPI(request, token, {
            name: `Ladder ${uniq()}`,
            scope: 'tenant',
        });
        await writeAgentFile(request, token, source.id, 'TOOLS.md', '# Tools v1');
        const envelope = await exportAgent(request, token, source.id);

        const slugs: string[] = [];
        for (let i = 0; i < 3; i++) {
            const r = await importEnvelope(request, token, envelope);
            expect(r.status).toBe(201);
            slugs.push((r.body as ImportResult).finalSlug);
        }
        expect(slugs).toEqual([`${source.slug}-2`, `${source.slug}-3`, `${source.slug}-4`]);

        // Mutate the SOURCE after cloning. The first clone must keep its v1 file.
        const firstCloneList = await request.get(
            `${API_BASE}/api/agents?search=${encodeURIComponent('Ladder')}&limit=50`,
            { headers: authedHeaders(token) },
        );
        expect(firstCloneList.status()).toBe(200);
        const rows: AgentDto[] = (await firstCloneList.json()).data;
        const firstClone = rows.find((a) => a.slug === `${source.slug}-2`);
        expect(firstClone, 'first clone should be listable').toBeTruthy();

        await writeAgentFile(request, token, source.id, 'TOOLS.md', '# Tools v2 EDITED');
        const cloneTools = await request.get(
            `${API_BASE}/api/agents/${firstClone!.id}/files/TOOLS.md`,
            { headers: authedHeaders(token) },
        );
        expect(cloneTools.status()).toBe(200);
        expect((await cloneTools.json()).body).toBe('# Tools v1');
    });
});

test.describe('Clone conflict modes — rename vs skip vs overwrite', () => {
    /**
     * The three import conflict modes against an existing slug, exercised end to
     * end on one user: rename (default, new row), skip (409, no row), overwrite
     * (mutates the existing row in place, no new row, file body refreshed).
     */
    test('rename adds, skip 409s, overwrite mutates the existing Agent in place', async ({
        request,
    }) => {
        const { token } = await freshToken(request);
        const source = await createAgentViaAPI(request, token, {
            name: `Conflict ${uniq()}`,
            scope: 'tenant',
        });
        await writeAgentFile(request, token, source.id, 'SOUL.md', 'original soul');
        const envelope = await exportAgent(request, token, source.id);

        // rename (default) — creates a NEW row at -2.
        const renamed = await importEnvelope(request, token, envelope);
        expect(renamed.status).toBe(201);
        expect((renamed.body as ImportResult).conflictResolution).toBe('renamed');
        expect((renamed.body as ImportResult).finalSlug).toBe(`${source.slug}-2`);

        // skip — the original slug still clashes → 409 ConflictException, no row.
        const skipped = await importEnvelope(request, token, envelope, '?onConflict=skip');
        expect(skipped.status).toBe(409);

        // overwrite — mutate the EXISTING source row in place; refresh its file.
        const mutated: AgentExportEnvelope = {
            ...envelope,
            files: { ...envelope.files, soulMd: 'OVERWRITTEN soul body' },
            identity: { ...envelope.identity, title: 'Overwritten Title' },
        };
        const overwritten = await importEnvelope(request, token, mutated, '?onConflict=overwrite');
        expect(overwritten.status).toBe(201);
        const owResult = overwritten.body as ImportResult;
        expect(owResult.conflictResolution).toBe('overwritten');
        expect(owResult.finalSlug).toBe(source.slug);
        expect(owResult.created.id).toBe(source.id); // same row, not a new one
        expect(owResult.created.title).toBe('Overwritten Title');

        // The source's SOUL.md now reflects the overwrite.
        const soul = await request.get(`${API_BASE}/api/agents/${source.id}/files/SOUL.md`, {
            headers: authedHeaders(token),
        });
        expect(soul.status()).toBe(200);
        expect((await soul.json()).body).toBe('OVERWRITTEN soul body');
    });
});

test.describe('Clone avatar handling — image fallback to initials', () => {
    /**
     * Avatar mode round-trips on a same-tenant clone (icon stays icon). But an
     * envelope describing an IMAGE avatar whose upload is not resolvable by the
     * importing user (imageUploadId:null — the cross-tenant case) degrades to
     * INITIALS so the import never dangles on a missing upload.
     */
    test('icon avatar round-trips; an unresolved image avatar degrades to initials', async ({
        request,
    }) => {
        const { token } = await freshToken(request);
        const source = await createAgentViaAPI(request, token, {
            name: `Avatar ${uniq()}`,
            scope: 'tenant',
        });
        // Set the source to an icon avatar via PATCH.
        const patch = await request.patch(`${API_BASE}/api/agents/${source.id}`, {
            headers: authedHeaders(token),
            data: { avatarMode: 'icon', avatarIcon: 'sparkles' },
        });
        expect(patch.status()).toBe(200);

        const envelope = await exportAgent(request, token, source.id);
        expect(envelope.avatar).toMatchObject({ mode: 'icon', icon: 'sparkles' });

        // Same-tenant clone keeps the icon avatar.
        const iconClone = await importEnvelope(request, token, envelope);
        expect(iconClone.status).toBe(201);
        expect((iconClone.body as ImportResult).created.avatarMode).toBe('icon');
        expect((iconClone.body as ImportResult).created.avatarIcon).toBe('sparkles');

        // Simulate a cross-tenant image-avatar envelope (upload not visible →
        // imageUploadId null). The import must coerce to INITIALS, dropping the
        // icon too. Rename to a distinct name to avoid a fresh conflict ladder.
        const imageEnvelope: AgentExportEnvelope = {
            ...envelope,
            identity: { ...envelope.identity, name: `Avatar Image ${uniq()}` },
            avatar: { mode: 'image', icon: null, imageUploadId: null },
        };
        const imgClone = await importEnvelope(request, token, imageEnvelope);
        expect(imgClone.status).toBe(201);
        const imgResult = imgClone.body as ImportResult;
        expect(imgResult.created.avatarMode).toBe('initials');
        expect(imgResult.created.avatarImageUploadId).toBeNull();
        expect(imgResult.created.avatarIcon).toBeNull();
    });
});

test.describe('Clone isolation + envelope validation guards', () => {
    /**
     * Cross-user isolation + the export/import error contract: a stranger cannot
     * export another user's Agent (404, no existence leak), unauth export is 401,
     * and malformed envelopes are rejected with the documented 400 messages.
     * Finally, a stranger CAN legitimately clone an Agent they author from an
     * envelope handed to them (the envelope is the sharable artifact) and it lands
     * in THEIR account at the ORIGINAL (un-suffixed) slug — no cross-user clash.
     */
    test('stranger export 404s, unauth 401s, bad envelopes 400, and a handed-off envelope clones cleanly', async ({
        request,
    }) => {
        const owner = await freshToken(request);
        const stranger = await freshToken(request);

        const source = await createAgentViaAPI(request, owner.token, {
            name: `Owned ${uniq()}`,
            scope: 'tenant',
        });
        await writeAgentFile(request, owner.token, source.id, 'SOUL.md', 'owner private soul');

        // Stranger cannot read the owner's Agent export (404, not 403 — no leak).
        const strangerExport = await request.get(`${API_BASE}/api/agents/${source.id}/export`, {
            headers: authedHeaders(stranger.token),
        });
        expect(strangerExport.status()).toBe(404);

        // Unauthenticated export → 401.
        const unauthExport = await request.get(`${API_BASE}/api/agents/${source.id}/export`);
        expect(unauthExport.status()).toBe(401);

        const envelope = await exportAgent(request, owner.token, source.id);

        // Bad version → 400 with the documented message.
        const badVersion = await importEnvelope(request, owner.token, {
            ...envelope,
            version: 2,
        });
        expect(badVersion.status).toBe(400);
        expect((badVersion.body as { message?: string }).message ?? '').toContain(
            'Unsupported envelope version',
        );

        // Missing identity.name → 400.
        const noName = await request.post(`${API_BASE}/api/agents/import`, {
            headers: authedHeaders(owner.token),
            data: { version: 1, identity: { scope: 'tenant' }, files: {} },
        });
        expect(noName.status()).toBe(400);
        expect((await noName.json()).message ?? '').toContain('identity.name is required');

        // Scope-override to mission WITHOUT a missionId → 400 (scope ownership check).
        const badScope = await importEnvelope(request, owner.token, envelope, '?scope=mission');
        expect(badScope.status).toBe(400);

        // The envelope is the sharable artifact: the STRANGER imports it into their
        // OWN account. No slug clash there → original (un-suffixed) slug, no rename.
        const strangerClone = await importEnvelope(request, stranger.token, envelope);
        expect(strangerClone.status).toBe(201);
        const sc = strangerClone.body as ImportResult;
        expect(sc.conflictResolution).toBe('none');
        expect(sc.finalSlug).toBe(envelope.identity.slug);
        expect(sc.created.status).toBe('draft');
        expect(sc.created.name).toBe(envelope.identity.name); // no " (imported)" — clean slug

        // The stranger's clone carries the owner's file body (the envelope's payload).
        const strangerSoul = await request.get(
            `${API_BASE}/api/agents/${sc.created.id}/files/SOUL.md`,
            { headers: authedHeaders(stranger.token) },
        );
        expect(strangerSoul.status()).toBe(200);
        expect((await strangerSoul.json()).body).toBe('owner private soul');
    });
});
