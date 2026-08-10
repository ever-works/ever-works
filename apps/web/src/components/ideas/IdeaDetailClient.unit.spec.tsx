import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => {
        const t = (key: string) => key;
        return t;
    },
    useLocale: () => 'en',
}));

const routerPushMock = vi.fn();
const routerRefreshMock = vi.fn();
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({
        push: routerPushMock,
        replace: vi.fn(),
        refresh: routerRefreshMock,
    }),
    Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
vi.mock('sonner', () => ({
    toast: {
        success: (...a: unknown[]) => toastSuccessMock(...a),
        error: (...a: unknown[]) => toastErrorMock(...a),
    },
}));

const deleteIdeaMock = vi.fn();
const retryIdeaMock = vi.fn();
const rebuildIdeaMock = vi.fn();
const buildIdeaMock = vi.fn();
vi.mock('@/app/actions/dashboard/work-proposals', () => ({
    deleteIdeaAction: (...a: unknown[]) => deleteIdeaMock(...a),
    retryIdeaAction: (...a: unknown[]) => retryIdeaMock(...a),
    rebuildIdeaAction: (...a: unknown[]) => rebuildIdeaMock(...a),
    buildIdeaAction: (...a: unknown[]) => buildIdeaMock(...a),
    getProposalAction: vi.fn(),
    attachUploadToIdeaAction: vi.fn(),
    detachIdeaAttachmentAction: vi.fn(),
}));

// Both the rail's unassign action and the assign dialog it mounts reach
// for the `server-only` agents actions module.
const unassignAgentMock = vi.fn();
const listAssignableAgentsMock = vi.fn();
vi.mock('@/app/actions/agents', () => ({
    unassignAgentFromIdeaAction: (...a: unknown[]) => unassignAgentMock(...a),
    assignAgentToIdeaAction: vi.fn(),
    listAssignableIdeaAgentsAction: (...a: unknown[]) => listAssignableAgentsMock(...a),
}));

import { IdeaDetailClient } from './IdeaDetailClient';
import type { IdeaWorkLink, WorkProposal } from '@/lib/api/work-proposals';
import type { Agent } from '@/lib/api/agents';

/**
 * `/ideas/[id]` detail — covers the two things the redesign added on
 * top of the old read-only card: an explicit built / not-built answer
 * (badge + tracker + Rebuild instead of Build), and the guarded delete
 * flow whose 409 refusal must name the blocker in the dialog.
 */
const baseIdea: WorkProposal = {
    id: 'idea-1',
    title: 'Top AI coding assistants',
    description: 'A curated list of the leading AI-powered coding tools.',
    slugSuggestion: 'top-ai-coding-assistants',
    suggestedCategories: [{ name: 'AI', slug: 'ai' }],
    suggestedFields: [],
    recommendedPlugins: [],
    generatedPrompt: 'p',
    reasoning: 'because',
    source: 'user-manual',
    status: 'pending',
    acceptedWorkId: null,
    generatedAt: '2026-01-01T00:00:00.000Z',
};

/**
 * The Work the page matched to this Idea by content — same subject as
 * `baseIdea`, but with no `idea_works` row tying them together.
 */
const matchedWork = {
    id: 'work-5',
    name: 'Top AI coding assistants',
    createdAt: '2026-01-03T00:00:00.000Z',
};

const builtLink: IdeaWorkLink = {
    id: 'link-1',
    ideaId: 'idea-1',
    workId: 'work-1',
    kind: 'built',
    createdAt: '2026-01-02T00:00:00.000Z',
    workName: 'AI Coding Tools',
    workSlug: 'ai-coding-tools',
};

