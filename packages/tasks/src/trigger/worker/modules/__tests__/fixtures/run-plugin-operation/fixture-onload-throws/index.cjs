'use strict';

/**
 * Test fixture for `trigger-run-plugin-operation.module.spec.ts`: registered
 * lazily, and its `onLoad` throws when the first use materialises it — the
 * shape of a plugin whose required configuration is missing. Its one declared
 * operation records that it ran, so the spec can prove it never does.
 */
class FixtureOnloadThrowsPlugin {
    constructor() {
        this.id = 'fixture-onload-throws';
        this.name = 'Fixture onLoad Throws';
        this.version = '1.0.0';
        this.category = 'utility';
        this.capabilities = [];
    }

    async onLoad() {
        throw new Error('fixture onLoad: required setting "apiKey" is missing');
    }

    async onUnload() {}

    getManifest() {
        return {
            id: this.id,
            name: this.name,
            version: this.version,
            category: this.category,
            capabilities: [],
        };
    }

    /** Must never run: the plugin's initialisation failed. */
    async touch() {
        globalThis.__fixtureOnloadThrowsTouched = true;
        return { touched: true };
    }
}

module.exports = FixtureOnloadThrowsPlugin;
