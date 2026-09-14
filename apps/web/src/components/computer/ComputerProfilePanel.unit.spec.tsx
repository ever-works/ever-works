import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NodeAgentProfileView } from '@ever-works/contracts';
import { ComputerProfilePanel } from './ComputerProfilePanel';

vi.mock('next-intl', () => ({
    useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
        `${namespace.replace('dashboard.computer.', '')}.${key}${values ? `:${Object.values(values).join(',')}` : ''}`,
}));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));
vi.mock('@/components/ui/show-datetime', () => ({
    ShowDateTime: ({ value }: { value?: string | null }) => <span>{value}</span>,
}));

const AGENT = '11111111-2222-4333-8444-555555555555';
const NODE = '22222222-2222-4333-8444-555555555555';

const view: NodeAgentProfileView = {
    nodeId: NODE,
    agentId: AGENT,
    profileRef: 'ref',
    createdAt: '2026-09-01T10:00:00Z',
    lastUsedAt: '2026-09-13T09:00:00Z',
    signedInSiteCount: 3,
    diskBytes: 2048,
    lastResetAt: null,
};

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function renderPanel(props: {
    profile?: NodeAgentProfileView | null;
    fetchImpl?: typeof fetch;
    open?: boolean;
}) {
    return render(
        <ComputerProfilePanel
            open={props.open ?? true}
            onOpenChange={() => undefined}
            agentId={AGENT}
            agentName="Ops"
            nodeId={NODE}
            nodeName="studio-imac"
            {...('profile' in props ? { profile: props.profile } : {})}
            fetchImpl={props.fetchImpl ?? (vi.fn() as unknown as typeof fetch)}
        />,
    );
}

describe('ComputerProfilePanel', () => {
    it('uses a server-rendered profile, including a confirmed "never used here", without reading it again', () => {
        const fetchImpl = vi.fn();
        const { unmount } = renderPanel({ profile: view, fetchImpl: fetchImpl as never });
        expect(screen.getByTestId('computer-profile-description')).toHaveTextContent(
            'profile.body:Ops,studio-imac',
        );
        expect(screen.getByText('profile.resetAction')).toBeInTheDocument();
        unmount();

        renderPanel({ profile: null, fetchImpl: fetchImpl as never });
        expect(screen.getByTestId('computer-profile-description')).toHaveTextContent(
            'profile.notYet:Ops,studio-imac',
        );
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('reads the profile of a computer the page did not render, and offers the reset once it exists', async () => {
        let answer: (response: Response) => void = () => undefined;
        const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => (answer = resolve)));
        renderPanel({ fetchImpl: fetchImpl as unknown as typeof fetch });

        // Unknown is never presented as "not used yet".
        expect(screen.getByTestId('computer-profile-description')).toHaveTextContent(
            'profile.loading:Ops,studio-imac',
        );
        expect(screen.queryByText(/profile\.notYet/)).not.toBeInTheDocument();
        await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
        expect(fetchImpl.mock.calls[0]).toEqual([
            `/api/agents/${AGENT}/computer/profile?nodeId=${NODE}`,
            { method: 'GET' },
        ]);

        answer(json(200, view));
        await waitFor(() =>
            expect(screen.getByTestId('computer-profile-description')).toHaveTextContent(
                'profile.body:Ops,studio-imac',
            ),
        );
        expect(screen.getByTestId('computer-profile-facts')).toBeInTheDocument();
        expect(screen.getByText('profile.resetAction')).toBeInTheDocument();
    });

    it('says "not used yet" only when the platform says the profile does not exist', async () => {
        const fetchImpl = vi.fn(async () => json(404, { reason: 'profile-not-found' }));
        renderPanel({ fetchImpl: fetchImpl as unknown as typeof fetch });
        await waitFor(() =>
            expect(screen.getByTestId('computer-profile-description')).toHaveTextContent(
                'profile.notYet:Ops,studio-imac',
            ),
        );
        expect(screen.queryByText('profile.resetAction')).not.toBeInTheDocument();
    });

    it('says it could not tell when the read fails, and reads again on request', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(json(500, { message: 'boom' }))
            .mockResolvedValueOnce(json(200, view));
        renderPanel({ fetchImpl: fetchImpl as unknown as typeof fetch });
        await waitFor(() =>
            expect(screen.getByTestId('computer-profile-description')).toHaveTextContent(
                'profile.unknown:Ops,studio-imac',
            ),
        );
        expect(screen.queryByText(/profile\.notYet/)).not.toBeInTheDocument();

        await userEvent.click(screen.getByText('profile.tryAgain'));
        await waitFor(() =>
            expect(screen.getByTestId('computer-profile-description')).toHaveTextContent(
                'profile.body:Ops,studio-imac',
            ),
        );
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('does not read anything until the panel is opened', () => {
        const fetchImpl = vi.fn();
        renderPanel({ open: false, fetchImpl: fetchImpl as never });
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
