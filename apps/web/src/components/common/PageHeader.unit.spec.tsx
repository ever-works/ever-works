import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Sparkles } from 'lucide-react';
import { PageHeader } from './PageHeader';

/**
 * The heading level is load-bearing: `PageHeader` is the page title on every
 * dashboard index, but the navigation consolidation also renders it as a
 * *block* header inside another page (the Skills block on the Agents tab),
 * where a second `h1` would break the document outline. Lock both branches.
 */
describe('PageHeader', () => {
    it('renders the title as an h1 by default', () => {
        render(<PageHeader icon={Sparkles} title="Skills" subtitle="Reusable instructions" />);
        expect(screen.getByRole('heading', { level: 1, name: 'Skills' })).toBeTruthy();
        expect(screen.getByText('Reusable instructions')).toBeTruthy();
    });

    it('renders the title as an h2 when nested in a page that already has an h1', () => {
        render(<PageHeader icon={Sparkles} title="Skills" as="h2" />);
        expect(screen.getByRole('heading', { level: 2, name: 'Skills' })).toBeTruthy();
        expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    });
});
