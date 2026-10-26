import { readFleetSessionError } from '@ever-works/agent/fleet';
import { FleetPullRequestService } from '../session-git/fleet-pull-request.service';

/**
 * FL-06 FR-18 — the ONE fleet write a run token may reach
 * (`POST /api/fleet/checkouts/{id}/pull-request`, listed in
 * `FLEET_RUN_TOKEN_ROUTES`). The route list cannot see whose checkout it is,
 * so the scope pin lives in `FleetPullRequestService.open`: a run token acts
 * only on the checkout of ITS OWN session, only for an Agent, and only with
 * the Agent's "may open pull requests" permission. Each refusal must land
 * before anything reaches GitHub.
 */
describe('FleetPullRequestService.open — the run-token scope (FL-06 FR-18)', () => {
    const OWN_CHECKOUT = '11111111-1111-4111-8111-111111111111';
    const OTHER_CHECKOUT = '22222222-2222-4222-8222-222222222222';
    const RUN = {
        jobId: 'job-1',
        nodeId: 'node-1',
        runId: 'run-1',
        organizationId: 'org-1',
        agentId: 'agent-1',
    };

    function build(
        opts: {
            sessionCheckoutId?: string | null;
            sessionAgentId?: string | null;
            canOpenPullRequests?: boolean;
        } = {},
    ) {
        const checkoutRow = (id: string) => ({
            id,
            nodeId: 'node-1',
            userId: 'user-1',
            gitLine: null,
            branch: 'fix-login',
            remoteUrl: 'https://github.com/acme/api.git',
        });
        const rows = { findById: jest.fn(async (id: string) => checkoutRow(id)) };
        const access = { resolveForFamily: jest.fn(async () => ({ node: { name: 'laptop' } })) };
        const killSwitch = { isStopped: jest.fn(async () => false) };
        const session =
            opts.sessionCheckoutId === null
                ? null
                : {
                      id: 'session-1',
                      checkoutId: opts.sessionCheckoutId ?? OWN_CHECKOUT,
                      agentId: opts.sessionAgentId === undefined ? 'agent-1' : opts.sessionAgentId,
                      agentRunId: 'run-1',
                  };
        const sessionRows = {
            findByAgentRunId: jest.fn(async () => session),
            findById: jest.fn(async () => ({ id: 'session-2', checkoutId: OTHER_CHECKOUT })),
            findLiveForNode: jest.fn(async () => []),
        };
        const agents = {
            findById: jest.fn(async () => ({
                id: 'agent-1',
                name: 'Builder',
                permissions: { canOpenPullRequests: opts.canOpenPullRequests ?? false },
            })),
        };
        const enrichment = {
            enrich: jest.fn(async () => ({ defaultBranch: 'main' })),
            accessFor: jest.fn(),
        };
        const git = {};
        const service = new FleetPullRequestService(
            {} as never,
            rows as never,
            sessionRows as never,
            access as never,
            killSwitch as never,
            enrichment as never,
            git as never,
            {} as never,
            undefined,
            undefined,
            agents as never,
            undefined,
        );
        return { service, enrichment, sessionRows, agents };
    }

    async function codeOf(promise: Promise<unknown>): Promise<string | null> {
        try {
            await promise;
            return null;
        } catch (error) {
            return readFleetSessionError(error)?.code ?? `unexpected: ${String(error)}`;
        }
    }

    it("refuses a run token on a checkout that is not its own session's, before GitHub is asked", async () => {
        const { service, enrichment } = build({
            sessionCheckoutId: OWN_CHECKOUT,
            canOpenPullRequests: true,
        });
        const code = await codeOf(
            service.open(OTHER_CHECKOUT, { userId: 'user-1', run: RUN }, { title: 'Fix login' }),
        );
        expect(code).toBe('permission_denied');
        expect(enrichment.enrich).not.toHaveBeenCalled();
        expect(enrichment.accessFor).not.toHaveBeenCalled();
    });

    it('refuses a run token whose run has no session at all', async () => {
        const { service, enrichment } = build({
            sessionCheckoutId: null,
            canOpenPullRequests: true,
        });
        const code = await codeOf(
            service.open(OWN_CHECKOUT, { userId: 'user-1', run: RUN }, { title: 'Fix login' }),
        );
        expect(code).toBe('permission_denied');
        expect(enrichment.enrich).not.toHaveBeenCalled();
    });

    it('ignores a sessionId in the body for a run token — the token decides the session', async () => {
        const { service, sessionRows, enrichment } = build({
            sessionCheckoutId: OWN_CHECKOUT,
            canOpenPullRequests: true,
        });
        const code = await codeOf(
            service.open(
                OTHER_CHECKOUT,
                { userId: 'user-1', run: RUN },
                { title: 'Fix login', sessionId: 'session-2' },
            ),
        );
        expect(code).toBe('permission_denied');
        expect(sessionRows.findById).not.toHaveBeenCalled();
        expect(enrichment.enrich).not.toHaveBeenCalled();
    });

    it('refuses its own checkout too while the Agent lacks the "may open pull requests" permission', async () => {
        const { service, agents, enrichment } = build({
            sessionCheckoutId: OWN_CHECKOUT,
            canOpenPullRequests: false,
        });
        const code = await codeOf(
            service.open(OWN_CHECKOUT, { userId: 'user-1', run: RUN }, { title: 'Fix login' }),
        );
        expect(code).toBe('permission_denied');
        expect(agents.findById).toHaveBeenCalledWith('agent-1');
        expect(enrichment.enrich).not.toHaveBeenCalled();
    });

    it('refuses a run token when neither the token nor its session names an Agent', async () => {
        const { service, enrichment } = build({
            sessionCheckoutId: OWN_CHECKOUT,
            sessionAgentId: null,
            canOpenPullRequests: true,
        });
        const code = await codeOf(
            service.open(
                OWN_CHECKOUT,
                { userId: 'user-1', run: { ...RUN, agentId: null } },
                { title: 'Fix login' },
            ),
        );
        expect(code).toBe('permission_denied');
        expect(enrichment.enrich).not.toHaveBeenCalled();
    });

    it('control: its own checkout with the permission passes the scope pin and reaches the provider step', async () => {
        const { service, enrichment } = build({
            sessionCheckoutId: OWN_CHECKOUT,
            canOpenPullRequests: true,
        });
        const code = await codeOf(
            service.open(OWN_CHECKOUT, { userId: 'user-1', run: RUN }, { title: 'Fix login' }),
        );
        expect(code).not.toBe('permission_denied');
        expect(enrichment.enrich).toHaveBeenCalled();
    });
});
