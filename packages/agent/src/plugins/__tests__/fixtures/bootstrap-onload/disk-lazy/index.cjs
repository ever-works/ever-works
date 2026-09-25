'use strict';

/**
 * Test fixture for `plugin-bootstrap.disk-builtin.spec.ts`: a plugin that is
 * NOT `builtIn`. The REAL loader discovers it on disk and registers it as a
 * lazy proxy; it must stay cold through bootstrap and run `onLoad` once, on
 * first use. Plain CommonJS so it needs no build.
 *
 * `onLoad` counts its calls in `globalThis.__bootstrapOnload[id]`.
 */
class DiskLazyPlugin {
    constructor() {
        this.id = 'disk-lazy';
        this.name = 'Disk Lazy';
        this.version = '1.0.0';
        this.category = 'utility';
        this.capabilities = [];
    }

    async onLoad() {
        const counts = (globalThis.__bootstrapOnload = globalThis.__bootstrapOnload || {});
        counts[this.id] = (counts[this.id] || 0) + 1;
    }

    async onUnload() {}
}

module.exports = DiskLazyPlugin;
