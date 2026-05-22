/**
 * Type shim for `mammoth/mammoth.browser`.
 *
 * The mammoth package ships `index.d.ts` for the Node entry only; the
 * browser bundle (`mammoth.browser.js`) is untyped. We dynamic-import
 * it in `KbDocxViewerCanvas.tsx` and only call `convertToHtml`, so the
 * declared surface here matches that single function — keeping the
 * any cast scoped instead of bleeding into the canvas itself.
 */
declare module 'mammoth/mammoth.browser' {
    export interface MammothBrowserConversionResult {
        value: string;
        messages: Array<{ type?: string; message?: string }>;
    }
    export function convertToHtml(input: {
        arrayBuffer: ArrayBuffer;
    }): Promise<MammothBrowserConversionResult>;
}
