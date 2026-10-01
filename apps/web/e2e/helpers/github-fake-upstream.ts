/**
 * Seeding APW-09's own state through the fake GitHub (T45's `_control` extension).
 *
 * ## Why this module exists
 *
 * APW-09's PR lane needs a starting point the platform cannot reach by clicking:
 * an `upstream_pull_requests` row that is already `awaiting_approval` with the
 * approval proposal that matches it. ACC-NEG-06's non-author case is *about* that
 * state — "only the author may decide" has nothing to assert without a proposal
 * already in the queue. The fake GitHub's `POST /_control/seed` therefore takes
 * two APW-09 keys, and this helper is the typed door a spec uses.
 *
 * ## The trap it exists to close
 *
 * Those two keys are **armed only while `EVER_WORKS_E2E_FAKES === '1'` in a
 * non-production process** (`fakes/github-fake/state.mjs`'s `upstreamSeedGate`),
 * and the switch is read in the **fake's own process** when the seed arrives —
 * not in the spec's. So a lane that starts the fake with plain
 * `node …/server.mjs` gets a fake that serves every GitHub route and **silently
 * drops the upstream seed**; the spec then fails somewhere downstream, for a
 * reason that has nothing to do with what it meant to test. An unarmed seed
 * answers `200` with `seeded.upstreamSeed.applied === false`, so nothing about
 * the HTTP status tells a caller. {@link seedUpstreamState} **reads that field**
 * and refuses the lane by name — the same posture
 * {@link import('./github-fake-control').armAuthRefusedForToken} takes for a
 * one-shot fault.
 *
 * ## What it proves, not just does
 *
 * {@link seedUpstreamState} posts the seed, requires `applied: true`, then
 * **re-reads `/_control/state`** and returns the row and its proposal as the fake
 * stored them — so a case asserts against what landed rather than against what it
 * sent. {@link upstreamRowFor} is the small lookup a case uses to check the pair
 * is linked.
 */

import { type APIRequestContext } from '@playwright/test';

/** One seeded row of `upstream_pull_requests`, as APW-09 plan §3.1 names its columns. */
export interface FakeUpstreamPullRequestRow {
    id: string;
    userId: string | null;
    workId: string;
    sourceTaskId: string;
    upstreamOwner: string;
    upstreamRepo: string;
    baseBranch: string;
    headOwner: string | null;
    headRepo: string | null;
    headBranch: string;
    headSha: string | null;
    upstreamBaseSha: string | null;
    state: string;
    number: number | null;
    url: string | null;
    title: string | null;
    approvalProposalId: string | null;
    createdAt: string;
}

/** One seeded approval proposal (an `agent_action_proposals` row, APW-09 plan §6). */
export interface FakeUpstreamApprovalProposal {
    id: string;
    userId: string | null;
    agentId: string | null;
    actionType: string;
    title: string | null;
    subjectKey: string | null;
    riskFlags: string[];
    status: string;
    payload: {
        workId?: string;
        sourceTaskId?: string;
        upstreamPullRequestId?: string;
        [key: string]: unknown;
    };
    createdAt: string;
}

/** What the fake reports about the upstream half of a seed. */
export interface FakeUpstreamSeedSummary {
    applied: boolean;
    reason: 'armed' | 'switch-off' | 'production' | 'not-requested' | 'orphan-proposal';
    rows: number;
    proposals: number;
    linked: number;
    error?: string;
}

/** The seed half of a payload, in the fake's own key spelling. */
export interface FakeUpstreamSeedInput {
    upstream_pull_requests?: Array<
        Partial<FakeUpstreamPullRequestRow> & {
            id: string;
            workId: string;
            sourceTaskId: string;
            upstreamOwner: string;
            upstreamRepo: string;
            headBranch: string;
        }
    >;
    upstream_approval_proposals?: Array<Partial<FakeUpstreamApprovalProposal> & { id: string }>;
}

