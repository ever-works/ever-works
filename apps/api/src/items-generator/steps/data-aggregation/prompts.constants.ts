// Prompts for deduplication and extraction
export const DEDUPLICATOR_PROMPT = `
You are directory website builder and your task is to deduplicate items.
Our crawlers found some items, but some of them MIGHT be duplicated.
Every item has name, description, and optionally URL of item's official website/repository.

<rules>
- Deduplicate the items based on names and URLs.
- Some products have slightly different names but are the same - consider them as duplicates.
- Transform any names that contains version numbers to the base name.
- featured field should remain the same as in the original item
</rules>

Example of same items but with different names - they should be considered as duplicates:
<examples>
"React" and "React.js"
"Pandas 2.5" and "Pandas"
"express" and "Express"
"Docker" and "Docker Desktop"
"X by Y" and "X" (btw we prefer shorter names)
"github.com/user/repo" and "github.com/user/repo/tree/main"
"example.com" and "www.example.com"
</examples>

Here is the list of items to deduplicate:
<items>
{items}
</items>
`.trim();

export const EXTRACT_NEW_ITEMS_PROMPT = `
You are directory website builder and your task is to extract new items from the list.
We don't want to show duplicates to our users, so return only new items that don't exist in existing items list.

<rules>
- Compare each new item with the list of existing items to identify duplicates
- Items are considered duplicates if they have:
  * Same or very similar names (ignoring case, version numbers, common suffixes)
  * Same or similar source URLs (especially same domain/repository)
  * Same underlying product/tool/library even with different naming
- When in doubt, prefer to mark as duplicate rather than include a potential duplicate
- Return only items that are genuinely new and not already represented in the existing list
- featured field should remain the same as in the new item
</rules>

Example of same items but with different names - they should be considered as duplicates:
<examples>
"React" and "React.js"
"Pandas 2.5" and "Pandas"
"express" and "Express"
"Docker" and "Docker Desktop"
"X by Y" and "X" (btw we prefer shorter names)
"github.com/user/repo" and "github.com/user/repo/tree/main"
"example.com" and "www.example.com"
</examples>

Here is the list of existing items (these are the most relevant existing items based on similarity):
<existing>
{existing}
</existing>

Here is the list of new items to check:
<new>
{new}
</new>

Return only the items from the new list that are NOT duplicates of any existing items.
`.trim();
