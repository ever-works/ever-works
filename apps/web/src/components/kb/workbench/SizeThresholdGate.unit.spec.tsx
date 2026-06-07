import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, args?: Record<string, string>) => {
        if (!args) return key;
        const interpolated = Object.entries(args)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ');
        return `${key} ${interpolated}`;
    },
}));

vi.mock('@/components/ui/button', () => ({
    Button: ({
        children,
        asChild,
        onClick,
        ...rest
    }: {
        children: ReactNode;
        asChild?: boolean;
        onClick?: () => void;
    } & Record<string, unknown>) => {
        if (asChild) return <>{children}</>;
        return (
            <button type="button" onClick={onClick} {...rest}>
                {children}
            </button>
        );
    },
}));

import {
    KB_WORKBENCH_SIZE_THRESHOLDS,
    SizeThresholdGate,
    resolveSizeThreshold,
} from './SizeThresholdGate';

/**
 * EW-641 slice D — `SizeThresholdGate` is the per-MIME size guard
 * that the workbench dispatcher wraps around every inline viewer.
 * The tests below lock the four behaviours that production code
 * (and the e2e spec) depends on: pass-through, blocked, prefix
 * match, and unknown-MIME pass-through.
 */
describe('SizeThresholdGate', () => {
    it('renders children when fileSize is undefined (size unknown → trust the viewer)', () => {
        render(
            <SizeThresholdGate mimeType="application/pdf">
                <div data-testid="child" />
            </SizeThresholdGate>,
        );
        expect(screen.getByTestId('child')).toBeTruthy();
        expect(screen.queryByTestId('kb-workbench-size-blocked')).toBeNull();
        expect(screen.getByTestId('kb-workbench-size-gate').getAttribute('data-mode')).toBe(
            'passthrough',
        );
    });

    it('renders children when fileSize is at or below the per-MIME cap', () => {
        render(
            <SizeThresholdGate mimeType="application/pdf" fileSize={1024 * 1024} downloadUrl="/dl">
                <div data-testid="child">pdf</div>
            </SizeThresholdGate>,
        );
        expect(screen.getByTestId('child')).toBeTruthy();
        expect(screen.queryByTestId('kb-workbench-size-blocked')).toBeNull();
    });

    it('renders the download banner with size + cap labels when above the cap', () => {
        // PDF cap is 50 MiB; 60 MiB is over.
        const sixtyMib = 60 * 1024 * 1024;
        render(
            <SizeThresholdGate
                mimeType="application/pdf"
                fileSize={sixtyMib}
                downloadUrl="/dl/x.pdf"
                filename="x.pdf"
            >
                <div data-testid="child">never rendered</div>
            </SizeThresholdGate>,
        );
        const banner = screen.getByTestId('kb-workbench-size-blocked');
        expect(banner.getAttribute('data-size-bytes')).toBe(String(sixtyMib));
        expect(banner.getAttribute('data-cap-bytes')).toBe(String(50 * 1024 * 1024));
        expect(banner.getAttribute('data-size-label')).toBe('60 MB');
        expect(banner.getAttribute('data-cap-label')).toBe('50 MB');
        // Mocked translator echoes args.
        expect(banner.textContent).toContain('size=60 MB');
        expect(banner.textContent).toContain('cap=50 MB');
        // Child branch is suppressed.
        expect(screen.queryByTestId('child')).toBeNull();
        // Download anchor wired.
        const link = screen.getByTestId('kb-workbench-size-blocked-download') as HTMLAnchorElement;
        expect(link.getAttribute('href')).toBe('/dl/x.pdf');
        expect(link.getAttribute('download')).toBe('x.pdf');
    });

    it('prefix-matches image/* against image/png and blocks above the 10 MiB cap', () => {
        const twentyMib = 20 * 1024 * 1024;
        render(
            <SizeThresholdGate mimeType="image/png" fileSize={twentyMib} downloadUrl="/dl">
                <div data-testid="child" />
            </SizeThresholdGate>,
        );
        const banner = screen.getByTestId('kb-workbench-size-blocked');
        expect(banner.getAttribute('data-cap-bytes')).toBe(String(10 * 1024 * 1024));
        expect(banner.getAttribute('data-mime-type')).toBe('image/png');
    });

    it('passes through unknown MIME types regardless of fileSize', () => {
        render(
            <SizeThresholdGate
                mimeType="application/x-something-exotic"
                fileSize={1024 * 1024 * 1024}
            >
                <div data-testid="child">child rendered</div>
            </SizeThresholdGate>,
        );
        expect(screen.getByTestId('child')).toBeTruthy();
        expect(screen.queryByTestId('kb-workbench-size-blocked')).toBeNull();
    });

    it('strips MIME parameters before matching ("application/pdf; charset=binary")', () => {
        const sixtyMib = 60 * 1024 * 1024;
        render(
            <SizeThresholdGate
                mimeType="application/pdf; charset=binary"
                fileSize={sixtyMib}
                downloadUrl="/dl"
            >
                <div data-testid="child" />
            </SizeThresholdGate>,
        );
        expect(screen.getByTestId('kb-workbench-size-blocked')).toBeTruthy();
    });

    it('treats exact-cap as pass-through (boundary is `>`, not `>=`)', () => {
        const exact = KB_WORKBENCH_SIZE_THRESHOLDS['application/pdf'];
        render(
            <SizeThresholdGate mimeType="application/pdf" fileSize={exact} downloadUrl="/dl">
                <div data-testid="child">at cap</div>
            </SizeThresholdGate>,
        );
        expect(screen.getByTestId('child')).toBeTruthy();
        expect(screen.queryByTestId('kb-workbench-size-blocked')).toBeNull();
    });
});

describe('resolveSizeThreshold', () => {
    it.each([
        ['application/pdf', 50 * 1024 * 1024],
        [
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            25 * 1024 * 1024,
        ],
        ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 15 * 1024 * 1024],
        [
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            50 * 1024 * 1024,
        ],
        ['image/png', 10 * 1024 * 1024],
        ['image/jpeg', 10 * 1024 * 1024],
        ['video/mp4', 500 * 1024 * 1024],
        ['audio/mpeg', 100 * 1024 * 1024],
        ['text/html', 5 * 1024 * 1024],
    ])('matches %s → %d bytes', (mime, cap) => {
        expect(resolveSizeThreshold(mime)).toBe(cap);
    });

    it('returns undefined for empty / unknown MIMEs', () => {
        expect(resolveSizeThreshold(undefined)).toBeUndefined();
        expect(resolveSizeThreshold('')).toBeUndefined();
        expect(resolveSizeThreshold('application/x-unknown')).toBeUndefined();
    });
});
