import { Injectable, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { ConfigDto } from '../dto/create-items-generator.dto';
import { AiService } from '../shared';

@Injectable()
export class SearchQueryGenerationService {
  private readonly logger = new Logger(SearchQueryGenerationService.name);
  private llm: ChatOpenAI;

  constructor(private readonly aiService: AiService) {
    this.llm = this.aiService.getLlm();
  }

  async generateSearchQueries(
    name: string,
    description: string,
    targetKeywords: string[] | undefined,
    config: Required<ConfigDto>,
  ): Promise<string[]> {
    this.logger.log(`[${name}] Generating search queries using LLM...`);

    if (!this.llm.apiKey) {
      this.logger.warn(
        `[${name}] OpenAI API Key not configured. Falling back to basic query generation.`,
      );
      const fallbackQueries = [
        `best tools for ${name}`,
        `${name} resources`,
        `${name} libraries`,
        `${name} tutorials`,
        `official documentation ${name}`,
        `community ${name}`,
      ];
      if (targetKeywords && targetKeywords.length > 0) {
        return [
          ...new Set([
            ...targetKeywords.map((kw) => `${kw} ${name}`),
            ...fallbackQueries,
          ]),
        ].slice(0, config.max_search_queries);
      }
      return [...new Set(fallbackQueries)].slice(0, config.max_search_queries);
    }

    const promptTemplate = PromptTemplate.fromTemplate(
      `You are an expert at generating highly relevant and diverse search engine queries to build a "Directory website" about a specific topic.
The topic is: "{name}"
Description: "{description}"
Optional initial keywords: {target_keywords_string}

Generate {num_queries} distinct search queries. Each query should be on a new line.
The queries should aim to discover:
- Key tools and software
- Essential libraries and frameworks
- Seminal articles and blog posts
- Official documentation and guides
- Comparisons and alternatives
- Awesome lists and directories

Consider variations, long-tail keywords, and queries targeting different facets of the topic.
Avoid overly broad or generic queries. Be specific.

Generated Queries:
`,
    );

    const queryGenerationChain = promptTemplate
      .pipe(this.llm)
      .pipe(new StringOutputParser());

    try {
      const result = await queryGenerationChain.invoke({
        name,
        description,
        target_keywords_string: targetKeywords
          ? targetKeywords.join(', ')
          : 'N/A',
        num_queries: config.max_search_queries * 2, // Generate more to allow for filtering
      });

      const queries = result
        .split('\n')
        .map((q) => q.trim().replace(/^- /, ''))
        .filter((q) => q.length > 3) // Filter out very short or empty lines
        .filter((q, index, self) => self.indexOf(q) === index); // Ensure uniqueness

      this.logger.log(
        `[${name}] LLM generated ${queries.length} unique queries.`,
      );
      return queries.slice(0, config.max_search_queries);
    } catch (error) {
      this.logger.error(
        `[${name}] Error generating search queries with LLM: ${error.message}`,
        error.stack,
      );
      this.logger.warn(
        `[${name}] Falling back to basic query generation due to LLM error.`,
      );
      // Fallback to simpler generation if LLM fails
      const fallbackQueries = [
        `best tools for ${name}`,
        `${name} resources`,
        `${name} libraries`,
        `${name} tutorials`,
        `official documentation ${name}`,
        `community ${name}`,
      ];
      if (targetKeywords && targetKeywords.length > 0) {
        return [
          ...new Set([
            ...targetKeywords.map((kw) => `${kw} ${name}`),
            ...fallbackQueries,
          ]),
        ].slice(0, config.max_search_queries);
      }
      return [...new Set(fallbackQueries)].slice(0, config.max_search_queries);
    }
  }
}
