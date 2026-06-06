import { test, expect, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
    API_BASE,
    authedHeaders,
    createWorkViaAPI,
    registerUserViaAPI,
} from './helpers/api';
import { seedOrgKbDoc, setWorkOrganizationId } from './helpers/kb-fixtures';

/**
 * EW-643 Phase 3 slice 5 — A33/A34/A35 acceptance e2e for the KB
 * org→Work inheritance surface (the inheritable-doc resolution path
 * already proved in `flow-kb-inherited-overrides.spec.ts`, extended
 * here with the LOCK interaction).
 *
 *   A33 — An org-scope doc is visible to a Work paired with that org
 *         via the `GET /api/works/:id/kb/inheritable` resolution.
 *   A34 — A Work-scope override at the same path hides the org-scope
 *         sibling from the inherited set (merged via path collision).
 *   A35 — Once an inherited doc has been overridden into Work scope
 *         AND the override is full-locked, edits on the now-Work-owned
 *         row are rejected (proves the org→Work clone surface inherits
 *         the same lock semantics as native Work docs).
 *
 * Realistic test data: every scenario mints a fresh user, fresh Work,
 * and a unique-UUID "organization" via `seedOrgKbDoc` (the org-KB
 * controller does not enforce org membership today, per its docstring
 * — see kb-fixtures comment block). Run-id suffixed paths/slugs keep
 * parallel shards isolated.
 *
 * Skip-gates: none — pure REST, no ffmpeg/Whisper/external-storage
 * dependency.
 */

interface InheritableDoc {
    id: string;
    workId: string | null;
    organizationId: string | null;
    path: string;
    slug: string;
    title: string;
    class: string;
    locked?: boolean;
    lockMode?: string | null;
}

const LOCK_FULL = 'full';
const LOCKED_STATUSES = [403, 423] as const;

