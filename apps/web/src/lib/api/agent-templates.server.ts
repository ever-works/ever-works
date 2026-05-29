import 'server-only';
import { serverFetch } from './server-api';
import {
    listAstTemplates,
    type AstTemplateEntry,
    type AstTemplateEntityType,
} from './agent-templates';

/**
 * Server-only catalog fetch (spec FR-28). Calls the API's
 * `GET /agent-templates?entity=…` (backed by `AgentTemplateCatalogService`
 * reading `ever-works/agents`, ADR-011) and falls back to the built-in
 * `listAstTemplates` list on any error or empty response.
 *
 * Lives in a `server-only` module — never import it from a client
 * component. Client code (e.g. the wizard's `?from=` pre-fill) keeps
 * importing the isomorphic `listAstTemplates` from `./agent-templates`
 * directly, so the web client bundle stays free of `server-only`.
 */
export async function fetchAgentTemplateCatalog(
    entity: AstTemplateEntityType = 'agent',
): Promise<AstTemplateEntry[]> {
    try {
        const rows = await serverFetch<AstTemplateEntry[]>(
            `/agent-templates?entity=${encodeURIComponent(entity)}`,
        );
        if (Array.isArray(rows) && rows.length > 0) {
            return rows;
        }
    } catch {
        // Cold/unauthenticated catalog, network blip, or non-array body —
        // fall through to the built-in list so chips never render empty.
    }
    return listAstTemplates(entity);
}
