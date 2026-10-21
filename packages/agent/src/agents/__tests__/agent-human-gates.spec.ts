import { buildEscalationTools } from '../agent-escalation-tools';
import { AgentProposalExecutionListener } from '../agent-proposal-execution.listener';
import {
    AGENT_ESCALATION_RESOLUTION_PROPOSAL_KIND,
    AGENT_FILE_EDIT_PROPOSAL_KIND,
} from '../agent-proposal-kinds';
import { AgentActionProposalDecidedEvent } from '../../agent-approvals/agent-action-proposal-decided.event';
import { classifyAction } from '../../safety/action-category';

/**
 * Prompt-injection hardening — an Agent never answers one of the owner's human
 * gates, nor rewrites its own trusted identity, by itself:
 *
 *   - `resolve_escalation` files an owner-approval proposal instead of
 *     resolving, and an approved proposal resolves the escalation as
 *     AGENT-authored (which never resumes the waiting run);
 *   - an approved `editAgentFile` proposal writes exactly the proposed body,
 *     guarded by the hash the agent saw.
 */
describe('resolve_escalation — proposes, never resolves', () => {
    const open = { id: 'e1', status: 'open' };

    function tools(overrides: { proposals?: unknown; existing?: unknown } = {}) {
        const service = {
            listForUser: jest.fn().mockResolvedValue([]),
            resolve: jest.fn().mockResolvedValue(true),
            getForUser: jest
                .fn()
                .mockResolvedValue('existing' in overrides ? overrides.existing : open),
        };
        const proposals =
            'proposals' in overrides
                ? overrides.proposals
                : { propose: jest.fn().mockResolvedValue({ id: 'p-1', status: 'pending' }) };
        const built = buildEscalationTools({
            userId: 'owner-1',
            agentId: 'agent-1',
            agentRunId: 'run-1',
            service,
            proposals: proposals as never,
        });
        const tool = built.find((entry) => entry.name === 'resolve_escalation')!;
        return { tool, service, proposals: proposals as { propose: jest.Mock } | null };
    }

    it('files a PENDING proposal carrying the escalation and note — and resolves nothing', async () => {
        const { tool, service, proposals } = tools();
        const result = await tool.invoke({ escalationId: 'e1', note: 'budget raised' });

        expect(service.resolve).not.toHaveBeenCalled();
        expect(proposals!.propose).toHaveBeenCalledWith('owner-1', {
            agentId: 'agent-1',
            runId: 'run-1',
            title: expect.stringContaining('close escalation'),
            payload: {
                kind: AGENT_ESCALATION_RESOLUTION_PROPOSAL_KIND,
                escalationId: 'e1',
                note: 'budget raised',
            },
            subjectKey: 'escalation:e1',
        });
        expect(result).toMatchObject({
            resolved: false,
            proposed: true,
            pendingApproval: true,
            proposalId: 'p-1',
        });
    });

    it('fails CLOSED with no approval queue: nothing is resolved', async () => {
        const { tool, service } = tools({ proposals: null });
        const result = (await tool.invoke({ escalationId: 'e1' })) as { error?: string };
        expect(result.error).toMatch(/decided by the owner/);
        expect(service.resolve).not.toHaveBeenCalled();
    });

    it('proposes nothing for an unknown, foreign or already-resolved escalation', async () => {
        const missing = tools({ existing: null });
        await expect(missing.tool.invoke({ escalationId: 'nope' })).resolves.toMatchObject({
            proposed: false,
        });
        expect(missing.proposals!.propose).not.toHaveBeenCalled();

        const resolved = tools({ existing: { id: 'e1', status: 'resolved' } });
        await expect(resolved.tool.invoke({ escalationId: 'e1' })).resolves.toMatchObject({
            proposed: false,
        });
        expect(resolved.proposals!.propose).not.toHaveBeenCalled();
    });

    it('reports a guardrail block as a refusal', async () => {
        const { tool } = tools({
            proposals: { propose: jest.fn().mockResolvedValue({ id: 'p-2', status: 'rejected' }) },
        });
        await expect(tool.invoke({ escalationId: 'e1' })).resolves.toMatchObject({
            proposed: false,
            error: expect.stringMatching(/guardrails/),
        });
    });

    it('both gated tools stay write.internal — the approval proposal is the gate', () => {
        // A held `access.grant` rung would stop the call before any proposal
        // is filed, leaving the owner nothing to approve.
        expect(classifyAction('resolve_escalation')).toBe('write.internal');
        expect(classifyAction('editAgentFile')).toBe('write.internal');
    });
});

