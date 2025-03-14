import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { tavily } from '@tavily/core';
import { Logger } from "@nestjs/common";


const searches = new Map<string, string[]>();

export  function getLastSearches(directoryId: string) {
    return searches.get(directoryId) || [];
}

export const SearchWebTool = tool(
    async (input, options) => {
        
        const directoryId = options.metadata.directoryId;
        const logger = new Logger('Tool:SearchWeb');
        logger.log('Searching the web with query: "' + input.query + '"');
        const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });
        const response = await tvly.search(input.query, {});
        const urls = response.results.map((result) => result.url);
        logger.log('Extracting contents from URLs');
        const contents = await tvly.extract(urls, {});

        if (searches.has(directoryId)) {
            logger.log('Adding search query to existing searches for: ' + directoryId);
            searches.get(directoryId)?.push(input.query);
        } else {
            logger.log('Creating new search query list for: ' + directoryId);
            searches.set(directoryId, [input.query]);
        }

        return JSON.stringify(contents.results);
    },
    {
        name: "search_web",
        description: "Search the web for information.",
        schema: z.object({
            query: z.string().describe('The search query'),
        }),
    }
);

export const RecentQueriesTool = tool(
    async (_, options) => {
        const directoryId = options.metadata.directoryId;
        const logger = new Logger('Tool:RecentQueries');
        logger.log('Retrieving recent queries for: ' + directoryId);
        const queries = getLastSearches(directoryId);
        return JSON.stringify(queries);
    },
    {
        name: 'recent_queries',
        description: 'Always call it before searching the web. This tool returns list of used search queries so you can generate new one.',
        schema: z.object({}),
    }
);
