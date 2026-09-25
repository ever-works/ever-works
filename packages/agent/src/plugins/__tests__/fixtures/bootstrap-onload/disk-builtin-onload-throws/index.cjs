'use strict';

/**
 * Test fixture for `plugin-bootstrap.disk-builtin.spec.ts`: a disk-discovered
 * `builtIn` plugin whose `onLoad` throws, the shape of a plugin whose required
 * configuration is missing. Bootstrap must call it once, record `error` once,
 * and not call it again. Plain CommonJS so it needs no build.
 *
 * `onLoad` counts its calls in `globalThis.__bootstrapOnload[id]` BEFORE it
 * throws, so every attempt is counted.
 */
class DiskBuiltinOnloadThrowsPlugin {
    constructor() {
        this.id = 'disk-builtin-onload-throws';
        this.name = 'Disk Built-in onLoad Throws';
        this.version = '1.0.0';
        this.category = 'utility';
        this.capabilities = [];
    }

    async onLoad() {
        const counts = (globalThis.__bootstrapOnload = globalThis.__bootstrapOnload || {});
        counts[this.id] = (counts[this.id] || 0) + 1;
        throw new Error('fixture: apiKey missing');
    }

    async onUnload() {}
}

module.exports = DiskBuiltinOnloadThrowsPlugin;
