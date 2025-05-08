export interface Category {
  id: string; // Unique slugified ID, e.g., "data-visualization"
  name: string; // Canonical name, e.g., "Data Visualization"
  description?: string; // AI-generated or extracted summary of the category
  icon_url?: string; // Optional URL for a representative icon
}
