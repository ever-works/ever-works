import { Injectable } from '@nestjs/common';
import { BasePromptService } from './base-prompt.service';

export interface SearchServiceConfig {
    extractContentService: 'tavily' | 'naive';
    webSearchService: 'tavily' | 'google-sr';
    tavilyApiKey?: string;
}

@Injectable()
export class SearchServicePromptService extends BasePromptService {
    async promptSearchServiceConfiguration(): Promise<SearchServiceConfig> {
        this.displaySectionHeader('Search Service Configuration');
        this.displayInfo('Configure search and content extraction services');

        // Extract Content Service Configuration
        this.displayInfo('\n📄 Content Extraction Service');
        this.displayInfo('This service extracts content from web pages for analysis');

        const extractContentService = await this.promptSelect(
            'Select content extraction service:',
            [
                {
                    name: 'Tavily (Recommended) - High-quality content extraction with AI',
                    value: 'tavily' as const,
                },
                {
                    name: 'Naive - Basic content extraction (no API key required)',
                    value: 'naive' as const,
                },
            ]
        );

        // Web Search Service Configuration
        this.displayInfo('\n🔍 Web Search Service');
        this.displayInfo('This service searches the web for relevant information');

        const webSearchService = await this.promptSelect(
            'Select web search service:',
            [
                {
                    name: 'Tavily (Recommended) - AI-powered search with high-quality results',
                    value: 'tavily' as const,
                },
                {
                    name: 'Google Search Results - Basic web search (no API key required)',
                    value: 'google-sr' as const,
                },
            ]
        );

        // Tavily API Key (if needed)
        let tavilyApiKey: string | undefined;

        if (extractContentService === 'tavily' || webSearchService === 'tavily') {
            this.displayInfo('\n🔑 Tavily API Configuration');
            this.displayInfo('Get your API key from: https://tavily.com');
            this.displayInfo('Tavily provides high-quality AI-powered search and content extraction');

            while (true) {
                try {
                    tavilyApiKey = await this.promptPassword(
                        'Enter your Tavily API key:'
                    );

                    const validation = this.validateApiKey(tavilyApiKey, 'Tavily');
                    if (validation !== true) {
                        this.displayError(validation as string);
                        continue;
                    }

                    // Test the Tavily API key
                    this.displayInfo('Testing Tavily API key...');
                    const isValid = await this.testTavilyApiKey(tavilyApiKey);
                    if (!isValid) {
                        this.displayError('Tavily API key is invalid or lacks required permissions');
                        this.displayInfo('Please check your API key and try again');
                        continue;
                    }

                    this.displaySuccess('Tavily API key validated successfully');
                    break;
                } catch (error) {
                    this.displayError('Failed to validate Tavily API key. Please try again.');
                }
            }
        }

        // Display configuration summary
        this.displayInfo('\n📋 Configuration Summary:');
        this.displayInfo(`Content Extraction: ${extractContentService}`);
        this.displayInfo(`Web Search: ${webSearchService}`);
        if (tavilyApiKey) {
            this.displayInfo('Tavily API: Configured ✓');
        }

        this.displaySuccess('Search service configuration completed');

        return {
            extractContentService,
            webSearchService,
            tavilyApiKey,
        };
    }

    private async testTavilyApiKey(apiKey: string): Promise<boolean> {
        try {
            const response = await fetch('https://api.tavily.com/search', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    api_key: apiKey,
                    query: 'test',
                    max_results: 1,
                }),
            });
            return response.ok;
        } catch {
            return false;
        }
    }
}
