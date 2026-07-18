import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { parse as parseYaml } from 'yaml';
import { GitFacadeService } from '@ever-works/agent/facades';
import { AgentFileService, AgentScope, AgentsService } from '@ever-works/agent/agents';
import { SkillsService } from '@ever-works/agent/skills';
import { TasksService } from '@ever-works/agent/tasks-domain';
import { TeamsService } from '@ever-works/agent/teams';
import { WorkLifecycleService } from '@ever-works/agent/services';
import { UserRepository } from '@ever-works/agent/database';
import type { Organization } from '@ever-works/agent/entities';
import { ScopeContextService } from '../scope/scope-context.service';
import { OrganizationService } from './organization.service';
import {
    fetchPublicRawFile,
    ORGS_REPO_NAME,
    ORGS_REPO_OWNER,
    OrgTemplateCatalogService,
} from './org-template-catalog.service';

/**
 * Prebuilt-company importer (teams-and-companies spec §6.2).
 *
 * Materializes one agentcompanies/v1 package from `ever-works/orgs` into a
 * fresh Organization: COMPANY.md → Organization, TEAM.md → Team (+roster),
 * AGENTS.md → paused tenant-scope Agent (body → DB-inline AGENTS.md, E9
 * path; `reportsTo` wired in a second pass), SKILL.md → tenant Skill +
 * agent bindings, PROJECT.md → draft Work, TASK.md → Task.
 *
 * Failure model: Organization creation is the pivot — after it succeeds
 * every entity imports independently and failures land in the returned
 * `skipped[]` report instead of aborting (spec §6.2). Unknown vendor
 * sidecars (e.g. `.paperclip.yaml`) are ignored. Imported agents arrive
 * `draft` with no heartbeat cadence — a human enables them.
 */

interface Frontmatter {
    [key: string]: unknown;
}

interface ParsedDoc {
    path: string;
    slug: string;
    fm: Frontmatter;
    body: string;
}

export interface CompanyImportInput {
    templateSlug: string;
    /** Optional Organization display-name override from the wizard. */
    name?: string;
}

export interface CompanyImportReport {
    organization: Organization;
    created: {
        teams: number;
        agents: number;
        members: number;
        skills: number;
        works: number;
        tasks: number;
    };
    skipped: Array<{ path: string; reason: string }>;
}

// Server-side caps (spec §6.2) — catalog v1 companies stay far below these.
const MAX_AGENTS = 50;
const MAX_TEAMS = 20;
const MAX_SKILLS = 60;
const MAX_WORKS = 20;
const MAX_TASKS = 200;
const MAX_FILE_BYTES = 128 * 1024;

function splitFrontmatter(raw: string): { fm: Frontmatter; body: string } {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
    if (!m) return { fm: {}, body: raw.trim() };
    let fm: Frontmatter = {};
    try {
        const parsed = parseYaml(m[1]);
        if (parsed && typeof parsed === 'object') fm = parsed as Frontmatter;
    } catch {
        // Malformed YAML → treat as body-only; caller reports what's missing.
    }
    return { fm, body: raw.slice(m[0].length).trim() };
}

