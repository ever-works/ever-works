import { Test, TestingModule } from '@nestjs/testing';
import { CustomCapabilityRegistryService } from '../services/custom-capability-registry.service';
import type { CustomCapabilityDefinition } from '@ever-works/plugin';

describe('CustomCapabilityRegistryService', () => {
    let service: CustomCapabilityRegistryService;

    const createCapabilityDefinition = (name: string): CustomCapabilityDefinition => ({
        name,
        description: `Capability ${name}`,
        version: '1.0.0',
        methods: ['execute'],
    });

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [CustomCapabilityRegistryService],
        }).compile();

        service = module.get<CustomCapabilityRegistryService>(CustomCapabilityRegistryService);
    });

    afterEach(() => {
        service.clear();
    });

    describe('register', () => {
        it('should register a custom capability', () => {
            const definition = createCapabilityDefinition('test-capability');
            const implementation = { doSomething: () => {} };

            service.register(definition, implementation, 'provider-plugin');

            expect(service.has('test-capability')).toBe(true);
        });

        it('should throw error for duplicate registration', () => {
            const definition = createCapabilityDefinition('test-capability');
            const implementation = { doSomething: () => {} };

            service.register(definition, implementation, 'provider-plugin');

            expect(() => service.register(definition, implementation, 'other-plugin')).toThrow(
                'already registered',
            );
        });
    });

    describe('unregister', () => {
        it('should unregister a capability', () => {
            const definition = createCapabilityDefinition('test-capability');
            service.register(definition, {}, 'provider-plugin');

            const result = service.unregister('test-capability');

            expect(result).toBe(true);
            expect(service.has('test-capability')).toBe(false);
        });

        it('should return false for non-existent capability', () => {
            const result = service.unregister('non-existent');
            expect(result).toBe(false);
        });
    });

    describe('unregisterByProvider', () => {
        it('should unregister all capabilities from a provider', () => {
            service.register(createCapabilityDefinition('cap-1'), {}, 'provider-a');
            service.register(createCapabilityDefinition('cap-2'), {}, 'provider-a');
            service.register(createCapabilityDefinition('cap-3'), {}, 'provider-b');

            const unregistered = service.unregisterByProvider('provider-a');

            expect(unregistered).toHaveLength(2);
            expect(unregistered).toContain('cap-1');
            expect(unregistered).toContain('cap-2');
            expect(service.has('cap-1')).toBe(false);
            expect(service.has('cap-2')).toBe(false);
            expect(service.has('cap-3')).toBe(true);
        });

        it('should return empty array for non-existent provider', () => {
            const unregistered = service.unregisterByProvider('non-existent');
            expect(unregistered).toHaveLength(0);
        });
    });

    describe('get', () => {
        it('should get a registered capability', () => {
            const definition = createCapabilityDefinition('test-capability');
            const implementation = { value: 42 };
            service.register(definition, implementation, 'provider-plugin');

            const registered = service.get('test-capability');

            expect(registered).toBeDefined();
            expect(registered?.definition.name).toBe('test-capability');
            expect(registered?.implementation).toBe(implementation);
            expect(registered?.providerPluginId).toBe('provider-plugin');
        });

        it('should return undefined for non-existent capability', () => {
            const registered = service.get('non-existent');
            expect(registered).toBeUndefined();
        });
    });

    describe('getImplementation', () => {
        it('should get capability implementation with type', () => {
            interface TestCapability {
                doSomething(): void;
            }

            const implementation: TestCapability = {
                doSomething: jest.fn(),
            };

            service.register(
                createCapabilityDefinition('test-capability'),
                implementation,
                'provider',
            );

            const impl = service.getImplementation<TestCapability>('test-capability');

            expect(impl).toBe(implementation);
            impl?.doSomething();
            expect(implementation.doSomething).toHaveBeenCalled();
        });
    });

    describe('list', () => {
        it('should list all capability definitions', () => {
            service.register(createCapabilityDefinition('cap-1'), {}, 'provider');
            service.register(createCapabilityDefinition('cap-2'), {}, 'provider');

            const definitions = service.list();

            expect(definitions).toHaveLength(2);
            expect(definitions.map((d) => d.name)).toContain('cap-1');
            expect(definitions.map((d) => d.name)).toContain('cap-2');
        });
    });

    describe('listWithInfo', () => {
        it('should list capabilities with full info', () => {
            service.register(createCapabilityDefinition('cap-1'), {}, 'provider-a');
            service.register(createCapabilityDefinition('cap-2'), {}, 'provider-b');

            const capabilities = service.listWithInfo();

            expect(capabilities).toHaveLength(2);
            expect(capabilities.find((c) => c.definition.name === 'cap-1')?.providerPluginId).toBe(
                'provider-a',
            );
        });
    });

    describe('getNames', () => {
        it('should return all capability names', () => {
            service.register(createCapabilityDefinition('cap-1'), {}, 'provider');
            service.register(createCapabilityDefinition('cap-2'), {}, 'provider');

            const names = service.getNames();

            expect(names).toHaveLength(2);
            expect(names).toContain('cap-1');
            expect(names).toContain('cap-2');
        });
    });

    describe('getByProvider', () => {
        it('should get capabilities by provider', () => {
            service.register(createCapabilityDefinition('cap-1'), {}, 'provider-a');
            service.register(createCapabilityDefinition('cap-2'), {}, 'provider-a');
            service.register(createCapabilityDefinition('cap-3'), {}, 'provider-b');

            const capabilities = service.getByProvider('provider-a');

            expect(capabilities).toHaveLength(2);
            expect(capabilities.every((c) => c.providerPluginId === 'provider-a')).toBe(true);
        });

        it('should return empty array for non-existent provider', () => {
            const capabilities = service.getByProvider('non-existent');
            expect(capabilities).toHaveLength(0);
        });
    });

    describe('getProvider', () => {
        it('should get provider plugin ID', () => {
            service.register(createCapabilityDefinition('cap-1'), {}, 'provider-plugin');

            const provider = service.getProvider('cap-1');

            expect(provider).toBe('provider-plugin');
        });

        it('should return undefined for non-existent capability', () => {
            const provider = service.getProvider('non-existent');
            expect(provider).toBeUndefined();
        });
    });

    describe('count', () => {
        it('should return correct count', () => {
            expect(service.count()).toBe(0);

            service.register(createCapabilityDefinition('cap-1'), {}, 'provider');
            expect(service.count()).toBe(1);

            service.register(createCapabilityDefinition('cap-2'), {}, 'provider');
            expect(service.count()).toBe(2);

            service.unregister('cap-1');
            expect(service.count()).toBe(1);
        });
    });

    describe('find', () => {
        it('should find capabilities by provider', () => {
            service.register(createCapabilityDefinition('cap-1'), {}, 'provider-a');
            service.register(createCapabilityDefinition('cap-2'), {}, 'provider-b');

            const capabilities = service.find({ providerPluginId: 'provider-a' });

            expect(capabilities).toHaveLength(1);
            expect(capabilities[0].providerPluginId).toBe('provider-a');
        });
    });

    describe('clear', () => {
        it('should remove all capabilities', () => {
            service.register(createCapabilityDefinition('cap-1'), {}, 'provider');
            service.register(createCapabilityDefinition('cap-2'), {}, 'provider');

            service.clear();

            expect(service.count()).toBe(0);
            expect(service.list()).toHaveLength(0);
        });
    });
});