describe('AgentProposalExecutionListener', () => {
    function event(
        payload: Record<string, unknown>,
        overrides: Partial<{
            status: 'approved' | 'rejected';
            decidedVia: 'user' | 'guardrail' | null;
            decidedById: string | null;
            actionType: string;
        }> = {},
    ): AgentActionProposalDecidedEvent {
        return new AgentActionProposalDecidedEvent(
            'p-1',
            'owner-1',
            'agent-1',
            (overrides.actionType ?? 'other') as never,
            overrides.status ?? 'approved',
            overrides.decidedById === undefined ? 'owner-1' : overrides.decidedById,
            overrides.decidedVia === undefined ? 'user' : overrides.decidedVia,
            payload,
        );
    }

    function build() {
        const escalations = { resolve: jest.fn().mockResolvedValue(true) };
        const files = { write: jest.fn().mockResolvedValue({ newHash: 'h2' }) };
        const inbox = { notice: jest.fn().mockResolvedValue(undefined) };
        const listener = new AgentProposalExecutionListener(
            escalations as never,
            files as never,
            inbox as never,
        );
        return { listener, escalations, files, inbox };
    }

    const escalationPayload = {
        kind: AGENT_ESCALATION_RESOLUTION_PROPOSAL_KIND,
        escalationId: 'e1',
        note: 'go ahead',
    };
    const filePayload = {
        kind: AGENT_FILE_EDIT_PROPOSAL_KIND,
        fileName: 'SOUL.md',
        body: '# New soul',
        baseHash: 'h1',
        runId: 'run-1',
    };

    it('an approved escalation proposal resolves it as AGENT-authored (no resume)', async () => {
        const { listener, escalations } = build();
        await listener.handleProposalDecided(event(escalationPayload));
        expect(escalations.resolve).toHaveBeenCalledWith('e1', 'owner-1', 'go ahead', {
            resolvedBy: 'agent',
            agentId: 'agent-1',
        });
    });

    it('an approved file edit writes exactly the proposed body, guarded by the hash the agent saw', async () => {
        const { listener, files } = build();
        await listener.handleProposalDecided(event(filePayload));
        expect(files.write).toHaveBeenCalledWith({
            userId: 'owner-1',
            agentId: 'agent-1',
            name: 'SOUL.md',
            body: '# New soul',
            expectedHash: 'h1',
            actor: 'agent',
            runId: 'run-1',
        });
    });

    it.each([
        ['a rejection', { status: 'rejected' as const }],
        ['a guardrail decision', { decidedVia: 'guardrail' as const, decidedById: null }],
        ['a decision with no person', { decidedById: null }],
        ['another action type', { actionType: 'send_message' }],
    ])('does nothing on %s', async (_label, overrides) => {
        const { listener, escalations, files } = build();
        await listener.handleProposalDecided(event(escalationPayload, overrides));
        await listener.handleProposalDecided(event(filePayload, overrides));
        expect(escalations.resolve).not.toHaveBeenCalled();
        expect(files.write).not.toHaveBeenCalled();
    });

    it('never writes a payload naming a file outside the five canonical files — and says so', async () => {
        const { listener, files, inbox } = build();
        await listener.handleProposalDecided(
            event({ ...filePayload, fileName: '../../etc/passwd' }),
        );
        expect(files.write).not.toHaveBeenCalled();
        expect(inbox.notice).toHaveBeenCalledWith(
            'owner-1',
            expect.objectContaining({ body: expect.stringContaining('names no agent file') }),
        );
    });

    // Review of #2769: an approved proposal that cannot be applied for ANY
    // reason files the owner notice — a malformed payload or a service that is
    // not wired used to return silently.
    it.each([
        ['a non-string body', { ...filePayload, body: 42 }, 'no file body'],
        ['a missing base hash', { ...filePayload, baseHash: undefined }, 'no base content hash'],
        ['a missing escalation id', { ...escalationPayload, escalationId: '' }, 'no escalation'],
    ])('reports %s instead of returning silently', async (_label, payload, reason) => {
        const { listener, files, escalations, inbox } = build();
        await listener.handleProposalDecided(event(payload));
        expect(files.write).not.toHaveBeenCalled();
        expect(escalations.resolve).not.toHaveBeenCalled();
        expect(inbox.notice).toHaveBeenCalledWith(
            'owner-1',
            expect.objectContaining({
                title: expect.stringMatching(/NOT applied/),
                body: expect.stringContaining(reason),
            }),
        );
    });

    it('reports an approval it cannot apply because the service is not wired', async () => {
        const inbox = { notice: jest.fn().mockResolvedValue(undefined) };
        const listener = new AgentProposalExecutionListener(undefined, undefined, inbox as never);
        await listener.handleProposalDecided(event(filePayload));
        await listener.handleProposalDecided(event(escalationPayload));
        expect(inbox.notice).toHaveBeenCalledTimes(2);
        expect(inbox.notice.mock.calls[0][1].body).toContain('agent files are not available');
        expect(inbox.notice.mock.calls[1][1].body).toContain('escalations are not available');
    });

    it('never throws back into the decision (best-effort), and tells the owner it did not apply', async () => {
        const { listener, files, inbox } = build();
        files.write.mockRejectedValue(new Error('etag mismatch'));
        await expect(listener.handleProposalDecided(event(filePayload))).resolves.toBeUndefined();
        expect(inbox.notice).toHaveBeenCalledWith(
            'owner-1',
            expect.objectContaining({
                title: expect.stringMatching(/NOT applied/),
                body: expect.stringContaining('SOUL.md'),
                agentId: 'agent-1',
            }),
        );
    });

    it('a replayed / stale file edit is refused by the real hash check and reported', async () => {
        // A real AgentFileService over a row whose hash moved on after the
        // agent proposed: the approved proposal must not overwrite it.
        const { AgentFileService } = await import('../agent-file.service');
        const row = {
            id: 'agent-1',
            userId: 'owner-1',
            slug: 'ceo',
            scope: 'tenant',
            soulMd: '# Owner edited this since',
            contentHash: 'h-newer',
        };
        const repo = {
            findByIdAndUser: jest.fn().mockResolvedValue(row),
            updateById: jest.fn(),
            updateByIdIfContentHash: jest.fn().mockResolvedValue(false),
        };
        const files = new AgentFileService(repo as never);
        const inbox = { notice: jest.fn().mockResolvedValue(undefined) };
        const listener = new AgentProposalExecutionListener(undefined, files, inbox as never);

        await listener.handleProposalDecided(event(filePayload)); // baseHash h1 ≠ h-newer

        expect(repo.updateById).not.toHaveBeenCalled();
        expect(repo.updateByIdIfContentHash).not.toHaveBeenCalled(); // refused at the read
        expect(inbox.notice).toHaveBeenCalledWith(
            'owner-1',
            expect.objectContaining({ body: expect.stringMatching(/etag mismatch/) }),
        );
    });

    it('an approved closure of an already-resolved escalation is reported, not silent', async () => {
        const { listener, escalations, inbox } = build();
        escalations.resolve.mockResolvedValueOnce(false);
        await listener.handleProposalDecided(event(escalationPayload));
        expect(inbox.notice).toHaveBeenCalledWith(
            'owner-1',
            expect.objectContaining({ body: expect.stringContaining('escalation e1') }),
        );
    });
});
