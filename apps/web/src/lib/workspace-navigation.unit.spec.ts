import { describe, expect, it, vi } from 'vitest';
import { navigateToWorkspaceDashboard } from './workspace-navigation';

describe('navigateToWorkspaceDashboard', () => {
    it('performs a canonical same-origin document navigation for an Organization', () => {
        const assign = vi.fn();

        navigateToWorkspaceDashboard(
            { kind: 'organization', slug: 'ever' },
            { origin: 'https://works.example', assign },
        );

        expect(assign).toHaveBeenCalledWith('https://works.example/org/ever/dashboard');
    });

    it('uses the explicit unprefixed personal dashboard contract', () => {
        const assign = vi.fn();

        navigateToWorkspaceDashboard(
            { kind: 'personal' },
            { origin: 'https://works.example', assign },
        );

        expect(assign).toHaveBeenCalledWith('https://works.example/dashboard');
    });
});
