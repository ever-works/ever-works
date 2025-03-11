import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { tavily } from '@tavily/core';
import { Logger } from "@nestjs/common";

export const SearchWebTool = tool(
    async (input): Promise<string> => {
        const logger = new Logger('Tool:SearchWeb');
        logger.log('Searching the web with query: "' + input.query + '"');
        const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });
        const response = await tvly.search(input.query, {});
        const urls = response.results.map((result) => result.url);
        logger.log('Extracting contents from URLs');
        const contents = await tvly.extract(urls, {});

        return JSON.stringify(contents.results);
    },
    {
        name: "search_web",
        description: "Search the web for information",
        schema: z.object({
            query: z.string().describe('The search query'),
        }),
    }
);
