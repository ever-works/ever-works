import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { collectPluginDependencies } from '../build/collect-plugin-deps';

/**
 * Regression guard for the terminal streaming feature's cloud path.
 *
 * `pty-local` opens a REAL PTY only when
 * `@homebridge/node-pty-prebuilt-multiarch` is present in the running
 * process. In cloud that process is the Trigger.dev worker image, whose
 * package set is exactly what `collectPluginDependencies()` hands to the
 * `additionalPackages` build extension. The collector used to read only
 * `dependencies` + `peerDependencies`, while the manifest declares the
 * prebuild under `optionalDependencies` — so the addon was never shipped
 * and every cloud session degraded to the pipe floor, permanently and
 * silently.
 *
 * This spec runs against the REAL manifest on disk (no fs mock), so a
 * future manifest edit that moves the dependency somewhere the collector
 * does not read fails here instead of in production.
 */
const PTY_LOCAL_PKG = path.resolve(
    __dirname,
    '../../../../packages/plugins/pty-local/package.json',
);
const NODE_PTY = '@homebridge/node-pty-prebuilt-multiarch';

describe('pty-local ships its PTY prebuild to the Trigger.dev worker', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
        warnSpy.mockRestore();
    });

    it('declares the node-pty prebuild in a field the collector reads', () => {
        const pkg = JSON.parse(fs.readFileSync(PTY_LOCAL_PKG, 'utf-8'));
        const declared = {
            ...(pkg.dependencies ?? {}),
            ...(pkg.peerDependencies ?? {}),
            ...(pkg.optionalDependencies ?? {}),
        };
        expect(Object.keys(declared)).toContain(NODE_PTY);
    });

    it('collectPluginDependencies() includes the node-pty prebuild', () => {
        const collected = collectPluginDependencies();
        expect(collected.some((entry) => entry.startsWith(`${NODE_PTY}@`))).toBe(true);
    });
});
