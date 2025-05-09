export interface WebPageData {
  source_url: string;
  html_content: string;
  retrieved_at: string; // ISO date string
  text_content?: string; // Extracted plain text
}

export interface RelevanceAssessment {
  relevant: boolean;
  relevance_score: number; // 0.0 to 1.0
  reason: string;
}