import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

import { CreationBlockTrio } from './CreationBlockTrio';

/**
 * Phase 6.5 PR CC1 — locks the byte-identical render of the
 * extracted CreationBlockTrio (Decision A11). The /works/new
 * page renders the legacy label set verbatim, so this spec
 * snapshots the legacy branch + sanity-checks the unified
 * branch's label-source swap that PR CC2's /new page will
 * consume.
 */
describe('CreationBlockTrio (Phase 6.5 PR CC1)', () => {
    it('renders three mode cards under the legacy label set', () => {
        const { container } = render(<CreationBlockTrio onSelect={() => undefined} />);
        // Three top-level buttons (one per card).
        const buttons = container.querySelectorAll('button');
        expect(buttons).toHaveLength(3);
        // Legacy bundle keys surfaced.
        expect(screen.getByText('dashboard.workCreation.ai.title')).toBeTruthy();
        expect(screen.getByText('dashboard.workCreation.manual.title')).toBeTruthy();
        expect(screen.getByText('dashboard.workCreation.import.title')).toBeTruthy();
        // Legacy CTAs are the kind-specific strings ("getStarted",
        // "configureNow", "importNow") rather than a uniform label.
        expect(screen.getByText('dashboard.workCreation.ai.getStarted')).toBeTruthy();
        expect(screen.getByText('dashboard.workCreation.manual.configureNow')).toBeTruthy();
        expect(screen.getByText('dashboard.workCreation.import.importNow')).toBeTruthy();
    });

    it('renders the unified label set under labelSet="unified"', () => {
        render(<CreationBlockTrio onSelect={() => undefined} labelSet="unified" />);
        expect(screen.getByText('dashboard.newPage.cards.ai.title')).toBeTruthy();
        expect(screen.getByText('dashboard.newPage.cards.manual.title')).toBeTruthy();
        expect(screen.getByText('dashboard.newPage.cards.import.title')).toBeTruthy();
        // Unified bundle uses a uniform "cta" key per card.
        expect(screen.getByText('dashboard.newPage.cards.ai.cta')).toBeTruthy();
        expect(screen.getByText('dashboard.newPage.cards.manual.cta')).toBeTruthy();
        expect(screen.getByText('dashboard.newPage.cards.import.cta')).toBeTruthy();
    });

    it('clicking a card calls onSelect with the correct mode', () => {
        const onSelect = vi.fn();
        render(<CreationBlockTrio onSelect={onSelect} />);
        fireEvent.click(screen.getByText('dashboard.workCreation.ai.title').closest('button')!);
        expect(onSelect).toHaveBeenCalledWith('ai');
        fireEvent.click(screen.getByText('dashboard.workCreation.manual.title').closest('button')!);
        expect(onSelect).toHaveBeenCalledWith('manual');
        fireEvent.click(screen.getByText('dashboard.workCreation.import.title').closest('button')!);
        expect(onSelect).toHaveBeenCalledWith('import');
    });

    it('locks the rendered markup (Decision A11 byte-identical)', () => {
        const { container } = render(<CreationBlockTrio onSelect={() => undefined} />);
        expect(container.firstChild).toMatchSnapshot();
    });
});
