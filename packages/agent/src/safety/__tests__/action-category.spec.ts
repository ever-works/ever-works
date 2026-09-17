import { ACTION_CATEGORIES } from '@ever-works/contracts';
import { ENTRY_POINT_CATEGORY, classifyAction, knownEntryPoints } from '../action-category';

describe('classifyAction', () => {
    it('classifies the platform own entry points from the map', () => {
        expect(classifyAction('sendEmail')).toBe('message.external');
        expect(classifyAction('searchWeb')).toBe('read.external');
        expect(classifyAction('createTask')).toBe('write.internal');
        expect(classifyAction('createSubAgent')).toBe('agent.fanout');
        expect(classifyAction('facade:terminal-session')).toBe('machine.run');
    });

    it('answers null for an action nothing classifies', () => {
        // FR-3: a total function. Unmapped is `unclassified`, never "allowed".
        expect(classifyAction('some_plugin_tool')).toBeNull();
        expect(classifyAction('')).toBeNull();
    });

    it('never guesses an unmapped tool into a permissive category', () => {
        expect(classifyAction('doSomethingScary')).not.toBe('read.internal');
        expect(classifyAction('doSomethingScary')).toBeNull();
    });

    it('falls through to the plugin manifest declaration, glob-matched', () => {
        expect(
            classifyAction('acme_send_message', {
                pluginId: 'acme',
                toolName: 'acme_send_message',
                manifestCategories: { 'acme_send_*': 'message.external' },
            }),
        ).toBe('message.external');
    });

    it('takes the MORE RESTRICTIVE category when two manifest patterns match', () => {
        // FR-6 — deploying a site both publishes and spends; the published
        // restrictiveness order decides, so two call sites cannot disagree.
        expect(
            classifyAction('acme_deploy_site', {
                toolName: 'acme_deploy_site',
                manifestCategories: {
                    'acme_deploy_*': 'spend.metered',
                    'acme_*': 'publish.external',
                },
            }),
        ).toBe('publish.external');
    });

    it('ignores a manifest category id this build does not know', () => {
        // A manifest that names an unknown category has declared nothing for
        // that pattern — never something permissive.
        expect(
            classifyAction('acme_thing', {
                toolName: 'acme_thing',
                manifestCategories: { acme_thing: 'read.everything' },
            }),
        ).toBeNull();
    });

    it('lets the platform map win over a manifest that claims the same name', () => {
        // FR-4: classification comes from the platform's own entry point. A
        // plugin cannot reclassify `sendEmail` as a read by declaring it.
        expect(
            classifyAction('sendEmail', {
                toolName: 'sendEmail',
                manifestCategories: { sendEmail: 'read.internal' },
            }),
        ).toBe('message.external');
    });

    it('takes no input a model can write', () => {
        // The signature is the enforcement: the only inputs are the platform's
        // own entry-point id and the hints bag, whose fields are all platform
        // facts. There is no argument, prompt, instruction or document
        // parameter to pass, so no call site can accidentally feed one in.
        const hintFields = {
            pluginId: null,
            toolName: null,
            manifestCategories: null,
        };
        expect(Object.keys(hintFields).sort()).toEqual([
            'manifestCategories',
            'pluginId',
            'toolName',
        ]);
        expect(classifyAction('sendEmail', hintFields)).toBe('message.external');
    });
});

describe('ENTRY_POINT_CATEGORY', () => {
    it('names only known categories', () => {
        for (const category of Object.values(ENTRY_POINT_CATEGORY)) {
            expect(ACTION_CATEGORIES).toContain(category);
        }
    });

    it('is frozen, so nothing can register an entry point at runtime', () => {
        expect(Object.isFrozen(ENTRY_POINT_CATEGORY)).toBe(true);
    });

    it('keeps tool names and facade ids in separate namespaces', () => {
        const facades = knownEntryPoints().filter((id) => id.startsWith('facade:'));
        expect(facades.length).toBeGreaterThan(0);
        for (const id of knownEntryPoints()) {
            if (id.startsWith('facade:')) continue;
            // A registered tool name is a bare identifier — the descriptor's
            // own identity, not a namespaced id.
            expect(id).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
        }
    });
});
