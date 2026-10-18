import type { LanguageModel } from 'ai';
import {
    listWorks,
    getWorkDetails,
    getStats,
    getWorkItemsSummary,
    getWorkConfig,
    getGenerationHistory,
    getScheduleStatus,
    createWorkManual,
    createWorkWithAITool,
    importWorkTool,
    analyzeImportSource,
    updateWorkTool,
    createDeleteWorkTool,
    syncWork,
} from './work.tools';
import { checkGitConnection, listGitProviders } from './git.tools';
import { listAvailablePipelines } from './providers.tools';
import { navigate, reloadPage } from './navigation.tools';
import {
    checkDeployConnection,
    deployWork,
    checkDeploymentStatus,
    listDomains,
} from './deploy.tools';
import {
    addItemTool,
    createRemoveItemTool,
    updateItemTool,
    generateItemsTool,
    checkItemHealthTool,
    regenerateMarkdownTool,
} from './items.tools';
import { setSchedule, runScheduleNow, cancelSchedule } from './schedule.tools';
import { webSearch } from './search.tools';
import { getUserInfo } from './user.tools';
import { createSuggestWorksTool } from './suggest.tools';
// Phase 9 PR Z1 — Missions + Ideas tools so the in-app chat can
// drive the same surfaces the dashboard buttons do.
import {
    listMissions,
    getMissionDetails,
    getMissionBudget,
    createMission,
    updateMission,
    pauseMission,
    resumeMission,
    completeMission,
    createDeleteMissionTool,
    runMissionNow,
    cloneMission,
    // PR-2 (domain-model evolution) — Mission ↔ Work relations.
    listMissionWorks,
    attachWorkToMission,
    detachWorkFromMission,
} from './missions.tools';
import {
    listIdeas,
    getIdeaDetails,
    getIdeaBudget,
    getIdeasRefreshStatus,
    createIdea,
    refreshIdeas,
    buildIdea,
    dismissIdea,
    acceptIdea,
} from './ideas.tools';
// Manifest-driven generated tools (agents, tasks, skills, notifications,
// members, api-keys, budgets/usage, webhooks, orgs, KB, templates, plugins …).
// One registry entry per platform operation — see ./generated/registry.ts.
import { buildGeneratedTools, type GeneratedToolsOptions } from './generated/factory';
import { ALL_OPERATIONS } from './generated/registry.all';
// Canvas rendering tools (charts / tables / stat tiles / detail panels).
import { buildCanvasTools } from './canvas.tools';
// Built-in report tools (fetch + aggregate + render to canvas).
import { buildReportTools } from './reports';

/**
 * Build the full tool set for the chat agent.
 * The model parameter is needed by the suggestWorks subagent
 * which runs its own generateText loop internally.
 *
 * Three sources are merged:
 *  1. hand-written domain tools (works / items / missions / ideas / deploy …),
 *  2. generated single-entity tools from the operation registry,
 *  3. canvas rendering tools.
 *
 * Hand-written tools are spread LAST so they win any name collision with a
 * generated entry (they carry richer, bespoke UX).
 */
export function buildChatTools(model: LanguageModel, options: GeneratedToolsOptions = {}) {
    return {
        // Security: `options.userConfirmed` ties every gated generated tool's
        // `confirmed: true` to the user's own latest message (see
        // ./generated/confirmation.ts).
        ...buildGeneratedTools(ALL_OPERATIONS, options),
        ...buildCanvasTools(),
        ...buildReportTools(),

        // Read
        listWorks,
        getWorkDetails,
        getStats,
        getWorkItemsSummary,
        getWorkConfig,
        getGenerationHistory,
        getScheduleStatus,

        // Create
        createWorkManual,
        createWorkWithAI: createWorkWithAITool,
        importWork: importWorkTool,
        analyzeImportSource,

        // Update / Delete
        updateWork: updateWorkTool,
        // Same user-turn confirmation check as the generated tools.
        deleteWork: createDeleteWorkTool(options.userConfirmed),
        syncWork,

        // Providers
        checkGitConnection,
        checkDeployConnection,
        listGitProviders,
        listAvailablePipelines,

        // Items
        addItem: addItemTool,
        removeItem: createRemoveItemTool(options.userConfirmed),
        updateItem: updateItemTool,
        generateItems: generateItemsTool,
        checkItemHealth: checkItemHealthTool,
        regenerateMarkdown: regenerateMarkdownTool,

        // Deploy
        deployWork,
        checkDeploymentStatus,
        listDomains,

        // Schedule
        setSchedule,
        runScheduleNow,
        cancelSchedule,

        // Search & User
        webSearch,
        getUserInfo,
        suggestWorks: createSuggestWorksTool(model),

        // Navigation
        navigate,
        reloadPage,

        // Phase 9 PR Z1 — Missions
        listMissions,
        getMissionDetails,
        getMissionBudget,
        createMission,
        updateMission,
        pauseMission,
        resumeMission,
        completeMission,
        deleteMission: createDeleteMissionTool(options.userConfirmed),
        runMissionNow,
        cloneMission,

        // PR-2 — Mission ↔ Work relations (attach/detach, never ownership)
        listMissionWorks,
        attachWorkToMission,
        detachWorkFromMission,

        // Phase 9 PR Z1 — Ideas
        listIdeas,
        getIdeaDetails,
        getIdeaBudget,
        getIdeasRefreshStatus,
        createIdea,
        refreshIdeas,
        buildIdea,
        dismissIdea,
        acceptIdea,
    };
}

export type ChatTools = ReturnType<typeof buildChatTools>;
