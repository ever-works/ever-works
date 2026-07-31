import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({
        href,
        children,
        ...rest
    }: {
        href: string;
        children: React.ReactNode;
    } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
    toast: {
        success: (...args: unknown[]) => toastSuccess(...args),
        error: (...args: unknown[]) => toastError(...args),
    },
}));

const attachMock = vi.fn();
const detachMock = vi.fn();
vi.mock('@/app/actions/dashboard/mission-works', () => ({
    attachWorkToMissionAction: (...args: unknown[]) => attachMock(...args),
    detachWorkFromMissionAction: (...args: unknown[]) => detachMock(...args),
}));

// Stub the `Select` primitive with a native <select> — the real one is
// a portal-rendered custom listbox, and this spec is about the panel's
// wiring, not the picker's internals (same convention as
// GithubRepoWidgets.unit.spec.tsx).
vi.mock('@/components/ui/select', () => ({
    Select: ({
        value,
        children,
        onValueChange,
        ...rest
    }: {
        value: string;
        children: React.ReactNode;
        onValueChange: (v: string) => void;
    } & Record<string, unknown>) => (
        <select
            data-testid={rest['data-testid'] as string}
            value={value}
            onChange={(e) => onValueChange(e.currentTarget.value)}
        >
            <option value="" />
            {children}
        </select>
    ),
}));

import { MissionAttachedWorksPanel } from './MissionAttachedWorksPanel';
import type { MissionWorkRelationDto } from '@/lib/api/missions';

function mkRelation(overrides: Partial<MissionWorkRelationDto> = {}): MissionWorkRelationDto {
    return {
        id: 'e1',
        missionId: 'm1',
        workId: 'w1',
        relation: 'improves',
        createdAt: '2026-01-01T00:00:00.000Z',
        workName: 'Cat Directory',
        workSlug: 'cat-directory',
        ...overrides,
    };
}

function iconKeys(testId: string): (string | null)[] {
    const select = screen.getByTestId(testId);
    return Array.from(select.querySelectorAll('option[value]'))
        .filter((o) => o.getAttribute('value'))
        .map((o) => o.getAttribute('data-icon'));
}

