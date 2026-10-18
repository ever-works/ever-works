import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

vi.mock('@/app/actions/record-visibility', () => ({
    getRecordVisibilityAction: vi.fn(),
    setRecordVisibilityResultAction: vi.fn(),
}));

import { VisibilityControl } from './VisibilityControl';

/**
 * Review 2026-10-17 U4: the "Automatic" option names the automatic value only while the
 * record has it. On a record set to Private by hand it said "Automatic (Private)", but
 * choosing it opens an organization record to its Team or the whole organization.
 */
describe('VisibilityControl — the Automatic option', () => {
    const show = (visibilityExplicit: boolean) =>
        render(
            <NextIntlClientProvider locale="en" messages={messages}>
                <VisibilityControl
                    aggregate="task"
                    id="task-1"
                    initial={{
                        visibility: 'private',
                        visibilityExplicit,
                        teamIds: [],
                        canEdit: true,
                    }}
                />
            </NextIntlClientProvider>,
        );

    it('is plain "Automatic" when a value was picked by hand', () => {
        show(true);
        const options = screen.getAllByRole('option').map((option) => option.textContent);
        expect(options).toContain('Automatic');
        expect(options).not.toContain('Automatic (Private)');
    });

    it('names the value while the record is automatic', () => {
        show(false);
        const options = screen.getAllByRole('option').map((option) => option.textContent);
        expect(options).toContain('Automatic (Private)');
    });
});
