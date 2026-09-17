import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../../messages/en.json';

vi.mock('@/i18n/navigation', () => ({
    Link: ({
        href,
        children,
        ...rest
    }: { href: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

import { CatalogPager } from './CatalogPager';
import { catalogHref, catalogPageWindow } from './workflow-pages';

function renderPager(input: { offset: number; itemCount: number; total: number }) {
    const page = catalogPageWindow({ ...input, pageSize: 50 });
    return render(
        <NextIntlClientProvider locale="en" messages={messages}>
            <CatalogPager
                page={page}
                label="Workflow pages"
                testId="pager"
                previousHref={
                    page.previousOffset === null
                        ? null
                        : catalogHref('/catalog/workflows', { offset: page.previousOffset })
                }
                nextHref={
                    page.nextOffset === null
                        ? null
                        : catalogHref('/catalog/workflows', { offset: page.nextOffset })
                }
            />
        </NextIntlClientProvider>,
    );
}

describe('CatalogPager', () => {
    it('links a full first page to the workflows that did not fit', () => {
        renderPager({ offset: 0, itemCount: 50, total: 51 });
        const nav = screen.getByRole('navigation', { name: 'Workflow pages' });
        expect(nav).toHaveTextContent('Showing 1–50 of 51');
        expect(screen.getByRole('link', { name: 'Next' })).toHaveAttribute(
            'href',
            '/catalog/workflows?offset=50',
        );
        expect(screen.queryByRole('link', { name: 'Previous' })).toBeNull();
    });

    it('links the last page back to the first', () => {
        renderPager({ offset: 50, itemCount: 1, total: 51 });
        expect(screen.getByTestId('pager')).toHaveTextContent('Showing 51–51 of 51');
        expect(screen.getByRole('link', { name: 'Previous' })).toHaveAttribute(
            'href',
            '/catalog/workflows',
        );
        expect(screen.queryByRole('link', { name: 'Next' })).toBeNull();
    });

    it('says a page past the end is empty and still links back', () => {
        renderPager({ offset: 200, itemCount: 0, total: 51 });
        expect(screen.getByTestId('pager')).toHaveTextContent('Nothing on this page.');
        expect(screen.getByRole('link', { name: 'Previous' })).toHaveAttribute(
            'href',
            '/catalog/workflows?offset=50',
        );
    });

    it('renders nothing when everything fits on one page', () => {
        renderPager({ offset: 0, itemCount: 3, total: 3 });
        expect(screen.queryByTestId('pager')).toBeNull();
    });
});
