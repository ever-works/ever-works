import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComputerInputFrame } from '@ever-works/contracts';
import { ComputerStage, type ComputerStageHandle } from './ComputerStage';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

/**
 * The stage while this view holds control, forwarding a person's pointer.
 * Pinned: every pointer event carries the buttons still held (so a move is a
 * drag on the computer), a release is never dropped — not off the picture,
 * not when the browser cancels the pointer — and a watching stage forwards
 * nothing at all.
 */

const PICTURE = {
    kind: 'frame',
    seq: 1,
    keyframe: true,
    width: 800,
    height: 600,
    mime: 'image/jpeg',
    data: 'QUJD',
} as const;

beforeEach(() => {
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() })) as never;
});

async function renderStage(controlling: boolean) {
    const sent: ComputerInputFrame[] = [];
    const ref = createRef<ComputerStageHandle>();
    render(
        <ComputerStage
            ref={ref}
            channel="screen"
            label="stage"
            stall="ok"
            staleSeconds={0}
            onRefresh={() => undefined}
            onReconnect={() => undefined}
            controlling={controlling}
            onInput={(frame) => sent.push(frame)}
            decodePicture={async () => ({ width: 800, height: 600 }) as unknown as HTMLImageElement}
        />,
    );
    const canvas = screen.getByTestId('computer-canvas') as HTMLCanvasElement;
    act(() => ref.current?.drawPicture(PICTURE));
    await waitFor(() => expect(canvas.width).toBe(800));
    // The picture fills an 800×600 stage at the page's origin.
    canvas.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }) as DOMRect;
    return { canvas, sent };
}

describe('ComputerStage — a person’s pointer', () => {
    it('carries the held buttons, so a press, a move and a release are a drag on the computer', async () => {
        const { canvas, sent } = await renderStage(true);

        fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, button: 0, buttons: 1 });
        fireEvent.pointerMove(canvas, { clientX: 300, clientY: 120, button: -1, buttons: 1 });
        fireEvent.pointerUp(canvas, { clientX: 320, clientY: 120, button: 0, buttons: 0 });

        expect(sent).toEqual([
            { kind: 'pointer', action: 'down', x: 100, y: 100, button: 'left', buttons: 1 },
            { kind: 'pointer', action: 'move', x: 300, y: 120, button: null, buttons: 1 },
            { kind: 'pointer', action: 'up', x: 320, y: 120, button: 'left', buttons: 0 },
        ]);
    });

    it('still releases a button let go off the picture, at the nearest edge', async () => {
        const { canvas, sent } = await renderStage(true);

        fireEvent.pointerDown(canvas, { clientX: 700, clientY: 500, button: 0, buttons: 1 });
        // Captured on press: the release arrives even though it is past the picture.
        fireEvent.pointerUp(canvas, { clientX: 1200, clientY: 900, button: 0, buttons: 0 });

        expect(sent.at(-1)).toEqual({
            kind: 'pointer',
            action: 'up',
            x: 799,
            y: 599,
            button: 'left',
            buttons: 0,
        });
    });

    it('releases the pressed button where the pointer last was when the browser cancels it', async () => {
        const { canvas, sent } = await renderStage(true);

        fireEvent.pointerDown(canvas, { clientX: 40, clientY: 50, button: 2, buttons: 2 });
        fireEvent.pointerCancel(canvas, { clientX: 0, clientY: 0, button: -1, buttons: 0 });

        expect(sent).toEqual([
            { kind: 'pointer', action: 'down', x: 40, y: 50, button: 'right', buttons: 2 },
            { kind: 'pointer', action: 'up', x: 40, y: 50, button: 'right', buttons: 0 },
        ]);
        // Nothing left pressed: a second cancel has nothing to release.
        fireEvent.pointerCancel(canvas, { clientX: 0, clientY: 0, button: -1, buttons: 0 });
        expect(sent).toHaveLength(2);
    });

    it('forwards nothing from a watching stage', async () => {
        const { canvas, sent } = await renderStage(false);

        fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, button: 0, buttons: 1 });
        fireEvent.pointerUp(canvas, { clientX: 1200, clientY: 900, button: 0, buttons: 0 });
        fireEvent.pointerCancel(canvas, { clientX: 0, clientY: 0, button: -1, buttons: 0 });

        expect(sent).toEqual([]);
    });
});