/** The seeded pair, as `/_control/state` reports it back. */
export interface FakeUpstreamSeed {
    summary: FakeUpstreamSeedSummary;
    rows: FakeUpstreamPullRequestRow[];
    proposals: FakeUpstreamApprovalProposal[];
}

/** The switch the fake's upstream seed is armed by — the same name the plugin reads. */
export const FAKES_SWITCH_ENV = 'EVER_WORKS_E2E_FAKES';

function base(fakeUrl: string): string {
    return fakeUrl.replace(/\/+$/, '');
}

/**
 * Seed the upstream state and **refuse the lane** when the fake did not apply it.
 *
 * Call it in the case's (or the project's) setup, before the surface under test
 * reads the row. Throws rather than returning a soft result: a spec that proceeds
 * without its seeded precondition fails later for a reason that misleads.
 */
export async function seedUpstreamState(
    request: APIRequestContext,
    fakeUrl: string,
    seed: FakeUpstreamSeedInput,
): Promise<FakeUpstreamSeed> {
    const response = await request.post(`${base(fakeUrl)}/_control/seed`, {
        data: seed,
        failOnStatusCode: false,
    });
    const text = await response.text().catch(() => '');
    if (response.status() !== 200) {
        throw new Error(
            `T45: the fake GitHub at ${base(fakeUrl)} answered ${response.status()} to POST ` +
                `/_control/seed: ${text.slice(0, 400)}. A 400 names an approval proposal that ` +
                'matches no seeded upstream_pull_requests row, which is a lane-authoring error.',
        );
    }

    const seeded = (safeJson(text) as { seeded?: { upstreamSeed?: FakeUpstreamSeedSummary } })
        ?.seeded;
    const summary = seeded?.upstreamSeed;
    if (!summary || summary.applied !== true) {
        throw new Error(
            `T45: the fake GitHub at ${base(fakeUrl)} did not apply the upstream seed (` +
                `upstreamSeed=${JSON.stringify(summary)}). The two upstream keys are armed only ` +
                `while ${FAKES_SWITCH_ENV}='1' with NODE_ENV !== 'production', and the fake reads ` +
                'that in ITS OWN process — so the fake must be started with the switch ' +
                '(`EVER_WORKS_E2E_FAKES=1 node apps/web/e2e/fakes/github-fake/server.mjs`). ' +
                'Without it the seed is ignored and this case would assert against a state it ' +
                'never created.',
        );
    }

    const state = await request.get(`${base(fakeUrl)}/_control/state`, { failOnStatusCode: false });
    if (!state.ok()) {
        throw new Error(
            `T45: the fake GitHub at ${base(fakeUrl)} is not answering /_control/state ` +
                `(HTTP ${state.status()}), so the seeded upstream state cannot be read back.`,
        );
    }
    const body = (await state.json()) as {
        upstreamPullRequests?: FakeUpstreamPullRequestRow[];
        upstreamApprovalProposals?: FakeUpstreamApprovalProposal[];
    };
    return {
        summary,
        rows: body.upstreamPullRequests ?? [],
        proposals: body.upstreamApprovalProposals ?? [],
    };
}

/** The seeded row for `id`, or `undefined` — the lookup a case asserts the pair through. */
export function upstreamRowFor(
    seeded: FakeUpstreamSeed,
    id: string,
): FakeUpstreamPullRequestRow | undefined {
    return seeded.rows.find((row) => row.id === id);
}

/**
 * The proposal that approves `row`, or `undefined`.
 *
 * Matched the way the fake matches them — by `payload.upstreamPullRequestId` — so a
 * case asserting "the proposal is linked to my row" reads the same field the
 * platform will.
 */
export function upstreamProposalFor(
    seeded: FakeUpstreamSeed,
    row: FakeUpstreamPullRequestRow,
): FakeUpstreamApprovalProposal | undefined {
    return seeded.proposals.find(
        (proposal) =>
            proposal.payload?.upstreamPullRequestId === row.id ||
            proposal.id === row.approvalProposalId,
    );
}

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}
