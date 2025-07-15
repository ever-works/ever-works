export interface Category {
  id: string;
  name: string;
  description?: string;
  icon_url?: string;
  priority?: number; // Lower numbers = higher priority (e.g., 1 = first, 2 = second, etc.)
}
