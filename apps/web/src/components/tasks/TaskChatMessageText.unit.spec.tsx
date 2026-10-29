import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../../../messages/en.json';
import { TaskChatMessageText } from './TaskChatMessageText';

/**
 * APW-08 T54 (FR-43, ACC-08-24 keyed half) — a keyed Task-thread post renders in the READER's
 * locale, and everything that cannot be rendered faithfully falls back to the stored English
 * `body`.
 */

type Message = { body: string; messageKey?: string | null; messageParams?: Record<string, string | number> | null };

/** A locale bundle whose deliveryPosts differ from English, to prove the KEY is what renders. */
const de = {
    ...en,
    dashboard: {
        ...en.dashboard,
        tasksPage: {
            ...en.dashboard.tasksPage,
            deliveryPosts: {
                ...en.dashboard.tasksPage.deliveryPosts,
                live: 'Live unter {url}.',
                buildSucceeded: 'Build #{number} erfolgreich.',
                deployFailed: 'Bereitstellung fehlgeschlagen: {outcome}.',
            },
            delivery: {
                ...en.dashboard.tasksPage.delivery,
                outcome: { ...en.dashboard.tasksPage.delivery.outcome, rolledBack: 'zurückgesetzt' },
            },
        },
    },
};

function show(message: Message, locale: 'en' | 'de' = 'de') {
    return render(
        <NextIntlClientProvider
            locale={locale}
            messages={locale === 'de' ? de : en}
            timeZone="UTC"
            onError={() => undefined}
        >
            <p data-testid="text">
                <TaskChatMessageText message={message} />
            </p>
        </NextIntlClientProvider>,
    );
}

const text = () => screen.getByTestId('text').textContent;

afterEach(cleanup);

describe('TaskChatMessageText (APW-08 T54)', () => {
    it("renders a stored key in the reader's locale, with its params", () => {
        show({
            body: 'Live at https://bookings.example.app.',
            messageKey: 'deliveryPosts.live',
            messageParams: { url: 'https://bookings.example.app' },
        });
        expect(text()).toBe('Live unter https://bookings.example.app.');
    });

    it('renders a number param and maps an outcome code through the delivery outcome copy', () => {
        show({ body: 'x', messageKey: 'deliveryPosts.buildSucceeded', messageParams: { number: 12 } });
        expect(text()).toBe('Build #12 erfolgreich.');
        cleanup();
        show({
            body: 'Deployment failed: rolled back.',
            messageKey: 'deliveryPosts.deployFailed',
            messageParams: { outcome: 'rolled_back' },
        });
        expect(text()).toBe('Bereitstellung fehlgeschlagen: zurückgesetzt.');
    });

    it('renders the English copy for an English reader', () => {
        show({ body: 'ignored', messageKey: 'deliveryPosts.deploying' }, 'en');
        expect(text()).toBe('Deploying.');
    });

    it('a message without a key shows its body exactly as before', () => {
        show({ body: 'Please add an SMS reminder.\nThanks', messageKey: null, messageParams: null });
        expect(text()).toBe('Please add an SMS reminder.\nThanks');
    });

    it.each([
        ['a key this build does not have', { messageKey: 'deliveryPosts.somethingNew' }],
        ['a key outside deliveryPosts', { messageKey: 'detail.conversation' }],
        ['a malformed key', { messageKey: 'deliveryPosts.live.extra' }],
        ['a missing placeholder value', { messageKey: 'deliveryPosts.live', messageParams: {} }],
    ])('falls back to the English body for %s', (_label, keyed) => {
        show({ body: 'Live at https://bookings.example.app.', ...keyed });
        expect(text()).toBe('Live at https://bookings.example.app.');
    });
});
