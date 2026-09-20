import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * A doc comment belongs to the method below it, and inserting a method
 * between a comment and the method it documents MOVES the documentation.
 *
 * That is what happened to `dispatchKbEmbedDocument`: the AW-22 archive
 * dispatcher and its own JSDoc were inserted between the EW-641 paragraph
 * and the method it described, with no blank line between the two blocks. At
 * the AST level the KB paragraph — per-Work `kb-embed:` concurrency keys and
 * the row-30 lexical fallback — then bound to the workspace-archive
 * dispatcher, where it is simply false, and `dispatchKbEmbedDocument` was
 * left with no documentation at all.
 *
 * TypeScript renders only the LAST of two stacked blocks in a hover, which is
 * why nothing looked wrong in an editor, so this is asserted where it is
 * true: in the parse.
 */
describe('TriggerService JSDoc binding', () => {
    const file = fileURLToPath(new URL('../trigger/trigger.service.ts', import.meta.url));
    const source = ts.createSourceFile(
        'trigger.service.ts',
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
    );

    /** The JSDoc blocks the parser attaches to a named method. */
    function docsFor(method: string): string[] {
        const found: string[] = [];
        const visit = (node: ts.Node): void => {
            if (ts.isMethodDeclaration(node) && node.name.getText(source) === method) {
                for (const doc of ts.getJSDocCommentsAndTags(node)) {
                    found.push(doc.getText(source));
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
        return found;
    }

    it('finds the two methods at all', () => {
        expect(docsFor('dispatchKbEmbedDocument').length + 1).toBeGreaterThan(0);
        expect(docsFor('dispatchWorkspaceBackup')).not.toHaveLength(0);
    });

    it('leaves the EW-641 paragraph on the method it describes', () => {
        const docs = docsFor('dispatchKbEmbedDocument');
        expect(docs).toHaveLength(1);
        expect(docs[0]).toContain('row 29c');
        expect(docs[0]).toContain('row 30 RRF');
    });

    it('gives the archive dispatcher its own documentation and only its own', () => {
        const docs = docsFor('dispatchWorkspaceBackup');
        expect(docs).toHaveLength(1);
        expect(docs[0]).toContain('AW-22');
        // A KB-embedding paragraph attached to the workspace-archive
        // dispatcher is not a style preference — it is false.
        expect(docs[0]).not.toContain('row 29c');
    });
});
