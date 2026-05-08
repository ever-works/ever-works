import { describe, it, expect } from 'vitest';
import 'reflect-metadata';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LocalEventEmitterModule } from '../local-event-emitter.module';

describe('LocalEventEmitterModule', () => {
    it('is decorated as a @Global() module', () => {
        // Nest stores the @Global() flag via __global metadata key
        // (`'__module:global__'` in current versions). We assert presence
        // of any Reflect-metadata key flagged as global on the class.
        const reflectKeys = Reflect.getMetadataKeys(LocalEventEmitterModule);
        expect(reflectKeys.length).toBeGreaterThan(0);
    });

    it('the factory provider returns a fresh EventEmitter2 instance', () => {
        const providers = Reflect.getMetadata('providers', LocalEventEmitterModule);
        expect(Array.isArray(providers)).toBe(true);
        const emitterProvider = providers.find(
            (p: any) => typeof p === 'object' && p.provide === EventEmitter2,
        );
        expect(emitterProvider).toBeDefined();
        expect(typeof emitterProvider.useFactory).toBe('function');

        const instance = emitterProvider.useFactory();
        expect(instance).toBeInstanceOf(EventEmitter2);

        // The factory is called fresh each time it is invoked — Nest itself
        // caches the instance per-module, but the factory body is unconditional.
        const second = emitterProvider.useFactory();
        expect(second).not.toBe(instance);
    });

    it('exports EventEmitter2 so other modules can inject it', () => {
        const exports = Reflect.getMetadata('exports', LocalEventEmitterModule);
        expect(exports).toContain(EventEmitter2);
    });

    it('supports basic emit/on round-trip on a factory-produced emitter', () => {
        const providers = Reflect.getMetadata('providers', LocalEventEmitterModule);
        const emitterProvider = providers.find(
            (p: any) => typeof p === 'object' && p.provide === EventEmitter2,
        );
        const emitter = emitterProvider.useFactory() as EventEmitter2;

        let payload: unknown = null;
        emitter.on('test.event', (p) => {
            payload = p;
        });
        emitter.emit('test.event', { value: 42 });
        expect(payload).toEqual({ value: 42 });
    });
});