function runId(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function resolveInheritable(
    request: APIRequestContext,
    token: string,
    workId: string,
    orgId: string,
): Promise<InheritableDoc[]> {
    const res = await request.get(
        `${API_BASE}/api/works/${workId}/kb/inheritable?orgId=${encodeURIComponent(orgId)}`,
        { headers: authedHeaders(token) },
    );
    expect(res.ok(), `GET inheritable → 200 (got ${res.status()})`).toBeTruthy();
    return (await res.json()) as InheritableDoc[];
}

async function createWorkKbDoc(
    request: APIRequestContext,
    token: string,
    workId: string,
    doc: { path: string; title: string; body: string; class?: string },
): Promise<InheritableDoc> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/kb/documents`, {
        headers: { ...authedHeaders(token), 'content-type': 'application/json' },
        data: {
            path: doc.path,
            title: doc.title,
            class: doc.class ?? 'legal',
            body: doc.body,
        },
    });
    expect(res.ok(), `POST Work-scope KB doc → 201 (got ${res.status()})`).toBeTruthy();
    return (await res.json()) as InheritableDoc;
}

async function lockDoc(
    request: APIRequestContext,
    token: string,
    workId: string,
    docId: string,
    mode: string,
): Promise<number> {
    const res = await request.post(
        `${API_BASE}/api/works/${workId}/kb/documents/${docId}/lock`,
        {
            headers: { ...authedHeaders(token), 'content-type': 'application/json' },
            data: { mode },
        },
    );
    return res.status();
}

async function patchDoc(
    request: APIRequestContext,
    token: string,
    workId: string,
    docId: string,
    data: Record<string, unknown>,
): Promise<number> {
    const res = await request.patch(
        `${API_BASE}/api/works/${workId}/kb/documents/${docId}`,
        {
            headers: { ...authedHeaders(token), 'content-type': 'application/json' },
            data,
        },
    );
    return res.status();
}

test.describe('flow: KB org→Work inheritance acceptance (A33/A34/A35)', () => {
    test('A33 — org-scope doc is visible to a paired Work via inheritance', async ({ request }) => {
        test.setTimeout(120_000);
        const id = runId();
        const owner = await registerUserViaAPI(request, { name: `Inh A33 ${id}` });
        const orgId = randomUUID();
        const { id: workId } = await createWorkViaAPI(request, owner.access_token, {
            name: `KB A33 ${id}`,
        });

        const orgPath = `legal/policy-${id}.md`;
        await seedOrgKbDoc(request, owner.access_token, {
            orgId,
            path: orgPath,
            title: `Policy ${id}`,
            targetClass: 'legal',
            body: `# Policy ${id}\n\norg-level policy inherited by paired Works\n`,
        });

        // Before pairing, the org doc is not visible to the Work.
        const beforePair = await resolveInheritable(request, owner.access_token, workId, orgId);
        // Without a pairing, the inheritable endpoint still trusts the orgId
        // query and returns the org doc — but the kb page server component
        // never calls it without a paired Work.organizationId. Pin pairing
        // explicitly so the assertion below isn't dependent on that quirk.
        await setWorkOrganizationId(request, owner.access_token, workId, orgId);
        const afterPair = await resolveInheritable(request, owner.access_token, workId, orgId);

        const orgScoped = afterPair.filter((d) => d.workId === null).map((d) => d.path);
        expect(orgScoped, 'paired Work sees the org doc as inherited').toContain(orgPath);

        // beforePair is sanity — also surfaces it (trust-the-query-param
        // behaviour) so flipping that contract is caught by the spec rather
        // than going silent.
        expect(beforePair.some((d) => d.path === orgPath)).toBeTruthy();
    });

    test('A34 — Work-scope override at same path hides the org-scope sibling', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const id = runId();
        const owner = await registerUserViaAPI(request, { name: `Inh A34 ${id}` });
        const orgId = randomUUID();
        const { id: workId } = await createWorkViaAPI(request, owner.access_token, {
            name: `KB A34 ${id}`,
        });

        // Seed two inheritable org docs at distinct paths — one will be
        // overridden, one will remain inherited as the control.
        const overridePath = `legal/override-${id}.md`;
        const siblingPath = `legal/sibling-${id}.md`;
        await seedOrgKbDoc(request, owner.access_token, {
            orgId,
            path: overridePath,
            title: `Override Source ${id}`,
            targetClass: 'legal',
            body: `# Override Source ${id}\n\nwill be masked by Work override\n`,
        });
        await seedOrgKbDoc(request, owner.access_token, {
            orgId,
            path: siblingPath,
            title: `Sibling ${id}`,
            targetClass: 'legal',
            body: `# Sibling ${id}\n\nstays inherited\n`,
        });
        await setWorkOrganizationId(request, owner.access_token, workId, orgId);

        // Pre-override: both docs resolve as org-scoped.
        const before = await resolveInheritable(request, owner.access_token, workId, orgId);
        const beforeOrgScoped = before.filter((d) => d.workId === null).map((d) => d.path);
        expect(beforeOrgScoped).toContain(overridePath);
        expect(beforeOrgScoped).toContain(siblingPath);

        // Create the Work-scope override at the SAME path.
        await createWorkKbDoc(request, owner.access_token, workId, {
            path: overridePath,
            title: `Override ${id}`,
            body: `# Override ${id}\n\nWork-scope override\n`,
        });

        // Post-override: the override path comes back as Work-owned, the
        // sibling stays org-scoped — proving path-collision masking.
        const after = await resolveInheritable(request, owner.access_token, workId, orgId);
        const overrideEntry = after.find((d) => d.path === overridePath);
        const siblingEntry = after.find((d) => d.path === siblingPath);
        expect(overrideEntry?.workId, 'overridden path is now Work-owned').toBe(workId);
        expect(siblingEntry?.workId, 'sibling stays org-scoped').toBeNull();

        // The genuinely-inherited (workId === null) set excludes the
        // overridden path.
        expect(after.filter((d) => d.workId === null).map((d) => d.path)).toEqual([siblingPath]);
    });

    test('A35 — locked Work-scope override of an inherited doc rejects edits', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const id = runId();
        const owner = await registerUserViaAPI(request, { name: `Inh A35 ${id}` });
        const orgId = randomUUID();
        const { id: workId } = await createWorkViaAPI(request, owner.access_token, {
            name: `KB A35 ${id}`,
        });

        const overridePath = `legal/locked-override-${id}.md`;
        await seedOrgKbDoc(request, owner.access_token, {
            orgId,
            path: overridePath,
            title: `Locked Override Source ${id}`,
            targetClass: 'legal',
            body: `# Locked Override Source ${id}\n\norg-level body\n`,
        });
        await setWorkOrganizationId(request, owner.access_token, workId, orgId);

        // Create the Work-scope override (clone) — the same path the
        // org doc occupies.
        const override = await createWorkKbDoc(request, owner.access_token, workId, {
            path: overridePath,
            title: `Locked Override ${id}`,
            body: `# Locked Override ${id}\n\nWork override body\n`,
        });
        expect(override.workId).toBe(workId);

        // Sanity: PATCH on the unlocked override succeeds.
        const baseline = await patchDoc(request, owner.access_token, workId, override.id, {
            description: 'baseline unlocked edit',
        });
        expect(baseline, 'unlocked override accepts PATCH').toBe(200);

        // Full-lock the override.
        const lockStatus = await lockDoc(
            request,
            owner.access_token,
            workId,
            override.id,
            LOCK_FULL,
        );
        expect(lockStatus, 'full lock on override → 200').toBe(200);

        // Edits on the locked override are rejected with the lock status.
        const blocked = await patchDoc(request, owner.access_token, workId, override.id, {
            body: 'must not apply on locked override',
        });
        expect(
            LOCKED_STATUSES.includes(blocked as 403 | 423),
            `locked override PATCH must be 423/403, got ${blocked}`,
        ).toBeTruthy();
    });
});
