// Prompts for deduplication and extraction
export const DEDUPLICATOR_PROMPT = `
You are directory website builder and your task is to deduplicate items.
Our crawlers found some items, but some of them MIGHT be duplicated.
Every item has name, description, and optionally URL of item's official website/repository.

<rules>
- Deduplicate the items based on names and URLs.
- Some products have slightly different names but are the same - consider them as duplicates.
- Transform any names that contains version numbers to the base name.
</rules>

Example of same items but with different names - they should be considered as duplicates:
<examples>
"React" and "React.js"
"Pandas 2.5" and "Pandas"
"express" and "Express"
"Docker" and "Docker Desktop"
"X by Y" and "X" (btw we prefer shorter names)
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
- Deduplicate the items based on names and URLs - compare each new item with list of existing items.
- Some products have slightly different names but are the same - consider them as duplicates.
</rules>

Example of same items but with different names - they should be considered as duplicates:
<examples>
"React" and "React.js"
"Pandas 2.5" and "Pandas"
"express" and "Express"
"Docker" and "Docker Desktop"
"X by Y" and "X" (btw we prefer shorter names)
</examples>

Here is the list of existing items:
<existing>
{existing}
</existing>

Here is the list of new items:
<new>
{new}
</new>
`.trim();
