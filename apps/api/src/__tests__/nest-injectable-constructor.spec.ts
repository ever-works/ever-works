import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * A DI guard for the failure mode that shipped in APW-11 T26, measured 2026-09-18.
 *
 * `LauncherDelegatedCorsMiddleware` was declared as
 *
 *     constructor(origins?: readonly string[]) { this.origins = origins ?? resolveLauncherOrigins(); }
 *
 * — a deliberate test seam. Nest, however, reads every undecorated constructor parameter as an
 * injectable dependency, so the whole API refused to boot:
 *
 *     UnknownDependenciesException: Nest can't resolve dependencies of the
 *     LauncherDelegatedCorsMiddleware (?). Please make sure that the argument at index [0] is
 *     available in the current module.
 *     … dependencies: [ [Function: Object] ]
 *
 * Neither the 15-case unit spec nor `type-check` could see it: the spec constructs the class by hand
 * (`new LauncherDelegatedCorsMiddleware(['https://…'])`), which is exactly the path DI never takes.
 * The fix is `@Optional()` on that parameter.
 *
 * The rule this pins, and why it is safe to be strict about it: an **array or primitive** type is
 * never a valid Nest token. Nest derives a token from a class's runtime metatype, and `readonly
 * string[]`, `string`, `number`, `boolean` and object literals all emit `Array`, `String`, `Number`,
 * `Boolean` or `Object` — none of which any module can provide. So requiring `@Inject(...)` or
 * `@Optional()` on such a parameter cannot reject a legitimate injection; it can only catch a
 * parameter that was never injectable in the first place.
 */
describe('Nest injectable constructors declare only injectable dependencies', () => {
    const API_SRC = join(__dirname, '..');

    /** Nest-visible classes: the ones the container instantiates. */
    const DECORATOR = /^\s*@(Injectable|Controller|Catch)\(/;
    /** A parameter that is explicitly typed as something Nest cannot resolve to a provider. */
    const NON_INJECTABLE_TYPE =
        /^\s*(?:private\s+|protected\s+|public\s+|readonly\s+)*[\w$]+\s*[?!]?\s*:\s*(readonly\s+)?[\w$.<>[\]|&\s]*?(\[\s*\]|\bstring\b|\bnumber\b|\bboolean\b|\bobject\b)\s*$/;

    function sourceFiles(dir: string, acc: string[] = []): string[] {
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) {
                if (entry === 'node_modules' || entry === 'dist') continue;
                sourceFiles(full, acc);
            } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
                acc.push(full);
            }
        }
        return acc;
    }

    /** Splits a parameter list on commas that are not nested inside brackets or generics. */
    function splitParams(list: string): string[] {
        const parts: string[] = [];
        let depth = 0;
        let current = '';
        for (const char of list) {
            if ('(<[{'.includes(char)) depth += 1;
            if (')>]}'.includes(char)) depth -= 1;
            if (char === ',' && depth === 0) {
                parts.push(current);
                current = '';
                continue;
            }
            current += char;
        }
        if (current.trim()) parts.push(current);
        return parts;
    }

    interface Finding {
        file: string;
        line: number;
        className: string;
        parameter: string;
    }

    function scan(): { findings: Finding[]; constructors: number; files: number } {
        const findings: Finding[] = [];
        let constructors = 0;
        const files = sourceFiles(API_SRC);

        for (const file of files) {
            const lines = readFileSync(file, 'utf8').split('\n');
            for (let i = 0; i < lines.length; i += 1) {
                if (!DECORATOR.test(lines[i])) continue;
                // The class this decorator belongs to, within the next few lines.
                let classLine = -1;
                for (let j = i + 1; j < Math.min(i + 6, lines.length); j += 1) {
                    if (/^\s*export\s+(abstract\s+)?class\s+(\w+)/.test(lines[j])) {
                        classLine = j;
                        break;
                    }
                }
                if (classLine === -1) continue;
                const className = /class\s+(\w+)/.exec(lines[classLine])![1];

                // Its constructor, if it declares one.
                let ctorLine = -1;
                for (let j = classLine + 1; j < lines.length; j += 1) {
                    if (/^\}/.test(lines[j])) break; // class ended
                    if (/^\s*constructor\s*\(/.test(lines[j])) {
                        ctorLine = j;
                        break;
                    }
                }
                if (ctorLine === -1) continue;
                constructors += 1;

                // Collect the parameter list, which may wrap over several lines.
                let text = '';
                let end = ctorLine;
                while (end < lines.length) {
                    text += lines[end] + '\n';
                    if (/\)\s*(:|\{)/.test(lines[end])) break;
                    end += 1;
                }
                const open = text.indexOf('(');
                const close = text.lastIndexOf(')');
                if (open === -1 || close <= open) continue;
                const body = text.slice(open + 1, close);

                for (const raw of splitParams(body)) {
                    const parameter = raw.replace(/\s+/g, ' ').trim();
                    if (!parameter) continue;
                    if (parameter.includes('@Inject(') || parameter.includes('@Optional('))
                        continue;
                    if (!NON_INJECTABLE_TYPE.test(parameter)) continue;
                    findings.push({
                        file: relative(API_SRC, file).replace(/\\/g, '/'),
                        line: ctorLine + 1,
                        className,
                        parameter,
                    });
                }
            }
        }
        return { findings, constructors, files: files.length };
    }

    it('scans the API at all (a silent zero here would make this guard useless)', () => {
        const { constructors, files } = scan();
        expect(files).toBeGreaterThan(200);
        expect(constructors).toBeGreaterThan(30);
    });

    it('gives every array/primitive constructor parameter a Nest parameter decorator', () => {
        const { findings } = scan();
        const report = findings.map((f) => `${f.file}:${f.line} ${f.className}(…${f.parameter}…)`);
        expect(report).toEqual([]);
    });
});
