'use strict';

/**
 * Test fixture for `plugin-bootstrap.disk-builtin.spec.ts`: a plugin marked
 * `builtIn: true` in its package.json that the REAL loader discovers on disk.
 * Discovery registers it as a lazy proxy, and bootstrap materialises it at
 * boot. Plain CommonJS so it needs no build.
 *
 * `onLoad` counts its calls in `globalThis.__bootstrapOnload[id]`, so the spec
 * can prove it runs exactly once.
 */
class DiskBuiltinPlugin {
    constructor() {
        this.id = 'disk-builtin';
        this.name = 'Disk Built-in';
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

module.exports = DiskBuiltinPlugin;
