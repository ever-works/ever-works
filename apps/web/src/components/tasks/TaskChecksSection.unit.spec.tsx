import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));
vi.mock('@/app/actions/tasks', () => ({ updateTaskAction: vi.fn() }));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
    // `@/components/ui/button` re-wraps `Link` from the same module.
    Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock('./GateChip', () => ({ GateChip: () => null }));
vi.mock('./ChecksEditor', () => ({ ChecksEditor: () => null }));

import { TaskChecksSection } from './TaskChecksSection';

/**
 * APW-08 T51 (FR-61, S36) — a check whose tool is missing on the Fleet node reads as that, not as
 * a plain "Error": the gate row says "a tool this check needs is missing on this machine".
 */
describe('TaskChecksSection — the missing-tool row (APW-08 T51)', () => {
    const check = { id: 'repo/check-1', name: 'type-check', kind: 'command', command: 'cargo test' };

    function renderWith(result: Record<string, unknown>) {
        return render(
            <TaskChecksSection
                task={{ id: 't1', acceptanceChecks: [check] } as never}
                initialGateRun={
                    {
                        resolvedChecks: [check],
                        checkResults: [{ id: 'repo/check-1', durationMs: 5, ...result }],
                    } as never
                }
            />,
        );
    }

    it('an `error` with reason missingTool reads as a missing tool', () => {
        renderWith({ status: 'error', exitCode: 127, reason: 'missingTool' });
        expect(screen.getByText('result.missingTool')).toBeTruthy();
        expect(screen.queryByText('result.error')).toBeNull();
    });

    it('any other `error`, and a red, keep their own labels', () => {
        const { unmount } = renderWith({ status: 'error', exitCode: null });
        expect(screen.getByText('result.error')).toBeTruthy();
        expect(screen.queryByText('result.missingTool')).toBeNull();
        unmount();
        renderWith({ status: 'red', exitCode: 1 });
        expect(screen.getByText('result.red')).toBeTruthy();
    });
});
