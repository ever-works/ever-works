# Attribution row — `ever-works/skills` README

> DRAFT — the row to add to the skills table in `ever-works/skills/README.md` in the same pull request as
> `manifest-row.json` (APW-04 T31). The README states that every skill is seeded from an upstream permissive
> repository, so a **first-party** skill needs this row to say where it came from and under which terms.

| Skill           | Origin                                                                      | Version | License | Notes                                                                                  |
| --------------- | --------------------------------------------------------------------------- | ------- | ------- | -------------------------------------------------------------------------------------- |
| `provision-app` | First party — authored in this repository, no upstream project to attribute | `0.1.0` | MIT     | `sourceUrl` points at this repository's own path; see `skills/provision-app/SKILL.md`. |

That is exactly what `manifest-row.json`'s `sourceUrl` encodes
(`https://github.com/ever-works/skills/tree/main/skills/provision-app`), which is the provenance field
`schema/skill-manifest.schema.json` requires.
