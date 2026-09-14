import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ComputerStatusLine } from './ComputerStatusLine';

const MESSAGES: Record<string, string> = {
    modeWatching: 'Watching — {agent} keeps working.',
    terminalOnNode: 'Watching — this shell is on {node}.',
    'stall.staleNote': 'The picture is stale; the work is not.',
    'quality.autoLowered':
        'Lowered to {tier} — the connection is slow. It will go back to {chosen} on its own.',
    'quality.sharp': 'Sharp',
    'quality.steady': 'Steady',
};

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, string>) =>
        (MESSAGES[key] ?? key).replace(
            /\{(\w+)\}/g,
            (_, name: string) => values?.[name] ?? `{${name}}`,
        ),
}));

describe('ComputerStatusLine', () => {
    it('states watching mode in the exact sentence, as a polite live region', () => {
        render(
            <ComputerStatusLine
                agentName="Ops"
                nodeName="studio-imac"
                channel="screen"
                stall="ok"
                lowered={null}
            />,
        );
        const line = screen.getByRole('status');
        expect(line).toHaveTextContent('Watching — Ops keeps working.');
        expect(line).toHaveAttribute('aria-live', 'polite');
    });

    it('names the machine a terminal is on', () => {
        render(
            <ComputerStatusLine
                agentName="Ops"
                nodeName="build-box-01"
                channel="terminal"
                stall="ok"
                lowered={null}
            />,
        );
        expect(screen.getByRole('status')).toHaveTextContent(
            'Watching — this shell is on build-box-01.',
        );
    });

    it('adds that a stale picture is not stalled work, and that a lowered quality recovers on its own', () => {
        render(
            <ComputerStatusLine
                agentName="Ops"
                nodeName="studio-imac"
                channel="screen"
                stall="stalled"
                lowered={{ tier: 'steady', chosen: 'sharp' }}
            />,
        );
        const line = screen.getByRole('status');
        expect(line).toHaveTextContent('The picture is stale; the work is not.');
        expect(line).toHaveTextContent(
            'Lowered to Steady — the connection is slow. It will go back to Sharp on its own.',
        );
    });
});