describe('MissionAttachedWorksPanel', () => {
    beforeEach(() => {
        attachMock.mockReset();
        detachMock.mockReset();
        toastSuccess.mockReset();
        toastError.mockReset();
    });

    it('keys each Work option off its normalized kind', () => {
        render(
            <MissionAttachedWorksPanel
                missionId="m1"
                initialRelations={[]}
                attachableWorks={[
                    { id: 'w1', name: 'Cat Directory', kind: 'directory' },
                    { id: 'w2', name: 'Cat Blog', kind: 'blog' },
                    // Unknown + absent kinds both degrade to the generic
                    // presentation rather than rendering no icon.
                    { id: 'w3', name: 'Legacy', kind: 'not-a-kind' },
                    { id: 'w4', name: 'Older still' },
                ]}
            />,
        );
        expect(iconKeys('mission-attach-work-select')).toEqual([
            'directory',
            'blog',
            'default',
            'default',
        ]);
    });

    it('gives every relation option its own icon key', () => {
        render(
            <MissionAttachedWorksPanel
                missionId="m1"
                initialRelations={[]}
                attachableWorks={[{ id: 'w1', name: 'Cat Directory' }]}
            />,
        );
        expect(iconKeys('mission-attach-relation-select')).toEqual([
            'created',
            'improves',
            'operates',
            'markets',
            'researches',
            'retires',
        ]);
    });

    it('attaches the selected Work with the chosen relation', async () => {
        attachMock.mockResolvedValue([mkRelation({ relation: 'operates' })]);
        render(
            <MissionAttachedWorksPanel
                missionId="m1"
                initialRelations={[]}
                attachableWorks={[{ id: 'w1', name: 'Cat Directory', kind: 'directory' }]}
            />,
        );

        fireEvent.change(screen.getByTestId('mission-attach-work-select'), {
            target: { value: 'w1' },
        });
        fireEvent.change(screen.getByTestId('mission-attach-relation-select'), {
            target: { value: 'operates' },
        });
        fireEvent.click(screen.getByTestId('mission-attach-work-submit'));

        await waitFor(() =>
            expect(attachMock).toHaveBeenCalledWith('m1', {
                workId: 'w1',
                relation: 'operates',
            }),
        );
        await waitFor(() =>
            expect(
                screen.getByTestId('mission-attached-works-row-w1-operates'),
            ).toBeInTheDocument(),
        );
        expect(toastSuccess).toHaveBeenCalledWith('toasts.attached');
    });

    it('defaults the relation to improves', async () => {
        attachMock.mockResolvedValue([mkRelation()]);
        render(
            <MissionAttachedWorksPanel
                missionId="m1"
                initialRelations={[]}
                attachableWorks={[{ id: 'w1', name: 'Cat Directory' }]}
            />,
        );

        fireEvent.change(screen.getByTestId('mission-attach-work-select'), {
            target: { value: 'w1' },
        });
        fireEvent.click(screen.getByTestId('mission-attach-work-submit'));

        await waitFor(() =>
            expect(attachMock).toHaveBeenCalledWith('m1', {
                workId: 'w1',
                relation: 'improves',
            }),
        );
    });

    it('renders the truncation hint outside the control row only past 100 Works', () => {
        const many = Array.from({ length: 100 }, (_, i) => ({
            id: `w${i}`,
            name: `Work ${i}`,
        }));
        const { rerender } = render(
            <MissionAttachedWorksPanel
                missionId="m1"
                initialRelations={[]}
                attachableWorks={many.slice(0, 99)}
            />,
        );
        expect(screen.queryByText('pickerTruncated')).toBeNull();

        rerender(
            <MissionAttachedWorksPanel
                missionId="m1"
                initialRelations={[]}
                attachableWorks={many}
            />,
        );
        const hint = screen.getByText('pickerTruncated');
        expect(hint).toBeInTheDocument();
        // The hint must NOT sit inside the select's <label> — that is what
        // knocked the row out of alignment.
        expect(hint.closest('label')).toBeNull();
    });

    it('disables the submit button until a Work is selected', () => {
        render(
            <MissionAttachedWorksPanel
                missionId="m1"
                initialRelations={[]}
                attachableWorks={[{ id: 'w1', name: 'Cat Directory' }]}
            />,
        );
        expect(screen.getByTestId('mission-attach-work-submit')).toBeDisabled();
    });

    it('asks in a dialog before detaching, never a window.confirm', async () => {
        const nativeConfirm = vi.spyOn(window, 'confirm');
        render(
            <MissionAttachedWorksPanel
                missionId="m1"
                initialRelations={[mkRelation()]}
                attachableWorks={[{ id: 'w1', name: 'Cat Directory' }]}
            />,
        );

        expect(screen.queryByTestId('mission-attached-works-detach-confirm')).toBeNull();
        fireEvent.click(screen.getByTestId('mission-attached-works-detach-w1-improves'));

        await waitFor(() =>
            expect(screen.getByTestId('mission-attached-works-detach-confirm')).toBeInTheDocument(),
        );
        expect(screen.getByText('detachDialog.title')).toBeInTheDocument();
        expect(nativeConfirm).not.toHaveBeenCalled();
        expect(detachMock).not.toHaveBeenCalled();
        nativeConfirm.mockRestore();
    });

    it('detaches the edge once confirmed and leaves sibling edges alone', async () => {
        detachMock.mockResolvedValue({ deleted: true });
        render(
            <MissionAttachedWorksPanel
                missionId="m1"
                initialRelations={[
                    mkRelation(),
                    // Same Work, different relation — a distinct edge that
                    // must survive detaching the first.
                    mkRelation({ id: 'e2', relation: 'operates' }),
                ]}
                attachableWorks={[{ id: 'w1', name: 'Cat Directory' }]}
            />,
        );

        fireEvent.click(screen.getByTestId('mission-attached-works-detach-w1-improves'));
        fireEvent.click(await screen.findByTestId('mission-attached-works-detach-confirm'));

        await waitFor(() => expect(detachMock).toHaveBeenCalledWith('m1', 'w1', 'improves'));
        await waitFor(() =>
            expect(screen.queryByTestId('mission-attached-works-row-w1-improves')).toBeNull(),
        );
        expect(screen.getByTestId('mission-attached-works-row-w1-operates')).toBeInTheDocument();
        expect(toastSuccess).toHaveBeenCalledWith('toasts.detached');
    });

    it('does nothing when the detach dialog is cancelled', async () => {
        render(
            <MissionAttachedWorksPanel
                missionId="m1"
                initialRelations={[mkRelation()]}
                attachableWorks={[{ id: 'w1', name: 'Cat Directory' }]}
            />,
        );

        fireEvent.click(screen.getByTestId('mission-attached-works-detach-w1-improves'));
        fireEvent.click(await screen.findByTestId('mission-attached-works-detach-cancel'));

        expect(detachMock).not.toHaveBeenCalled();
        expect(screen.getByTestId('mission-attached-works-row-w1-improves')).toBeInTheDocument();
    });

    it('keeps the row and shows the error in the dialog when detaching fails', async () => {
        detachMock.mockRejectedValue(new Error('locked'));
        render(
            <MissionAttachedWorksPanel
                missionId="m1"
                initialRelations={[mkRelation()]}
                attachableWorks={[{ id: 'w1', name: 'Cat Directory' }]}
            />,
        );

        fireEvent.click(screen.getByTestId('mission-attached-works-detach-w1-improves'));
        fireEvent.click(await screen.findByTestId('mission-attached-works-detach-confirm'));

        await waitFor(() => expect(toastError).toHaveBeenCalledWith('locked'));
        expect(screen.getByTestId('mission-attached-works-detach-error')).toHaveTextContent(
            'locked',
        );
        expect(screen.getByTestId('mission-attached-works-row-w1-improves')).toBeInTheDocument();
    });
});
