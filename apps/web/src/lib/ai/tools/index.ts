import type { LanguageModel } from 'ai';
import {
    listDirectories,
    getDirectoryDetails,
    getStats,
    getDirectoryItemsSummary,
    getDirectoryConfig,
    getGenerationHistory,
    getScheduleStatus,
    createDirectoryManual,
    createDirectoryWithAITool,
    importDirectoryTool,
    analyzeImportSource,
    updateDirectoryTool,
    deleteDirectoryTool,
    syncDirectory,
} from './directory.tools';
import { checkGitConnection, listGitProviders } from './git.tools';
import { listAvailablePipelines } from './providers.tools';
import { navigate, reloadPage } from './navigation.tools';
import {
    checkDeployConnection,
    deployDirectory,
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
import { createSuggestDirectoriesTool } from './suggest.tools';

/**
 * Build the full tool set for the chat agent.
 * The model parameter is needed by the suggestDirectories subagent
 * which runs its own generateText loop internally.
 */
export function buildChatTools(model: LanguageModel) {
    return {
        // Read
        listDirectories,
        getDirectoryDetails,
        getStats,
        getDirectoryItemsSummary,
        getDirectoryConfig,
        getGenerationHistory,
        getScheduleStatus,

        // Create
        createDirectoryManual,
        createDirectoryWithAI: createDirectoryWithAITool,
        importDirectory: importDirectoryTool,
        analyzeImportSource,

        // Update / Delete
        updateDirectory: updateDirectoryTool,
        deleteDirectory: deleteDirectoryTool,
        syncDirectory,

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
        deployDirectory,
        checkDeploymentStatus,
        listDomains,

        // Schedule
        setSchedule,
        runScheduleNow,
        cancelSchedule,

        // Search & User
        webSearch,
        getUserInfo,
        suggestDirectories: createSuggestDirectoriesTool(model),

        // Navigation
        navigate,
        reloadPage,
    };
}

export type ChatTools = ReturnType<typeof buildChatTools>;
