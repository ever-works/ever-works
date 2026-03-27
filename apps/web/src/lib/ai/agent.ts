import 'server-only';
import { convertToModelMessages, streamText, stepCountIs, type UIMessage } from 'ai';
import { createBackendProvider } from './provider';
import { chatTools } from './tools';
import { API_URL } from '@/lib/constants';

const MAX_TOOL_STEPS = 50;

const SYSTEM_PROMPT = `You are an AI assistant for Ever Works, a directory builder platform.
You have tools to help users. ALWAYS use them — never guess or fabricate data.

BEHAVIOR:
- When the user asks about their directories, items, or stats: call listDirectories or getDirectoryStats FIRST, then navigate to the relevant page.
- When the user wants to see a directory or its items: call listDirectories to find the matching directory, then navigate to it with the correct tab.
- When searching for items in a directory: find the directory first, then navigate to its items tab with a search query.
- Before creating a directory: always check git connection with checkGitConnection.
- ALWAYS redirect the user to the relevant page after fetching data. Use the navigate tool with search query when applicable.
- Do NOT output any text after calling the navigate tool — the UI handles the redirect.
- Be concise. Use markdown for formatting.`;

interface AgentOptions {
    messages: UIMessage[];
    authToken: string;
    providerOverride: string;
    directoryId?: string;
    conversationId?: string;
}

export async function runAgent({
    messages,
    authToken,
    providerOverride,
    directoryId,
    conversationId,
}: AgentOptions) {
    const provider = createBackendProvider({
        baseURL: `${API_URL}/v1`,
        authToken,
        providerOverride,
        directoryId,
        conversationId,
    });

    return streamText({
        model: provider.chatModel('auto'),
        system: SYSTEM_PROMPT,
        messages: await convertToModelMessages(messages),
        tools: chatTools,
        stopWhen: stepCountIs(MAX_TOOL_STEPS),
    });
}
