import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChoiceCard } from './ChoiceCard';

describe('ChoiceCard', () => {
    it('renders the title, description, and badges', () => {
        render(
            <ChoiceCard
                title="OpenRouter"
                description="Route AI calls with your own key"
                selected={false}
                available
                badges={['byok']}
                onSelect={() => undefined}
            />
        );
        expect(screen.getByText('OpenRouter')).toBeInTheDocument();
        expect(screen.getByText('Route AI calls with your own key')).toBeInTheDocument();
        expect(screen.getByText('BYOK')).toBeInTheDocument();
    });

    it('calls onSelect when clicked and available', async () => {
        const onSelect = vi.fn();
        render(
            <ChoiceCard
                title="OpenRouter"
                description="d"
                selected={false}
                available
                badges={[]}
                onSelect={onSelect}
            />
        );
        await userEvent.click(screen.getByRole('button', { name: /openrouter/i }));
        expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it('disables the button and ignores clicks when unavailable (Planned)', async () => {
        const onSelect = vi.fn();
        render(
            <ChoiceCard
                title="GitLab"
                description="d"
                selected={false}
                available={false}
                badges={['planned']}
                onSelect={onSelect}
            />
        );
        const btn = screen.getByRole('button', { name: /gitlab/i });
        expect(btn).toBeDisabled();
        await userEvent.click(btn).catch(() => undefined);
        expect(onSelect).not.toHaveBeenCalled();
        expect(screen.getByText('Coming soon')).toBeInTheDocument();
    });

    it('reflects aria-pressed when selected', () => {
        render(
            <ChoiceCard
                title="OpenRouter"
                description="d"
                selected
                available
                badges={['default']}
                onSelect={() => undefined}
            />
        );
        const btn = screen.getByRole('button', { name: /openrouter/i });
        expect(btn).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByText('Default')).toBeInTheDocument();
    });
});
