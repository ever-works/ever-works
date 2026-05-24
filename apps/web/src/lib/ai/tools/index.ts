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
    deleteWorkTool,
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
    removeItemTool,
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
    deleteMission,
    runMissionNow,
    cloneMission,
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

/**
 * Build the full tool set for the chat agent.
 * The model parameter is needed by the suggestWorks subagent
 * which runs its own generateText loop internally.
 */
export function buildChatTools(model: LanguageModel) {
    return {
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
        deleteWork: deleteWorkTool,
        syncWork,

        // Providers
        checkGitConnection,
        checkDeployConnection,
        listGitProviders,
        listAvailablePipelines,

        // Items
        addItem: addItemTool,
        removeItem: removeItemTool,
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
        deleteMission,
        runMissionNow,
        cloneMission,

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
