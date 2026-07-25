import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

const pushMock = vi.fn();
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: pushMock, back: vi.fn() }),
    Link: ({
        href,
        children,
        ...rest
    }: {
        href: string;
        children: React.ReactNode;
    } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

import { NewIdeaForm } from './NewIdeaForm';

function fillDescription() {
    fireEvent.change(screen.getByLabelText('descriptionLabel'), {
        target: { value: 'A sufficiently long idea description for the form.' },
    });
}

describe('NewIdeaForm — double-submit guard', () => {
    it('a rapid double submit creates exactly ONE idea and locks the button', async () => {
        // Slow server action: the second click lands while the first is
        // in flight — the old useTransition.pending gate was inert here
        // (detached void-async resolved the transition immediately).
        let resolveCreate: (v: unknown) => void = () => undefined;
        const createIdea = vi.fn().mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveCreate = resolve;
                }),
        );
        render(<NewIdeaForm createIdea={createIdea} />);
        fillDescription();

        const submit = screen.getByRole('button', { name: 'create' });
        fireEvent.click(submit);
        fireEvent.click(submit);
        fireEvent.click(submit);

        expect(createIdea).toHaveBeenCalledTimes(1);
        // Locked + showing the in-flight label while the action runs.
        expect(screen.getByRole('button', { name: 'creating' })).toBeDisabled();

        resolveCreate({ id: 'idea-1' });
        await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
        // Stays locked through navigation — no re-enable flash on success.
        expect(screen.getByRole('button', { name: 'creating' })).toBeDisabled();
    });

    it('re-enables the form after a failure so the user can retry', async () => {
        const createIdea = vi.fn().mockRejectedValueOnce(new Error('boom'));
        render(<NewIdeaForm createIdea={createIdea} />);
        fillDescription();

        fireEvent.click(screen.getByRole('button', { name: 'create' }));

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('error'));
        expect(screen.getByRole('button', { name: 'create' })).not.toBeDisabled();

        fireEvent.click(screen.getByRole('button', { name: 'create' }));
        expect(createIdea).toHaveBeenCalledTimes(2);
    });
});
