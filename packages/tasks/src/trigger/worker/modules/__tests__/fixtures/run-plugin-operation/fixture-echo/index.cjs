'use strict';

/**
 * Stands in for `BasePlugin`: the helpers every real plugin inherits and that
 * TypeScript marks `protected` — a marker erased at runtime, so nothing but the
 * manifest's `operations` allowlist keeps them from being called by name.
 */
class FixtureBase {
    emitEvent(name) {
        globalThis.__fixtureEchoHelpersCalled = (
            globalThis.__fixtureEchoHelpersCalled || []
        ).concat(`emitEvent:${name}`);
        return 'emitted';
    }

    log() {
        globalThis.__fixtureEchoHelpersCalled = (
            globalThis.__fixtureEchoHelpersCalled || []
        ).concat('log');
        return 'logged';
    }
}

/**
 * Test fixture for `trigger-run-plugin-operation.module.spec.ts`: a plugin the
 * REAL loader discovers from `pluginPaths`, registers as a lazy proxy (not
 * `builtIn`) and materialises on first use. Plain CommonJS so it needs no build.
 *
 * Its manifest declares `echo`, `explode` and `declaredButMissing`; everything
 * else here must be refused by name.
 */
class FixtureEchoPlugin extends FixtureBase {
    constructor() {
        super();
        this.id = 'fixture-echo';
        this.name = 'Fixture Echo';
        this.version = '1.0.0';
        this.category = 'utility';
        this.capabilities = [];
        /** A function-valued class field, like `local-workspace`'s `replaceFile`. */
        this.replaceFile = () => {
            globalThis.__fixtureEchoHelpersCalled = (
                globalThis.__fixtureEchoHelpersCalled || []
            ).concat('replaceFile');
            return 'replaced';
        };
    }

    async onLoad() {}

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

    /** The operation the spec calls. */
    async echo(args) {
        return { echoed: args === undefined ? null : args };
    }

    /** An operation that throws. */
    async explode() {
        throw new Error('fixture exploded');
    }

    /**
     * A helper a TypeScript plugin would mark `private` — like a CLI plugin's
     * prompt runner, which spawns a process with the flags it is given.
     * Undeclared, so never callable by name.
     */
    async runPrompt(args) {
        globalThis.__fixtureEchoHelpersCalled = (
            globalThis.__fixtureEchoHelpersCalled || []
        ).concat('runPrompt');
        return { ran: args === undefined ? null : args };
    }

    /** A private helper: never callable as an operation. */
    _secret() {
        return 'private';
    }
}

module.exports = FixtureEchoPlugin;