function str(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

@Injectable()
export class CompanyImportService {
    private readonly logger = new Logger(CompanyImportService.name);

    constructor(
        private readonly catalog: OrgTemplateCatalogService,
        private readonly git: GitFacadeService,
        private readonly organizationService: OrganizationService,
        private readonly scopeContext: ScopeContextService,
        private readonly teamsService: TeamsService,
        private readonly agentsService: AgentsService,
        private readonly agentFiles: AgentFileService,
        private readonly skillsService: SkillsService,
        private readonly tasksService: TasksService,
        private readonly workLifecycle: WorkLifecycleService,
        private readonly users: UserRepository,
    ) {}

    async importCompany(userId: string, input: CompanyImportInput): Promise<CompanyImportReport> {
        const pkg = await this.catalog.getPackage(input.templateSlug);
        if (!pkg) {
            throw new NotFoundException(`Company template ${input.templateSlug} not found`);
        }
        // ever-works/orgs is public: a resolved token routes through the git
        // facade (rate-limit headroom); tokenless falls back to
        // raw.githubusercontent.com, which has no meaningful anonymous cap —
        // load-bearing here, since one import reads up to ~100+ files.
        const token = await this.catalog.resolveToken();

        const skipped: Array<{ path: string; reason: string }> = [];
        const fetchFile = async (relPath: string): Promise<string | null> => {
            try {
                let content: string | null;
                if (token) {
                    const file = await this.git.getFileContent(
                        ORGS_REPO_OWNER,
                        ORGS_REPO_NAME,
                        `${pkg.path}/${relPath}`,
                        { token, providerId: 'github' },
                        this.catalog.ref(),
                    );
                    content = file?.content ?? null;
                } else {
                    content = await fetchPublicRawFile(
                        ORGS_REPO_OWNER,
                        ORGS_REPO_NAME,
                        this.catalog.ref(),
                        `${pkg.path}/${relPath}`,
                    );
                }
                if (content === null) return null;
                if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
                    skipped.push({ path: relPath, reason: 'file exceeds size cap' });
                    return null;
                }
                return content;
            } catch (err) {
                skipped.push({
                    path: relPath,
                    reason: `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
                });
                return null;
            }
        };

        // ── COMPANY.md (required pivot input) ──
        const companyRaw = await fetchFile('COMPANY.md');
        if (!companyRaw) {
            throw new NotFoundException(`Company template ${input.templateSlug} is missing COMPANY.md`);
        }
        const company = splitFrontmatter(companyRaw);
        const orgName = input.name?.trim() || str(company.fm.name) || pkg.name;

        // ── collect package docs by convention (inventory-driven, spec §6.1) ──
        const byPattern = (re: RegExp) =>
            pkg.files.filter((f) => re.test(f)).map((f) => ({ path: f, slug: f.split('/')[1] }));
        const agentFiles = byPattern(/^agents\/[a-z0-9-]+\/AGENTS\.md$/).slice(0, MAX_AGENTS);
        const teamFiles = byPattern(/^teams\/[a-z0-9-]+\/TEAM\.md$/).slice(0, MAX_TEAMS);
        const skillFiles = byPattern(/^skills\/[a-z0-9-]+\/SKILL\.md$/).slice(0, MAX_SKILLS);
        const projectFiles = byPattern(/^projects\/[a-z0-9-]+\/PROJECT\.md$/).slice(0, MAX_WORKS);
        const taskFiles = pkg.files
            .filter((f) => /^projects\/[a-z0-9-]+\/tasks\/[a-z0-9-]+\/TASK\.md$/.test(f))
            .slice(0, MAX_TASKS)
            .map((f) => ({ path: f, slug: f.split('/')[3], projectSlug: f.split('/')[1] }));

        const parseAll = async (
            files: Array<{ path: string; slug: string }>,
        ): Promise<ParsedDoc[]> => {
            const out: ParsedDoc[] = [];
            for (const f of files) {
                const raw = await fetchFile(f.path);
                if (raw === null) continue;
                const { fm, body } = splitFrontmatter(raw);
                out.push({ path: f.path, slug: f.slug, fm, body });
            }
            return out;
        };

        const [agentDocs, teamDocs, skillDocs, projectDocs] = [
            await parseAll(agentFiles),
            await parseAll(teamFiles),
            await parseAll(skillFiles),
            await parseAll(projectFiles),
        ];

        // ── pivot: create the Organization (lazy Tenant bootstrap included) ──
        const org = await this.organizationService.createOrganization(userId, orgName);
        const user = await this.users.findById(userId);
        if (!user) {
            throw new NotFoundException(`User ${userId} not found`);
        }

        const created = { teams: 0, agents: 0, members: 0, skills: 0, works: 0, tasks: 0 };

        // Run every entity-create inside the new org's scope so the
        // ScopeStampingSubscriber stamps tenantId/organizationId onto rows
        // whose services rely on ambient scope (agents, skills, works, tasks).
        await this.scopeContext.runWith(
            { tenantId: org.tenantId ?? null, organizationId: org.id },
            async () => {
                // ── agents (paused, manual heartbeat; body → DB-inline AGENTS.md) ──
                const agentIdBySlug = new Map<string, string>();
                for (const doc of agentDocs) {
                    try {
                        const agent = await this.agentsService.create(userId, {
                            scope: AgentScope.TENANT,
                            name: str(doc.fm.name) ?? doc.slug,
                            title: str(doc.fm.title),
                            heartbeatCadence: null,
                        });
                        agentIdBySlug.set(doc.slug, agent.id);
                        created.agents++;
                        if (doc.body) {
                            await this.agentFiles
                                .write({ userId, agentId: agent.id, name: 'AGENTS.md', body: doc.body })
                                .catch((err: unknown) =>
                                    skipped.push({
                                        path: doc.path,
                                        reason: `instructions not saved: ${err instanceof Error ? err.message : String(err)}`,
                                    }),
                                );
                        }
                    } catch (err) {
                        skipped.push({
                            path: doc.path,
                            reason: `agent not created: ${err instanceof Error ? err.message : String(err)}`,
                        });
                    }
                }

                // Second pass — reportsTo once every slug resolves (spec §6.2).
                for (const doc of agentDocs) {
                    const agentId = agentIdBySlug.get(doc.slug);
                    const managerSlug = str(doc.fm.reportsTo);
                    if (!agentId || !managerSlug) continue;
                    const managerId = agentIdBySlug.get(managerSlug);
                    if (!managerId) {
                        skipped.push({ path: doc.path, reason: `reportsTo "${managerSlug}" not found in package` });
                        continue;
                    }
                    await this.agentsService
                        .update(userId, agentId, { reportsToAgentId: managerId })
                        .catch((err: unknown) =>
                            skipped.push({
                                path: doc.path,
                                reason: `reportsTo not set: ${err instanceof Error ? err.message : String(err)}`,
                            }),
                        );
                }

                // ── teams (+ manager, roster, nesting via TEAM.md includes) ──
                const teamIdBySlug = new Map<string, string>();
                const agentSlugFromRef = (ref: unknown): string | null => {
                    const s = str(ref);
                    const m = s ? /agents\/([a-z0-9-]+)\/AGENTS\.md$/.exec(s) : null;
                    return m ? m[1] : null;
                };
                const teamSlugFromRef = (ref: unknown): string | null => {
                    const s = str(ref);
                    const m = s ? /teams\/([a-z0-9-]+)\/TEAM\.md$/.exec(s) : null;
                    return m ? m[1] : null;
                };
                for (const doc of teamDocs) {
                    try {
                        const managerSlug = agentSlugFromRef(doc.fm.manager);
                        const team = await this.teamsService.create(userId, org.id, {
                            name: str(doc.fm.name) ?? doc.slug,
                            slug: doc.slug,
                            description: str(doc.fm.description),
                            managerAgentId: managerSlug ? (agentIdBySlug.get(managerSlug) ?? null) : null,
                            metadata: {
                                source: {
                                    repo: `${ORGS_REPO_OWNER}/${ORGS_REPO_NAME}`,
                                    path: `${pkg.path}/${doc.path}`,
                                    slug: input.templateSlug,
                                },
                            },
                        });
                        teamIdBySlug.set(doc.slug, team.id);
                        created.teams++;
                    } catch (err) {
                        skipped.push({
                            path: doc.path,
                            reason: `team not created: ${err instanceof Error ? err.message : String(err)}`,
                        });
                    }
                }
                for (const doc of teamDocs) {
                    const teamId = teamIdBySlug.get(doc.slug);
                    if (!teamId) continue;
                    const includes = Array.isArray(doc.fm.includes) ? doc.fm.includes : [];
                    // Manager sits on the roster too — mirrors TEAM.md semantics.
                    const rosterSlugs = new Set<string>();
                    const managerSlug = agentSlugFromRef(doc.fm.manager);
                    if (managerSlug) rosterSlugs.add(managerSlug);
                    for (const ref of includes) {
                        const agentSlug = agentSlugFromRef(ref);
                        if (agentSlug) {
                            rosterSlugs.add(agentSlug);
                            continue;
                        }
                        const childTeamSlug = teamSlugFromRef(ref);
                        if (childTeamSlug) {
                            const childId = teamIdBySlug.get(childTeamSlug);
                            if (childId) {
                                await this.teamsService
                                    .update(org.id, childId, { parentTeamId: teamId })
                                    .catch(() =>
                                        skipped.push({ path: doc.path, reason: `could not nest team "${childTeamSlug}"` }),
                                    );
                            }
                        }
                        // Non-agent, non-team includes (e.g. shared skills) are hints — ignored.
                    }
                    for (const slug of rosterSlugs) {
                        const agentId = agentIdBySlug.get(slug);
                        if (!agentId) continue;
                        try {
                            await this.teamsService.addMember(userId, org.id, teamId, {
                                memberType: 'agent',
                                memberId: agentId,
                                role: slug === managerSlug ? 'lead' : 'member',
                            });
                            created.members++;
                        } catch {
                            // Duplicate roster rows (manager also in includes) are fine.
                        }
                    }
                }

                // ── skills (tenant-owned) + bindings from AGENTS.md skills: lists ──
                const skillIdBySlug = new Map<string, string>();
                for (const doc of skillDocs) {
                    try {
                        const skill = await this.skillsService.create(userId, {
                            ownerType: 'tenant',
                            ownerId: userId,
                            slug: doc.slug,
                            title: str(doc.fm.name) ?? doc.slug,
                            description: str(doc.fm.description) ?? '',
                            instructionsMd: doc.body,
                        });
                        skillIdBySlug.set(doc.slug, skill.id);
                        created.skills++;
                    } catch (err) {
                        skipped.push({
                            path: doc.path,
                            reason: `skill not created: ${err instanceof Error ? err.message : String(err)}`,
                        });
                    }
                }
                for (const doc of agentDocs) {
                    const agentId = agentIdBySlug.get(doc.slug);
                    if (!agentId || !Array.isArray(doc.fm.skills)) continue;
                    for (const shortname of doc.fm.skills) {
                        const skillId = typeof shortname === 'string' ? skillIdBySlug.get(shortname) : undefined;
                        if (!skillId) {
                            if (typeof shortname === 'string') {
                                skipped.push({ path: doc.path, reason: `skill "${shortname}" not found in package` });
                            }
                            continue;
                        }
                        await this.skillsService
                            .createBinding(userId, { skillId, targetType: 'agent', targetId: agentId })
                            .catch(() => undefined);
                    }
                }

                // ── projects → draft Works; TASK.md → Tasks ──
                const workIdByProjectSlug = new Map<string, string>();
                for (const doc of projectDocs) {
                    try {
                        const work = await this.workLifecycle.createDraftWork(user, {
                            name: str(doc.fm.name) ?? doc.slug,
                            slug: `${doc.slug}-${Date.now().toString(36)}`,
                            description: doc.body || undefined,
                        });
                        workIdByProjectSlug.set(doc.slug, work.id);
                        created.works++;
                    } catch (err) {
                        skipped.push({
                            path: doc.path,
                            reason: `work not created: ${err instanceof Error ? err.message : String(err)}`,
                        });
                    }
                }
                for (const tf of taskFiles) {
                    const raw = await fetchFile(tf.path);
                    if (raw === null) continue;
                    const { fm, body } = splitFrontmatter(raw);
                    try {
                        await this.tasksService.create(userId, {
                            title: str(fm.name) ?? tf.slug,
                            description: body || null,
                            workId: workIdByProjectSlug.get(tf.projectSlug) ?? null,
                            createdByType: 'user',
                            createdById: userId,
                        });
                        created.tasks++;
                    } catch (err) {
                        skipped.push({
                            path: tf.path,
                            reason: `task not created: ${err instanceof Error ? err.message : String(err)}`,
                        });
                    }
                }
            },
        );

        this.logger.log(
            `Imported company template "${input.templateSlug}" into org ${org.id}: ` +
                `${created.agents} agents, ${created.teams} teams, ${created.members} roster rows, ` +
                `${created.skills} skills, ${created.works} works, ${created.tasks} tasks (${skipped.length} skipped)`,
        );

        return { organization: org, created, skipped };
    }
}
