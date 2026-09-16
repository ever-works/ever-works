import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
    ComputerHeldElsewherePrompt,
    ComputerIdleWarningPrompt,
    ComputerIncomingRequestPrompt,
} from './ComputerControlRequestDialog';

const MESSAGES: Record<string, string> = {
    promptLabel: 'Control of {node}',
    heldByYou: 'You have had control in another view of this computer since {time}.',
    heldBySomeone: 'Someone else has had control since {time}.',
    heldByBody: 'You can watch. Ask for control and whoever has it will be prompted.',
    requestControl: 'Request control',
    keepWatching: 'Keep watching',
    requestWaiting: 'Waiting for an answer — declines on its own in {countdown}.',
    requestDeclined: 'Your request was not answered. You still have watching access.',
    incomingRequest: 'Someone is asking for control of {node}.',
    incomingRequestYou: 'Another view of yours is asking for control of {node}.',
    autoDeclines: 'Declines on its own in {countdown}.',
    handOver: 'Hand over',
    keepControl: 'Keep control',
    idleWarning: 'Giving control back in {countdown}',
    idleWarningBody: '{agent} has been waiting since {time}.',
    giveBackNow: 'Give back',
};

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, string>) =>
        (MESSAGES[key] ?? key).replace(
            /\{(\w+)\}/g,
            (_, name: string) => values?.[name] ?? `{${name}}`,
        ),
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));

describe('ComputerIncomingRequestPrompt — the view holding control is asked', () => {
    it('says who is asking and counts down to the automatic decline', () => {
        render(
            <ComputerIncomingRequestPrompt
                nodeName="studio-imac"
                requesterIsYou={false}
                msLeft={47_000}
                busy={false}
                onHandOver={vi.fn()}
                onKeepControl={vi.fn()}
            />,
        );
        const prompt = screen.getByRole('alertdialog', { name: 'Control of studio-imac' });
        expect(prompt).toHaveTextContent('Someone is asking for control of studio-imac.');
        expect(prompt).toHaveTextContent('Declines on its own in 0:47.');
    });

    it('hands over or keeps control only on an explicit choice', () => {
        const onHandOver = vi.fn();
        const onKeepControl = vi.fn();
        const { rerender } = render(
            <ComputerIncomingRequestPrompt
                nodeName="studio-imac"
                requesterIsYou
                msLeft={60_000}
                busy={false}
                onHandOver={onHandOver}
                onKeepControl={onKeepControl}
            />,
        );
        expect(screen.getByRole('alertdialog')).toHaveTextContent(
            'Another view of yours is asking for control of studio-imac.',
        );
        expect(onHandOver).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Keep control' }));
        expect(onKeepControl).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole('button', { name: 'Hand over' }));
        expect(onHandOver).toHaveBeenCalledTimes(1);

        rerender(
            <ComputerIncomingRequestPrompt
                nodeName="studio-imac"
                requesterIsYou
                msLeft={0}
                busy
                onHandOver={onHandOver}
                onKeepControl={onKeepControl}
            />,
        );
        expect(screen.getByRole('button', { name: 'Hand over' })).toBeDisabled();
        expect(screen.getByRole('alertdialog')).toHaveTextContent('Declines on its own in 0:00.');
    });
});

describe('ComputerHeldElsewherePrompt — the view that cannot take over', () => {
    it('names who has control and since when, and offers Request control', () => {
        const onRequest = vi.fn();
        render(
            <ComputerHeldElsewherePrompt
                nodeName="studio-imac"
                holderIsYou={false}
                since="09:12"
                requestMsLeft={null}
                declined={false}
                busy={false}
                onRequest={onRequest}
                onKeepWatching={vi.fn()}
            />,
        );
        const prompt = screen.getByRole('alertdialog');
        expect(prompt).toHaveTextContent('Someone else has had control since 09:12.');
        expect(prompt).toHaveTextContent('Ask for control and whoever has it will be prompted.');
        fireEvent.click(screen.getByRole('button', { name: 'Request control' }));
        expect(onRequest).toHaveBeenCalledTimes(1);
    });

    it('while the request waits: no second request, and the countdown to the automatic decline', () => {
        render(
            <ComputerHeldElsewherePrompt
                nodeName="studio-imac"
                holderIsYou
                since="09:12"
                requestMsLeft={31_500}
                declined={false}
                busy={false}
                onRequest={vi.fn()}
                onKeepWatching={vi.fn()}
            />,
        );
        expect(screen.getByRole('alertdialog')).toHaveTextContent(
            'You have had control in another view of this computer since 09:12.',
        );
        expect(screen.getByTestId('computer-request-waiting')).toHaveTextContent(
            'declines on its own in 0:32.',
        );
        expect(screen.queryByRole('button', { name: 'Request control' })).not.toBeInTheDocument();
    });

    it('after an unanswered request, says watching access remains and lets the viewer dismiss it', () => {
        const onKeepWatching = vi.fn();
        render(
            <ComputerHeldElsewherePrompt
                nodeName="studio-imac"
                holderIsYou={false}
                since="09:12"
                requestMsLeft={null}
                declined
                busy={false}
                onRequest={vi.fn()}
                onKeepWatching={onKeepWatching}
            />,
        );
        expect(screen.getByTestId('computer-request-declined')).toHaveTextContent(
            'You still have watching access.',
        );
        fireEvent.click(screen.getByRole('button', { name: 'Keep watching' }));
        expect(onKeepWatching).toHaveBeenCalledTimes(1);
    });
});

describe('ComputerIdleWarningPrompt — the last 30 seconds before an idle give-back', () => {
    it('counts down, says how long the Agent has waited, and offers Keep control or Give back', () => {
        const onKeepControl = vi.fn();
        const onGiveBack = vi.fn();
        render(
            <ComputerIdleWarningPrompt
                nodeName="studio-imac"
                agentName="Ops"
                msLeft={30_000}
                waitingSince="09:53"
                busy={false}
                onKeepControl={onKeepControl}
                onGiveBack={onGiveBack}
            />,
        );
        const prompt = screen.getByRole('alertdialog');
        expect(prompt).toHaveTextContent('Giving control back in 0:30');
        expect(prompt).toHaveTextContent('Ops has been waiting since 09:53.');
        fireEvent.click(screen.getByRole('button', { name: 'Keep control' }));
        fireEvent.click(screen.getByRole('button', { name: 'Give back' }));
        expect(onKeepControl).toHaveBeenCalledTimes(1);
        expect(onGiveBack).toHaveBeenCalledTimes(1);
    });
});
