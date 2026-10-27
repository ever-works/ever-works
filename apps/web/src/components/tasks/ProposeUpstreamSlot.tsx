import 'server-only';
import { upstreamPullRequestsAPI } from '@/lib/api/upstream-pull-requests';
import { ProposeUpstreamAction } from './ProposeUpstreamAction';

/**
 * APW-09 T11 — whether Task detail shows **Propose upstream**, decided on the server.
 *
 * Only a Task on a Work is asked about. The eligibility route answers `404` to a member
 * without edit access and `422` for a Work that is not an App Work; every failure renders
 * nothing (the Task page never breaks over this action), and a linked repository renders
 * nothing by design (S11).
 */
export async function ProposeUpstreamSlot({
    taskId,
    workId,
}: {
    taskId: string;
    workId: string | null;
}) {
    if (!workId) return null;
    const view = await upstreamPullRequestsAPI.eligibility(workId, taskId).catch(() => null);
    if (!view || (view.relation !== 'fork' && view.relation !== 'private-copy')) return null;
    return (
        <ProposeUpstreamAction
            view={{
                allowed: view.allowed === true,
                code: view.code,
                limit: view.limit,
                limitValue: view.limitValue,
                nextSlotAt: view.nextSlotAt,
                relation: view.relation,
                preparationAvailable: view.preparationAvailable === true,
                activeProposalId: view.activeProposalId ?? null,
                target: view.target
                    ? {
                          owner: view.target.owner,
                          repo: view.target.repo,
                          forkOwner: view.target.forkOwner,
                          forkRepo: view.target.forkRepo,
                      }
                    : null,
            }}
        />
    );
}
