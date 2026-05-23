import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, args?: Record<string, string | number>) => {
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

import { KbImageViewer, KB_IMAGE_INLINE_MAX_BYTES } from './KbImageViewer';
import { KbVideoViewer, KB_VIDEO_INLINE_MAX_BYTES } from './KbVideoViewer';
import { KbAudioViewer, KB_AUDIO_INLINE_MAX_BYTES } from './KbAudioViewer';

/**
 * EW-641 Phase 1B/d row 12 — image / video / audio viewers all share
 * the same size-cap pattern as PDF (row 9), DOCX (row 10), and XLSX
 * (row 11). These tests lock the inline-vs-download decision the
 * Playwright A14 suite keys off.
 */
describe('KbImageViewer', () => {
    it('renders an inline <img> under the cap', () => {
        render(
            <KbImageViewer
                url="https://files.example/logo.png"
                sizeBytes={1024 * 1024}
                filename="logo.png"
            />,
        );
        const root = screen.getByTestId('kb-image-viewer');
        expect(root.getAttribute('data-mode')).toBe('inline');
        const img = screen.getByTestId('kb-image-element') as HTMLImageElement;
        expect(img.src).toBe('https://files.example/logo.png');
        expect(img.getAttribute('loading')).toBe('lazy');
        expect(img.getAttribute('decoding')).toBe('async');
        expect(img.alt).toBe('logo.png');
        expect(screen.queryByTestId('kb-image-download-fallback')).toBeNull();
    });

    it('uses the explicit alt prop when supplied', () => {
        render(
            <KbImageViewer
                url="https://files.example/logo.png"
                sizeBytes={1024}
                filename="logo.png"
                alt="Brand logo"
            />,
        );
        expect((screen.getByTestId('kb-image-element') as HTMLImageElement).alt).toBe('Brand logo');
    });

    it('renders the download fallback above the cap', () => {
        render(
            <KbImageViewer
                url="https://files.example/huge.jpg"
                sizeBytes={20 * 1024 * 1024}
                filename="huge.jpg"
            />,
        );
        const root = screen.getByTestId('kb-image-viewer');
        expect(root.getAttribute('data-mode')).toBe('download');
        const link = screen.getByTestId('kb-image-download-link') as HTMLAnchorElement;
        expect(link.href).toBe('https://files.example/huge.jpg');
        expect(link.getAttribute('download')).toBe('huge.jpg');
        expect(screen.queryByTestId('kb-image-element')).toBeNull();
    });

    it('treats exact-cap size as inline (boundary is `>`, not `>=`)', () => {
        render(
            <KbImageViewer
                url="https://files.example/edge.png"
                sizeBytes={KB_IMAGE_INLINE_MAX_BYTES}
                filename="edge.png"
            />,
        );
        expect(screen.getByTestId('kb-image-viewer').getAttribute('data-mode')).toBe('inline');
    });

    it('exposes the 10 MiB default cap', () => {
        expect(KB_IMAGE_INLINE_MAX_BYTES).toBe(10 * 1024 * 1024);
    });
});

describe('KbVideoViewer', () => {
    it('renders an inline <video> with controls + metadata preload under the cap', () => {
        render(
            <KbVideoViewer
                url="https://files.example/intro.mp4"
                sizeBytes={1024 * 1024}
                filename="intro.mp4"
                mimeType="video/mp4"
            />,
        );
        const root = screen.getByTestId('kb-video-viewer');
        expect(root.getAttribute('data-mode')).toBe('inline');
        const video = screen.getByTestId('kb-video-element') as HTMLVideoElement;
        expect(video.controls).toBe(true);
        expect(video.preload).toBe('metadata');
        const source = video.querySelector('source') as HTMLSourceElement;
        expect(source.src).toBe('https://files.example/intro.mp4');
        expect(source.type).toBe('video/mp4');
        expect(screen.queryByTestId('kb-video-download-fallback')).toBeNull();
    });

    it('renders the download fallback above the 100 MiB cap', () => {
        render(
            <KbVideoViewer
                url="https://files.example/huge.mp4"
                sizeBytes={200 * 1024 * 1024}
                filename="huge.mp4"
                mimeType="video/mp4"
            />,
        );
        const root = screen.getByTestId('kb-video-viewer');
        expect(root.getAttribute('data-mode')).toBe('download');
        const link = screen.getByTestId('kb-video-download-link') as HTMLAnchorElement;
        expect(link.href).toBe('https://files.example/huge.mp4');
        expect(link.getAttribute('download')).toBe('huge.mp4');
        expect(screen.queryByTestId('kb-video-element')).toBeNull();
    });

    it('forwards the poster prop to the <video> element', () => {
        render(
            <KbVideoViewer
                url="https://files.example/intro.mp4"
                sizeBytes={1024}
                filename="intro.mp4"
                mimeType="video/mp4"
                poster="https://files.example/intro.poster.jpg"
            />,
        );
        const video = screen.getByTestId('kb-video-element') as HTMLVideoElement;
        expect(video.poster).toBe('https://files.example/intro.poster.jpg');
    });

    it('exposes the 100 MiB default cap', () => {
        expect(KB_VIDEO_INLINE_MAX_BYTES).toBe(100 * 1024 * 1024);
    });
});

describe('KbAudioViewer', () => {
    it('renders an inline <audio> with controls + metadata preload under the cap', () => {
        render(
            <KbAudioViewer
                url="https://files.example/voice.mp3"
                sizeBytes={1024 * 1024}
                filename="voice.mp3"
                mimeType="audio/mpeg"
            />,
        );
        const root = screen.getByTestId('kb-audio-viewer');
        expect(root.getAttribute('data-mode')).toBe('inline');
        const audio = screen.getByTestId('kb-audio-element') as HTMLAudioElement;
        expect(audio.controls).toBe(true);
        expect(audio.preload).toBe('metadata');
        const source = audio.querySelector('source') as HTMLSourceElement;
        expect(source.src).toBe('https://files.example/voice.mp3');
        expect(source.type).toBe('audio/mpeg');
        expect(screen.queryByTestId('kb-audio-download-fallback')).toBeNull();
    });

    it('renders the download fallback above the 50 MiB cap', () => {
        render(
            <KbAudioViewer
                url="https://files.example/raw.wav"
                sizeBytes={100 * 1024 * 1024}
                filename="raw.wav"
                mimeType="audio/wav"
            />,
        );
        const root = screen.getByTestId('kb-audio-viewer');
        expect(root.getAttribute('data-mode')).toBe('download');
        const link = screen.getByTestId('kb-audio-download-link') as HTMLAnchorElement;
        expect(link.href).toBe('https://files.example/raw.wav');
        expect(link.getAttribute('download')).toBe('raw.wav');
        expect(screen.queryByTestId('kb-audio-element')).toBeNull();
    });

    it('exposes the 50 MiB default cap', () => {
        expect(KB_AUDIO_INLINE_MAX_BYTES).toBe(50 * 1024 * 1024);
    });

    it('boundary check: exact-cap size renders inline', () => {
        render(
            <KbAudioViewer
                url="https://files.example/edge.mp3"
                sizeBytes={KB_AUDIO_INLINE_MAX_BYTES}
                filename="edge.mp3"
                mimeType="audio/mpeg"
            />,
        );
        expect(screen.getByTestId('kb-audio-viewer').getAttribute('data-mode')).toBe('inline');
    });

    it('interpolates the size + cap into the fallback body', () => {
        render(
            <KbAudioViewer
                url="https://files.example/big.mp3"
                sizeBytes={2 * 1024 * 1024}
                filename="big.mp3"
                mimeType="audio/mpeg"
                maxInlineBytes={1 * 1024 * 1024}
            />,
        );
        const fallback = screen.getByTestId('kb-audio-download-fallback');
        expect(fallback.getAttribute('data-size-label')).toBe('2 MB');
        expect(fallback.getAttribute('data-cap-label')).toBe('1 MB');
        expect(fallback.textContent).toContain('size=2 MB');
        expect(fallback.textContent).toContain('cap=1 MB');
    });
});
