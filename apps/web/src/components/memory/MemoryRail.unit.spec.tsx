import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

import { MEMORY_RAIL_SECTIONS, MemoryRail } from './MemoryRail';

describe('MemoryRail', () => {
    afterEach(() => {
        cleanup();
        document.body.innerHTML = '';
    });

    const counts = { active: 182, pinned: 6, proposed: 12, forgotten: 4 };

    it('lists the four fact views with their counts and marks the selected one', () => {
        render(<MemoryRail counts={counts} view="pinned" onSelectView={vi.fn()} />);
        expect(screen.getByTestId('memory-rail-count-all')).toHaveTextContent('182');
        expect(screen.getByTestId('memory-rail-count-pinned')).toHaveTextContent('6');
        expect(screen.getByTestId('memory-rail-count-proposed')).toHaveTextContent('12');
        expect(screen.getByTestId('memory-rail-count-forgotten')).toHaveTextContent('4');
        expect(screen.getByTestId('memory-rail-view-pinned')).toHaveAttribute(
            'aria-selected',
            'true',
        );
        expect(screen.getByTestId('memory-rail-view-all')).toHaveAttribute(
            'aria-selected',
            'false',
        );
    });

    it('selects a view', () => {
        const onSelectView = vi.fn();
        render(<MemoryRail counts={counts} view="all" onSelectView={onSelectView} />);
        fireEvent.click(screen.getByTestId('memory-rail-view-forgotten'));
        expect(onSelectView).toHaveBeenCalledWith('forgotten');
    });

    it('keeps every existing panel reachable under "Also here"', () => {
        render(<MemoryRail counts={counts} view="all" onSelectView={vi.fn()} />);
        for (const key of ['review', 'files', 'uploads', 'agentMemory', 'meetings', 'settings']) {
            expect(screen.getByTestId(`memory-rail-jump-${key}`)).toBeInTheDocument();
        }
        expect(MEMORY_RAIL_SECTIONS).toHaveLength(6);
    });

    it('jumps to a panel by the test id it already renders, and skips an absent one', () => {
        const files = document.createElement('div');
        files.setAttribute('data-testid', 'memory-files-panel');
        const scrollIntoView = vi.fn();
        files.scrollIntoView = scrollIntoView;
        document.body.appendChild(files);

        render(<MemoryRail counts={counts} view="all" onSelectView={vi.fn()} />);
        fireEvent.click(screen.getByTestId('memory-rail-jump-files'));
        expect(scrollIntoView).toHaveBeenCalledTimes(1);

        // The review queue hides itself when empty — clicking must not throw.
        expect(() => fireEvent.click(screen.getByTestId('memory-rail-jump-review'))).not.toThrow();
    });
});
