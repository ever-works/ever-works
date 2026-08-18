import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import messages from '../../../messages/en.json';
import { MeetingForm } from './MeetingForm';

/**
 * MeetingForm — the `/meetings/new` capture form's rendered contract.
 *
 * This spec deliberately mirrors, assertion for assertion, the e2e test
 * `flow-meetings-ui-journey.spec.ts › "the capture form renders its sections,
 * fields and actions"`. That test had been red on `stage` for days because the
 * roster section lost its heading when the structured editor replaced the old
 * textarea (a2791b66), and nothing caught it: the e2e suite runs ONLY on a
 * `stage` push, so the regression could not fail a PR.
 *
 * Two consequences shaped how this file is written:
 *
 *  1. Translations resolve from the REAL `messages/en.json`, not the usual
 *     echo-the-key mock. The e2e test asserts on user-visible English
 *     ("Participants", "Where it came from", "Title"), so a spec that echoed
 *     keys would pass while a missing or misspelled key shipped.
 *  2. Every assertion the e2e makes is repeated here, not just the heading
 *     that regressed. The e2e failed on its THIRD assertion, which means the
 *     nine after it had not executed in days — this pins all of them.
 */

/** Resolve `t('a.b')` against a namespace of the real message catalogue. */
function translator(namespace: string) {
    return (key: string) => {
        const path = `${namespace}.${key}`.split('.');
        let node: unknown = messages;
        for (const segment of path) {
            if (typeof node !== 'object' || node === null) return path.join('.');
            node = (node as Record<string, unknown>)[segment];
        }
        return typeof node === 'string' ? node : path.join('.');
    };
}

vi.mock('next-intl', () => ({
    useTranslations: (namespace: string) => translator(namespace),
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('./actions', () => ({
    createMeetingAction: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

describe('MeetingForm — capture form contract', () => {
    it('renders its three section headings, every field, and both actions', () => {
        render(<MeetingForm />);

        // Sections. "Participants" is the one that regressed: the roster's
        // label is promoted to an h2 so the section is a peer of the other two
        // rather than the only unlabelled one.
        expect(screen.getByRole('heading', { level: 1, name: 'New meeting' })).toBeVisible();
        expect(screen.getByRole('heading', { name: 'Where it came from' })).toBeVisible();
        expect(screen.getByRole('heading', { name: 'Participants' })).toBeVisible();
        expect(screen.getByRole('heading', { name: 'Transcript' })).toBeVisible();

        // Fields.
        expect(screen.getByLabelText('Title')).toBeVisible();
        expect(screen.getByTestId('meeting-started-at')).toBeVisible();
        expect(screen.getByTestId('meeting-ended-at')).toBeVisible();
        expect(screen.getByTestId('meeting-source-select')).toBeVisible();
        expect(screen.getByTestId('meeting-edit-participants')).toBeVisible();
        expect(screen.getByTestId('meeting-transcript-input')).toBeVisible();

        // Actions.
        expect(screen.getByTestId('meeting-create-submit')).toBeVisible();
        expect(screen.getByRole('link', { name: 'Cancel' })).toBeVisible();
    });

    it('prints "Participants" exactly once — the heading IS the roster label', () => {
        render(<MeetingForm />);

        expect(screen.getAllByText('Participants')).toHaveLength(1);
    });
});
