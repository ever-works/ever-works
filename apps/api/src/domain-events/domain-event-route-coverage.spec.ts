import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import { isDomainEventType } from '@ever-works/contracts';
import { DOMAIN_EVENT_ROUTE_COVERAGE, describeCoverage } from './domain-event-route-coverage';

/**
 * The event-coverage gate (EW-P1-1, spec §3): every mutating route of a
 * controller in the domain-event scope is listed in
 * `DOMAIN_EVENT_ROUTE_COVERAGE` — with the catalog events it records, or the
 * reason it records none. A new POST/PUT/PATCH/DELETE route on one of these
 * controllers fails here until someone decides.
 *
 * The routes are read from the controllers' source with the TypeScript parser
 * rather than by importing the classes: importing them pulls in the whole
 * agent service graph, including ESM-only packages (`github-slugger`, `p-map`)
 * this jest environment cannot load. Every `@Controller` / route decorator in
 * scope takes a string literal (or nothing); anything else fails the first
 * test so the gate cannot go silently blind.
 */
const CONTROLLER_FILES: readonly string[] = [
    'tasks/tasks.controller.ts',
    'tasks/task-chat.controller.ts',
    'task-templates/task-templates.controller.ts',
    'teams/teams.controller.ts',
    'organizations/organization-invitations.controller.ts',
    'organizations/organizations.controller.ts',
    'onboarding/org-invite.controller.ts',
    'agents/agents.controller.ts',
    'agents/agent-collaborators.controller.ts',
    'works/members.controller.ts',
    'works/works.controller.ts',
    'work-proposals/work-proposals.controller.ts',
    'goals/goals.controller.ts',
    'missions/missions.controller.ts',
    // Inbox (EW-P3-1) and the other doors that close an Inbox mirror.
    'inbox/inbox.controller.ts',
    'escalations/escalations.controller.ts',
    'agent-approvals/agent-approvals.controller.ts',
    // Knowledge Base (EW-P3-2): documents, the organization library and its folders.
    'works/kb.controller.ts',
    'works/org-kb.controller.ts',
    'knowledge-library/knowledge-library.controller.ts',
    'memory-files/memory-files.controller.ts',
    'works/org-memory.controller.ts',
    // Integration API v1 (EW-P1-4) — writes delegate to the same services.
    'integrations-api/v1/tasks-write.controller.ts',
    'integrations-api/v1/tasks-sets.controller.ts',
    'integrations-api/v1/task-comments.controller.ts',
    'integrations-api/v1/teams-write.controller.ts',
    // P2 resources (EW-P2-1 ideas).
    'integrations-api/v1/ideas.controller.ts',
    'integrations-api/v1/goals.controller.ts',
    'integrations-api/v1/missions.controller.ts',
    'integrations-api/v1/organizations-write.controller.ts',
    'integrations-api/v1/works-write.controller.ts',
    'integrations-api/v1/inbox.controller.ts',
    'integrations-api/v1/kb.controller.ts',
    'integrations-api/v1/email.controller.ts',
];

const MUTATING = new Map<string, string>([
    ['Post', 'POST'],
    ['Put', 'PUT'],
    ['Patch', 'PATCH'],
    ['Delete', 'DELETE'],
    ['All', 'ALL'],
]);

function joinPath(...parts: Array<string | undefined>): string {
    const segments = parts
        .filter((part): part is string => typeof part === 'string')
        .map((part) => part.replace(/^\/+|\/+$/g, ''))
        .filter((part) => part.length > 0);
    return `/${segments.join('/')}`;
}

interface DecoratorCall {
    readonly name: string;
    /** The literal path argument; `undefined` when there is none. */
    readonly path: string | undefined;
    /** True when an argument exists but is not a string literal. */
    readonly dynamic: boolean;
}

function decoratorCalls(node: ts.Node): DecoratorCall[] {
    const decorators = ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
    const calls: DecoratorCall[] = [];
    for (const decorator of decorators) {
        const expression = decorator.expression;
        if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) continue;
        const [first] = expression.arguments;
        const literal = first && ts.isStringLiteralLike(first) ? first.text : undefined;
        calls.push({
            name: expression.expression.text,
            path: literal,
            dynamic: first !== undefined && literal === undefined,
        });
    }
    return calls;
}

interface ScannedRoutes {
    readonly routes: string[];
    readonly controllers: string[];
    readonly unreadable: string[];
}

/** Every mutating route of the controllers in scope, as `METHOD /path`. */
function scanMutatingRoutes(): ScannedRoutes {
    const routes: string[] = [];
    const controllers: string[] = [];
    const unreadable: string[] = [];
    for (const file of CONTROLLER_FILES) {
        const source = ts.createSourceFile(
            file,
            readFileSync(join(__dirname, '..', file), 'utf8'),
            ts.ScriptTarget.Latest,
            true,
        );
        for (const statement of source.statements) {
            if (!ts.isClassDeclaration(statement)) continue;
            const controller = decoratorCalls(statement).find((call) => call.name === 'Controller');
            if (!controller) continue;
            const className = statement.name?.text ?? '<anonymous>';
            controllers.push(className);
            if (controller.dynamic) unreadable.push(`${file}: @Controller on ${className}`);
            for (const member of statement.members) {
                if (!ts.isMethodDeclaration(member)) continue;
                for (const call of decoratorCalls(member)) {
                    const verb = MUTATING.get(call.name);
                    if (!verb) continue;
                    const method = member.name.getText(source);
                    if (call.dynamic) unreadable.push(`${file}: @${call.name} on ${method}`);
                    routes.push(`${verb} ${joinPath(controller.path, call.path)}`);
                }
            }
        }
    }
    return { routes, controllers, unreadable };
}

describe('domain event route coverage', () => {
    const { routes, controllers, unreadable } = scanMutatingRoutes();

    it('reads every controller in scope (a silent zero would make the gate useless)', () => {
        expect(controllers).toHaveLength(CONTROLLER_FILES.length);
        expect(unreadable).toEqual([]);
        expect(routes.length).toBeGreaterThan(20);
        expect(routes).toContain('POST /api/tasks');
        expect(routes).toContain('PATCH /api/task-chat-messages/:id');
        expect(routes).toContain('POST /api/organizations/:orgId/teams');
    });

    it('lists every mutating route in scope with its events or an exemption', () => {
        const missing = routes.filter((route) => !(route in DOMAIN_EVENT_ROUTE_COVERAGE));
        expect(missing).toEqual([]);
    });

    it('names only catalog types, and gives every exemption a reason', () => {
        for (const [route, coverage] of Object.entries(DOMAIN_EVENT_ROUTE_COVERAGE)) {
            if ('events' in coverage) {
                expect({
                    route,
                    unknown: coverage.events.filter((type) => !isDomainEventType(type)),
                }).toEqual({
                    route,
                    unknown: [],
                });
                expect(coverage.events.length).toBeGreaterThan(0);
            } else {
                expect({ route, reason: coverage.exempt.length > 10 }).toEqual({
                    route,
                    reason: true,
                });
            }
        }
    });

    it('keeps no stale entry for a route that no longer exists', () => {
        const stale = Object.keys(DOMAIN_EVENT_ROUTE_COVERAGE).filter(
            (route) => !routes.includes(route),
        );
        expect(
            stale.map(
                (route) => `${route} (${describeCoverage(DOMAIN_EVENT_ROUTE_COVERAGE[route])})`,
            ),
        ).toEqual([]);
    });
});