describe('IdeaDetailClient', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        listAssignableAgentsMock.mockResolvedValue([]);
    });

    it('reads as not built, and offers Build, when no Work was produced', () => {
        render(<IdeaDetailClient idea={baseIdea} />);

        // Not built ⇒ the lifecycle status stands, alongside an explicit
        // "Not built yet". No Built pill exists to contradict it.
        expect(screen.getByTestId('idea-status-badge')).toHaveTextContent('filters.pending');
        expect(screen.getByTestId('idea-not-built-badge')).toHaveTextContent('built.none');
        expect(screen.queryByTestId('idea-built-badge')).not.toBeInTheDocument();
        expect(screen.getByTestId('idea-build-button')).toBeInTheDocument();
        expect(screen.queryByTestId('idea-rebuild-button')).not.toBeInTheDocument();
        expect(screen.queryByTestId('idea-built-work-link')).not.toBeInTheDocument();
    });

    it('replaces the lifecycle status with Built once a Work exists', () => {
        // The reported bug, on the detail page: a dismissed Idea that had
        // produced a Work rendered "Dismissed" beside "Built (1)".
        render(
            <IdeaDetailClient
                idea={{ ...baseIdea, status: 'dismissed' }}
                initialLinks={[{ ...builtLink, kind: 'linked' }]}
            />,
        );

        expect(screen.getByTestId('idea-built-badge')).toHaveTextContent('built.badge');
        expect(screen.queryByTestId('idea-status-badge')).not.toBeInTheDocument();
        expect(screen.queryByTestId('idea-not-built-badge')).not.toBeInTheDocument();
    });

    it('Build opens the same /works/new flow the Idea card uses', () => {
        // The card and the page it opens must build an Idea the same way.
        // Queueing through the build endpoint from here errored for
        // un-configured accounts; only the /works/new form collects the
        // git/provider config a build needs.
        render(<IdeaDetailClient idea={baseIdea} />);

        fireEvent.click(screen.getByTestId('idea-build-button'));

        expect(routerPushMock).toHaveBeenCalledWith('/works/new?proposal=idea-1');
        expect(buildIdeaMock).not.toHaveBeenCalled();
    });

    it('reads as built off the idea_works link, and swaps Build for Rebuild', () => {
        render(
            <IdeaDetailClient
                idea={{ ...baseIdea, status: 'accepted', acceptedWorkId: 'work-1' }}
                initialLinks={[builtLink]}
            />,
        );

        expect(screen.getByTestId('idea-built-badge')).toHaveTextContent('built.badge');
        expect(screen.getByTestId('idea-rebuild-button')).toBeInTheDocument();
        expect(screen.queryByTestId('idea-build-button')).not.toBeInTheDocument();
        // The build tracker's terminal step links straight to the Work.
        expect(screen.getByTestId('idea-built-work-link')).toHaveAttribute('href', '/works/work-1');
    });

    it('counts a "linked" link as built — the /works/new?proposal= flow', () => {
        // Building an Idea from the card redirects to
        // `/works/new?proposal=…`; the Work created there is recorded with
        // kind `linked`, not `built`. Filtering to built/rebuilt made the
        // most common build path read as "not built".
        render(
            <IdeaDetailClient
                idea={{ ...baseIdea, status: 'pending', acceptedWorkId: null }}
                initialLinks={[{ ...builtLink, kind: 'linked' }]}
            />,
        );

        expect(screen.getByTestId('idea-built-badge')).toHaveTextContent('built.badge');
        expect(screen.queryByTestId('idea-build-button')).not.toBeInTheDocument();
        // Rebuild refuses any status but ACCEPTED, so a built-but-pending
        // Idea must not offer a button that can only 400.
        expect(screen.queryByTestId('idea-rebuild-button')).not.toBeInTheDocument();
        expect(screen.getByTestId('idea-built-work-link')).toHaveAttribute('href', '/works/work-1');
    });

    it('counts a Work matched by title + description as built', () => {
        // A Work built outside the Idea flow leaves no provenance link.
        // The page matches it on content and hands it down.
        render(<IdeaDetailClient idea={baseIdea} matchedWork={matchedWork} />);

        expect(screen.getByTestId('idea-built-badge')).toHaveTextContent('built.badge');
        expect(screen.queryByTestId('idea-build-button')).not.toBeInTheDocument();
        expect(screen.getByTestId('idea-built-work-link')).toHaveAttribute('href', '/works/work-5');
    });

    it('lists the matched Work under Linked Works', () => {
        // Provenance has nothing to list, but the Work exists — leaving the
        // section empty next to a "Built" badge read as a contradiction.
        render(<IdeaDetailClient idea={baseIdea} matchedWork={matchedWork} />);

        const rows = screen.getAllByTestId('idea-linked-work-row');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toHaveAttribute('href', '/works/work-5');
        expect(rows[0]).toHaveTextContent('Top AI coding assistants');
        // Inferred, not recorded — it carries its own kind badge.
        expect(rows[0]).toHaveTextContent('linkedWorks.kind.matched');
    });

    it('prefers the provenance link over a content match', () => {
        render(
            <IdeaDetailClient
                idea={{ ...baseIdea, status: 'accepted', acceptedWorkId: 'work-1' }}
                initialLinks={[builtLink]}
                matchedWork={matchedWork}
            />,
        );

        expect(screen.getByTestId('idea-built-work-link')).toHaveAttribute('href', '/works/work-1');
    });

    it('lists a Work once when provenance and the content match agree', () => {
        // Same Work from both sources: the recorded kind wins and the row
        // is not duplicated.
        render(
            <IdeaDetailClient
                idea={{ ...baseIdea, status: 'accepted', acceptedWorkId: 'work-1' }}
                initialLinks={[builtLink]}
                matchedWork={{ ...matchedWork, id: 'work-1' }}
            />,
        );

        const rows = screen.getAllByTestId('idea-linked-work-row');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toHaveTextContent('linkedWorks.kind.built');
        expect(rows[0]).not.toHaveTextContent('linkedWorks.kind.matched');
    });

    it('falls back to the rollup count when the link list is unavailable', () => {
        // The detail page degrades a failed `listWorks` to an empty list;
        // the Idea's own `linkedWorksCount` still answers "is it built?".
        render(
            <IdeaDetailClient
                idea={{
                    ...baseIdea,
                    status: 'failed',
                    acceptedWorkId: null,
                    linkedWorksCount: 2,
                    latestLinkedWorkId: 'work-7',
                }}
            />,
        );

        expect(screen.getByTestId('idea-built-badge')).toHaveTextContent('built.badge');
        expect(screen.getByTestId('idea-built-work-link')).toHaveAttribute('href', '/works/work-7');
    });

    it('offers Retry (not Build) on a failed Idea and shows the failure reason', () => {
        render(
            <IdeaDetailClient
                idea={{
                    ...baseIdea,
                    status: 'failed',
                    failureKind: 'transient-rate-limit',
                    failureMessage: 'Upstream 429',
                }}
            />,
        );

        expect(screen.getByTestId('idea-retry-button')).toBeInTheDocument();
        expect(screen.queryByTestId('idea-build-button')).not.toBeInTheDocument();
        expect(screen.getByTestId('idea-failure')).toHaveTextContent('Upstream 429');
    });

    it('hides build actions while a build is in flight', () => {
        render(<IdeaDetailClient idea={{ ...baseIdea, status: 'building' }} />);

        expect(screen.getByTestId('idea-live-cta')).toBeInTheDocument();
        expect(screen.queryByTestId('idea-build-button')).not.toBeInTheDocument();
        expect(screen.queryByTestId('idea-retry-button')).not.toBeInTheDocument();
    });

    describe('Build status tracker', () => {
        const stagesOf = () =>
            Array.from(
                screen.getByTestId('idea-build-tracker').querySelectorAll('li p:first-child'),
            ).map((el) => el.textContent);

        it('does not claim queued/building steps for an Idea built in the Work builder', () => {
            // `/works/new?proposal=…` records kind `linked` and never touches
            // the build queue. The tracker used to green-check Queued and
            // Building anyway, inventing a history that never happened.
            render(
                <IdeaDetailClient
                    idea={{ ...baseIdea, status: 'accepted', acceptedWorkId: 'work-1' }}
                    initialLinks={[{ ...builtLink, kind: 'linked' }]}
                />,
            );

            expect(stagesOf()).toEqual(['stages.drafted', 'stages.builtDirect']);
        });

        it('shows the full pipeline for an Idea the Work Agent built', () => {
            render(
                <IdeaDetailClient
                    idea={{ ...baseIdea, status: 'accepted', acceptedWorkId: 'work-1' }}
                    initialLinks={[builtLink]}
                />,
            );

            expect(stagesOf()).toEqual([
                'stages.drafted',
                'stages.queued',
                'stages.building',
                'stages.built',
            ]);
        });

        it('stops at the failure and never renders a Built step after it', () => {
            // A failed rebuild has an older Work, so the old index-based
            // tracker rendered `Building ✗` feeding a green `Built ✓` —
            // two contradictory terminal states in one column.
            render(
                <IdeaDetailClient
                    idea={{ ...baseIdea, status: 'failed', acceptedWorkId: 'work-1' }}
                    initialLinks={[builtLink]}
                />,
            );

            const stages = stagesOf();
            expect(stages).toEqual(['stages.drafted', 'stages.queued', 'stages.failed']);
            expect(stages).not.toContain('stages.built');
            // What EXISTS is still reachable — the tracker describes the
            // latest attempt, not the Idea's whole history.
            expect(screen.getByTestId('idea-built-work-link')).toBeInTheDocument();
        });

        it('marks the live step while a build is running', () => {
            render(<IdeaDetailClient idea={{ ...baseIdea, status: 'queued' }} />);

            expect(stagesOf()).toEqual([
                'stages.drafted',
                'stages.queued',
                'stages.building',
                'stages.built',
            ]);
        });

        it('lights Drafted as the current step on an untouched Idea', () => {
            const { container } = render(<IdeaDetailClient idea={baseIdea} />);

            expect(stagesOf()).toEqual([
                'stages.drafted',
                'stages.queued',
                'stages.building',
                'stages.built',
            ]);
            // A pending Idea waits on the USER, not on a builder — so the
            // current step must not spin like work is in flight.
            expect(container.querySelector('.animate-spin')).toBeNull();
        });
    });

    it('deletes through the confirm dialog and returns to the catalog', async () => {
        deleteIdeaMock.mockResolvedValue({ deleted: true });
        render(<IdeaDetailClient idea={baseIdea} />);

        fireEvent.click(screen.getByTestId('idea-delete-button'));
        fireEvent.click(screen.getByTestId('idea-delete-confirm'));

        await waitFor(() => expect(deleteIdeaMock).toHaveBeenCalledWith('idea-1'));
        await waitFor(() => expect(routerPushMock).toHaveBeenCalledWith('/ideas'));
    });

    it('names the blocker in the dialog when the API refuses the delete', async () => {
        // `idea-agents` rather than `linked-works`: linked Works no longer
        // block the delete, so that reason is no longer produced.
        deleteIdeaMock.mockResolvedValue({ deleted: false, reason: 'idea-agents', count: 3 });
        render(<IdeaDetailClient idea={baseIdea} />);

        fireEvent.click(screen.getByTestId('idea-delete-button'));
        fireEvent.click(screen.getByTestId('idea-delete-confirm'));

        await waitFor(() =>
            expect(screen.getByTestId('idea-delete-error')).toHaveTextContent(
                'deleteDialog.blocked.idea-agents',
            ),
        );
        // A refused delete must NOT navigate away.
        expect(routerPushMock).not.toHaveBeenCalled();
    });

    describe('deleting an Idea that has linked Works', () => {
        it('warns that the links go but the Works are kept', () => {
            render(<IdeaDetailClient idea={baseIdea} initialLinks={[builtLink]} />);

            fireEvent.click(screen.getByTestId('idea-delete-button'));

            expect(screen.getByTestId('idea-delete-unlinks-works')).toHaveTextContent(
                'deleteDialog.unlinksWorks',
            );
        });

        it('omits the warning when only a content match points at a Work', () => {
            // A matched Work has no `idea_works` row, so a delete takes
            // nothing away from it — warning about it would be a lie.
            render(<IdeaDetailClient idea={baseIdea} matchedWork={matchedWork} />);

            fireEvent.click(screen.getByTestId('idea-delete-button'));

            expect(screen.queryByTestId('idea-delete-unlinks-works')).not.toBeInTheDocument();
        });

        it('goes through, rather than being refused as it used to be', async () => {
            deleteIdeaMock.mockResolvedValue({ deleted: true });
            render(<IdeaDetailClient idea={baseIdea} initialLinks={[builtLink]} />);

            fireEvent.click(screen.getByTestId('idea-delete-button'));
            fireEvent.click(screen.getByTestId('idea-delete-confirm'));

            await waitFor(() => expect(deleteIdeaMock).toHaveBeenCalledWith('idea-1'));
            await waitFor(() => expect(routerPushMock).toHaveBeenCalledWith('/ideas'));
        });
    });

    /**
     * The Agents rail mirrors the Work header's dropdown: one merged list
     * of Agents PINNED here by scope and Agents ASSIGNED here through
     * their `targets`, with detach offered only on the latter.
     */
    describe('Agents rail', () => {
        const pinnedAgent = {
            id: 'agent-pinned',
            name: 'Idea Scout',
            slug: 'idea-scout',
            title: null,
            status: 'active',
        } as unknown as Agent;

        const assignedAgent = {
            id: 'agent-assigned',
            name: 'Release Manager',
            slug: 'release-manager',
            title: 'Ships',
            status: 'active',
        } as unknown as Agent;

        it('sits in the main column directly under Linked Works', () => {
            render(<IdeaDetailClient idea={baseIdea} agents={[pinnedAgent]} />);

            const linkedWorks = screen.getByTestId('idea-linked-works');
            const agentsCard = screen.getByTestId('idea-agents');

            // Same parent as Linked Works — i.e. the main column, not the
            // read-mostly rail the Build tracker lives in.
            expect(agentsCard.parentElement).toBe(linkedWorks.parentElement);
            expect(screen.getByTestId('idea-build-tracker').parentElement).not.toBe(
                agentsCard.parentElement,
            );
            // Directly under it: adjacent siblings, in that order.
            expect(linkedWorks.nextElementSibling).toBe(agentsCard);
        });

        it('opens the picker from the section header', async () => {
            render(<IdeaDetailClient idea={baseIdea} />);

            fireEvent.click(screen.getByTestId('idea-assign-agent-button'));

            await waitFor(() =>
                expect(listAssignableAgentsMock).toHaveBeenCalledWith('idea-1', ''),
            );
        });

        it('offers detach on assigned Agents only — a pinned one is placed by its scope', () => {
            render(
                <IdeaDetailClient
                    idea={baseIdea}
                    agents={[pinnedAgent, assignedAgent]}
                    assignedAgentIds={[assignedAgent.id]}
                />,
            );

            expect(screen.getByText('Idea Scout')).toBeTruthy();
            expect(screen.getByText('Release Manager')).toBeTruthy();
            // One row is detachable, so exactly one unassign control exists.
            expect(screen.getAllByLabelText('agents.unassign')).toHaveLength(1);
        });

        it('detaches the assigned Agent and refreshes', async () => {
            unassignAgentMock.mockResolvedValue({ id: assignedAgent.id });
            render(
                <IdeaDetailClient
                    idea={baseIdea}
                    agents={[assignedAgent]}
                    assignedAgentIds={[assignedAgent.id]}
                />,
            );

            fireEvent.click(screen.getByLabelText('agents.unassign'));

            await waitFor(() =>
                expect(unassignAgentMock).toHaveBeenCalledWith('agent-assigned', 'idea-1'),
            );
            await waitFor(() => expect(routerRefreshMock).toHaveBeenCalled());
            expect(toastSuccessMock).toHaveBeenCalledWith('agents.unassignedToast');
        });

        it('surfaces a failed detach', async () => {
            unassignAgentMock.mockRejectedValue(new Error('still running'));
            render(
                <IdeaDetailClient
                    idea={baseIdea}
                    agents={[assignedAgent]}
                    assignedAgentIds={[assignedAgent.id]}
                />,
            );

            fireEvent.click(screen.getByLabelText('agents.unassign'));

            await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith('still running'));
        });
    });
});
