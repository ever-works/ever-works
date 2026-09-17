import { getMetadataArgsStorage } from 'typeorm';
import { SharedView, sharedViewDefaults } from '../shared-view.entity';

describe('SharedView entity', () => {
    const storage = getMetadataArgsStorage();
    const columns = storage.columns.filter((column) => column.target === SharedView);
    const column = (name: string) => columns.find((entry) => entry.propertyName === name);

    it('starts with the board on, knowledge off, nothing selected and crawlers blocked', () => {
        expect(sharedViewDefaults()).toEqual({
            status: 'active',
            sections: { board: true, knowledge: false },
            knowledgeClasses: [],
            searchIndexable: false,
            viewCount: 0,
            rotationCount: 0,
        });
    });

    it('hands out a fresh defaults object each time, so one row cannot mutate another', () => {
        const first = sharedViewDefaults();
        first.sections.knowledge = true;
        first.knowledgeClasses.push('glossary');
        expect(sharedViewDefaults().sections.knowledge).toBe(false);
        expect(sharedViewDefaults().knowledgeClasses).toEqual([]);
    });

    it('maps to shared_views with the database defaults the migration declares', () => {
        const table = storage.tables.find((entry) => entry.target === SharedView);
        expect(table?.name).toBe('shared_views');
        expect(column('status')?.options.default).toBe('active');
        expect(column('searchIndexable')?.options.default).toBe(false);
        expect(column('viewCount')?.options.default).toBe(0);
        expect(column('rotationCount')?.options.default).toBe(0);
    });

    it('keeps the re-copyable token behind the encrypted column transformer', () => {
        const token = column('tokenEncrypted');
        expect(token?.options.type).toBe('simple-json');
        expect(token?.options.transformer).toBeDefined();
        expect(column('tokenHash')?.options.length).toBe(64);
    });

    it('declares one view per Workspace and one view per token hash', () => {
        const indices = storage.indices.filter((entry) => entry.target === SharedView);
        const unique = indices
            .filter((entry) => entry.unique)
            .map((entry) => entry.columns)
            .sort();
        expect(unique).toEqual([['organizationId'], ['tokenHash']]);
    });
});
