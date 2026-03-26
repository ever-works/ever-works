import { listDirectories, getDirectoryDetails, getDirectoryStats } from './directory.tools';
import { checkGitConnection } from './git.tools';
import { navigate } from './navigation.tools';

export const chatTools = {
    listDirectories,
    getDirectoryDetails,
    getDirectoryStats,
    checkGitConnection,
    navigate,
};

export type ChatTools = typeof chatTools;
