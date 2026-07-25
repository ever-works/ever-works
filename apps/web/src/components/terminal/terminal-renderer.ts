/**
 * Terminal renderer seam (streaming-terminal M7).
 *
 * The pane talks ONLY to this interface; the factory decides whether
 * xterm.js or the dependency-free DOM floor backs it. A renderer NEVER
 * opens its own socket — bytes come in through `write`, keystrokes go
 * out through the `onData` callback the pane registers.
 */
export interface TerminalRendererSize {
    cols: number;
    rows: number;
}

export interface TerminalRenderer {
    /** Mount into a host element the pane keeps strictly React-child-free. */
    mount(host: HTMLElement): void;
    /** Render raw terminal bytes (already base64-decoded). */
    write(data: Uint8Array): void;
    /** Keystrokes from the user (driver role only — the pane gates). */
    onData(cb: (data: string) => void): void;
    /** Viewport size changes (fit-driven). Null for the DOM floor. */
    onResize(cb: (size: TerminalRendererSize) => void): void;
    /** Recompute layout after the host resized. */
    fit(): void;
    focus(): void;
    clear(): void;
    dispose(): void;
    /** Which implementation is live — surfaces in diagnostics. */
    readonly kind: 'xterm' | 'dom';
}
