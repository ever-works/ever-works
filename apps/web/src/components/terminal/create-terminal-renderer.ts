import type { TerminalRenderer, TerminalRendererSize } from './terminal-renderer';

/**
 * Renderer factory (streaming-terminal M7): xterm.js by default, a
 * dependency-free DOM floor on ANY throw — an xterm failure must never
 * yield a permanently blank terminal. No WASM renderer, ever: the
 * research showed the WASM path hangs without rejecting in production
 * Next builds.
 *
 * xterm is imported dynamically (client-only, CSS side-effect import)
 * so the dashboard bundle doesn't carry it until a pane mounts.
 */
export async function createTerminalRenderer(): Promise<TerminalRenderer> {
    try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([
            import('@xterm/xterm'),
            import('@xterm/addon-fit'),
        ]);
        await import('@xterm/xterm/css/xterm.css');

        const terminal = new Terminal({
            // Raw PTY bytes already carry CRLF — converting would double
            // line feeds on real CLI output.
            convertEol: false,
            cursorBlink: true,
            fontSize: 13,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            theme: { background: '#0b0f19' },
            scrollback: 5000,
        });
        const fit = new FitAddon();
        terminal.loadAddon(fit);

        let dataCb: ((data: string) => void) | null = null;
        let resizeCb: ((size: TerminalRendererSize) => void) | null = null;
        terminal.onData((d) => dataCb?.(d));
        terminal.onResize(({ cols, rows }) => resizeCb?.({ cols, rows }));

        return {
            kind: 'xterm',
            mount: (host) => {
                terminal.open(host);
                try {
                    fit.fit();
                } catch {
                    // Zero-size host on first paint — the ResizeObserver
                    // in the pane re-fits once laid out.
                }
            },
            write: (data) => terminal.write(data),
            onData: (cb) => {
                dataCb = cb;
            },
            onResize: (cb) => {
                resizeCb = cb;
            },
            fit: () => {
                try {
                    fit.fit();
                } catch {
                    // never let a resize race blank the pane
                }
            },
            focus: () => terminal.focus(),
            clear: () => terminal.clear(),
            dispose: () => terminal.dispose(),
        };
    } catch {
        return createDomFloorRenderer();
    }
}

/**
 * The dependency-free floor: a <pre> that appends decoded text. No
 * cursor addressing, no colors — but bytes are VISIBLE, which beats a
 * black pane every time. Exported for tests and as the explicit
 * fallback target.
 */
export function createDomFloorRenderer(): TerminalRenderer {
    let pre: HTMLPreElement | null = null;
    let dataCb: ((data: string) => void) | null = null;
    const decoder = new TextDecoder();

    return {
        kind: 'dom',
        mount: (host) => {
            pre = host.ownerDocument.createElement('pre');
            pre.style.cssText =
                'margin:0;padding:8px;white-space:pre-wrap;word-break:break-all;' +
                'font:12px ui-monospace,Consolas,monospace;color:#d1d5db;background:#0b0f19;' +
                'height:100%;overflow:auto;';
            pre.tabIndex = 0;
            pre.addEventListener('keydown', (e) => {
                if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
                    dataCb?.(e.key);
                } else if (e.key === 'Enter') {
                    dataCb?.('\r');
                } else if (e.key === 'Backspace') {
                    dataCb?.('\x7f');
                }
            });
            host.appendChild(pre);
        },
        write: (data) => {
            if (!pre) return;
            pre.textContent = ((pre.textContent ?? '') + decoder.decode(data)).slice(-200_000);
            pre.scrollTop = pre.scrollHeight;
        },
        onData: (cb) => {
            dataCb = cb;
        },
        onResize: () => {
            // The floor has no grid — resize frames simply aren't sent.
        },
        fit: () => undefined,
        focus: () => pre?.focus(),
        clear: () => {
            if (pre) pre.textContent = '';
        },
        dispose: () => {
            pre?.remove();
            pre = null;
        },
    };
}
