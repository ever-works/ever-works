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

export const chatTools = {
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

    // Navigation
    navigate,
    reloadPage,
};

export type ChatTools = typeof chatTools;
