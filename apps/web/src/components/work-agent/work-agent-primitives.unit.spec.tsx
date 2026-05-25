import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LiveRun } from './live-run';
import { LogList } from './log-list';
import { Metric } from './metric';
import { MoneyField } from './money-field';
import { NumberField } from './number-field';
import { StatusPill, STATUS_STYLES } from './status-pill';
import { ToggleRow } from './toggle-row';
import type { WorkAgentRun, WorkAgentRunLog } from '@/lib/api/work-agent';

/**
 * Phase 4 PR K — first snapshot tests for apps/web (Decision A10).
 *
 * Every primitive extracted from `WorkAgentSettings.tsx` is locked
 * to a snapshot here so any subsequent PR that changes the
 * component's output (intentional restyle, prop addition, etc.)
 * shows up as a diff in code review instead of slipping in
 * silently. PR L will piggyback on this when it adds the four
 * promoted-constant NumberField rows; PR EE when it adds the
 * auto-retry + account-budget sub-sections.
 *
 * We use `toMatchInlineSnapshot()` so the expected HTML lives next
 * to each test — easier to review than a separate `__snapshots__/`
 * file, and small enough at this scale (each primitive renders
 * ~5 lines of markup). Once a snapshot drifts beyond a few lines
 * we'll migrate that one assertion to a file snapshot.
 */
