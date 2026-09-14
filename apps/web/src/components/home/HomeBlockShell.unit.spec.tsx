import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { CalendarClock } from 'lucide-react';

import messages from '../../../messages/en.json';
import { HomeBlockShell, type HomeBlockState } from './HomeBlockShell';

function renderShell(state: HomeBlockState, onRetry?: () => void) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <HomeBlockShell
                blockId="today"
                title="Today"
                icon={CalendarClock}
                state={state}
                headerAction={<span>more</span>}
                failedLabel="today's schedule"
                empty={<p>Nothing scheduled today.</p>}
                onRetry={onRetry}
            >
                <p>populated rows</p>
            </HomeBlockShell>
        </NextIntlClientProvider>,
    );
}

describe('HomeBlockShell', () => {
    it('is a landmark region named by its visible heading', () => {
        renderShell('ready');
        expect(screen.getByRole('region', { name: 'Today' })).toBeInTheDocument();
        expect(screen.getByText('populated rows')).toBeInTheDocument();
    });

    it('renders a skeleton, and nothing else, while loading', () => {
        renderShell('loading');
        expect(screen.getByTestId('home-block-today-skeleton')).toBeInTheDocument();
        expect(screen.queryByText('populated rows')).toBeNull();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('renders empty and failed as structurally different states', () => {
        const { unmount } = renderShell('empty');
        expect(screen.getByTestId('home-block-today-empty')).toHaveTextContent(
            'Nothing scheduled today.',
        );
        expect(screen.queryByRole('alert')).toBeNull();
        unmount();

        renderShell('failed', () => undefined);
        const alert = screen.getByRole('alert');
        expect(alert).toHaveTextContent("Couldn't load today's schedule.");
        expect(screen.queryByTestId('home-block-today-empty')).toBeNull();
        expect(screen.queryByText('populated rows')).toBeNull();
    });

    it('hides the header link on failure and retries on request (S10)', () => {
        const onRetry = vi.fn();
        renderShell('failed', onRetry);
        expect(screen.queryByText('more')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        expect(onRetry).toHaveBeenCalledTimes(1);
    });
});
