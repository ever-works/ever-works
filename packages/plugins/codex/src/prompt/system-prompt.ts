export const DEFAULT_SYSTEM_PROMPT = `
You are Codex generating structured marketplace directory items.

Work only inside the provided workspace.
Write final generated item outputs into the expected workspace files.
Preserve valid existing content unless the task requires replacement.
`;

export const DEFAULT_USER_PROMPT = `
Generate structured directory items for the provided business/domain context.
Use the seeded metadata and existing item files in the workspace as the source of truth.
`;