describe('work-agent primitives — snapshot lock', () => {
    it('ToggleRow renders the expected label + checkbox markup', () => {
        const { container } = render(
            <ToggleRow label="Auto-build works" checked={true} onChange={() => undefined} />,
        );
        expect(container.firstChild).toMatchInlineSnapshot(`
          <label
            class="inline-flex items-center gap-2.5 cursor-pointer select-none"
          >
            <input
              checked=""
              class="rounded border-border dark:border-border-dark"
              type="checkbox"
            />
            <span
              class="text-xs text-text-secondary dark:text-text-secondary-dark"
            >
              Auto-build works
            </span>
          </label>
        `);
    });

    it('ToggleRow propagates the new checked state on toggle', async () => {
        const onChange = vi.fn();
        const { container } = render(<ToggleRow label="x" checked={false} onChange={onChange} />);
        const checkbox = container.querySelector('input[type="checkbox"]');
        if (!checkbox) throw new Error('missing checkbox');
        await userEvent.click(checkbox);
        expect(onChange).toHaveBeenCalledWith(true);
    });

    it('NumberField renders min/max bounds + the current value', () => {
        const { container } = render(
            <NumberField label="Max works" value={5} min={1} max={25} onChange={() => undefined} />,
        );
        expect(container.firstChild).toMatchInlineSnapshot(`
          <label
            class="space-y-1.5"
          >
            <span
              class="text-xs text-text-muted dark:text-text-muted-dark"
            >
              Max works
            </span>
            <input
              class="w-full h-9 rounded-lg border border-border dark:border-border-dark bg-background dark:bg-background-dark px-3 text-sm text-text dark:text-text-dark outline-none focus:ring-2 focus:ring-primary/25"
              max="25"
              min="1"
              type="number"
              value="5"
            />
          </label>
        `);
    });

    it('MoneyField converts cents → dollars on render', () => {
        const { container } = render(
            <MoneyField label="Budget" cents={2500} onChange={() => undefined} />,
        );
        const input = container.querySelector('input[type="number"]') as HTMLInputElement;
        // 2500 cents → 25 dollars.
        expect(input.value).toBe('25');
    });

    it('MoneyField converts dollars → cents on change', () => {
        // The component is controlled; the input's displayed value only
        // updates when the parent re-renders with new `cents`. So we
        // verify the conversion formula by firing one programmatic
        // change event (the formula is what we care about — userEvent
        // char-by-char typing would interact with the controlled value
        // reset and obscure the unit-conversion contract).
        const onChange = vi.fn();
        const { container } = render(<MoneyField label="x" cents={0} onChange={onChange} />);
        const input = container.querySelector('input[type="number"]') as HTMLInputElement;
        fireEvent.change(input, { target: { value: '50' } });
        expect(onChange).toHaveBeenCalledWith(5000);
    });

    it('StatusPill renders a colored pill for the given status', () => {
        const { container } = render(<StatusPill status="running" />);
        expect(container.firstChild).toMatchInlineSnapshot(`
          <span
            class="shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize bg-info/10 text-info border-info/20"
          >
            running
          </span>
        `);
    });

    it('StatusPill replaces hyphens with spaces for human-readable display', () => {
        const { container } = render(<StatusPill status="waiting-for-approval" />);
        expect(container.textContent).toBe('waiting for approval');
    });

    it('StatusPill falls back to the neutral style for unknown statuses', () => {
        const { container } = render(<StatusPill status="bogus-status-not-in-map" />);
        const span = container.firstChild as HTMLElement;
        expect(span.className).toContain('bg-surface-secondary text-text-muted');
    });

    it('STATUS_STYLES covers every status the API surfaces today', () => {
        // Lock the set of known statuses so additions force an explicit
        // pill-color decision (and a test update) rather than silently
        // falling through to the neutral default.
        expect(Object.keys(STATUS_STYLES).sort()).toEqual([
            'canceled',
            'completed',
            'failed',
            'generating',
            'pending',
            'queued',
            'researching',
            'running',
            'waiting-for-approval',
            'writing',
        ]);
    });

    it('Metric renders the labeled counter card', () => {
        const { container } = render(<Metric label="Works" value={3} />);
        expect(container.firstChild).toMatchInlineSnapshot(`
          <div
            class="rounded-lg border border-border/60 dark:border-border-dark/60 p-2"
          >
            <div
              class="text-[11px] text-text-muted dark:text-text-muted-dark"
            >
              Works
            </div>
            <div
              class="text-sm font-semibold text-text dark:text-text-dark"
            >
              3
            </div>
          </div>
        `);
    });

    it('LogList renders the empty-state message when logs is empty', () => {
        const { container } = render(<LogList logs={[]} emptyText="Waiting…" />);
        expect(container.firstChild).toMatchInlineSnapshot(`
          <p
            class="text-xs text-text-muted dark:text-text-muted-dark"
          >
            Waiting…
          </p>
        `);
    });

    it('LogList renders only the last 6 entries (oldest pruned)', () => {
        const logs: WorkAgentRunLog[] = Array.from({ length: 8 }, (_, i) => ({
            id: `log-${i}`,
            step: `step-${i}`,
            message: `message ${i}`,
        })) as unknown as WorkAgentRunLog[];
        const { container } = render(<LogList logs={logs} emptyText="x" />);
        const stepLabels = Array.from(container.querySelectorAll('.text-\\[11px\\].uppercase')).map(
            (el) => el.textContent,
        );
        expect(stepLabels).toEqual(['step-2', 'step-3', 'step-4', 'step-5', 'step-6', 'step-7']);
    });

    it('LiveRun renders only the no-run empty state when activeRun is null', () => {
        const { container } = render(
            <LiveRun
                activeRun={null}
                logs={[]}
                labels={{
                    worksMetric: 'Works',
                    itemsMetric: 'Items',
                    emptyWaitingForUpdate: 'Waiting…',
                    emptyNoActiveRun: 'No active run.',
                }}
            />,
        );
        expect(container.firstChild).toMatchInlineSnapshot(`
          <p
            class="text-sm text-text-muted dark:text-text-muted-dark"
          >
            No active run.
          </p>
        `);
    });

    it('LiveRun renders status + progress + metrics + log list when a run is active', () => {
        const activeRun = {
            status: 'running',
            progressPercent: 40,
            summary: { worksCreated: 2, itemsCreated: 11 },
        } as unknown as WorkAgentRun;
        const { container } = render(
            <LiveRun
                activeRun={activeRun}
                logs={[]}
                labels={{
                    worksMetric: 'Works',
                    itemsMetric: 'Items',
                    emptyWaitingForUpdate: 'Waiting for update.',
                    emptyNoActiveRun: 'No active run.',
                }}
            />,
        );
        // Status pill rendered.
        expect(container.querySelector('span.rounded-full')?.textContent).toBe('running');
        // Progress percent text rendered.
        expect(container.textContent).toContain('40%');
        // Progress bar width style set from progressPercent.
        const bar = container.querySelector('div.bg-primary') as HTMLElement;
        expect(bar.style.width).toBe('40%');
        // Both metric labels + values present.
        expect(container.textContent).toContain('Works');
        expect(container.textContent).toContain('2');
        expect(container.textContent).toContain('Items');
        expect(container.textContent).toContain('11');
        // Empty-update text rendered (logs=[]).
        expect(container.textContent).toContain('Waiting for update.');
    });
});
