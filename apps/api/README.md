# Ever Works Backend APIs

Built with NestJS.

## How to run

1. Clone https://github.com/ever-co/ever-works

2. Create `.env` file (based on `.env.example`)

3. Run application using (cd to root of the whole repo, not backend app):

```sh
pnpm dev
```

4. Create directory object (in memory for now) using a request to `http://localhost:3001/directories` 
```json
{
	"slug": "awesome-time-tracking",
	"name": "Awesome Time Tracking",
	"description": "Time Tracking - Software, Methodologies and Practices."
}
```

By default it will create directory with currently authenticated GitHub user as an owner.
If you want to init directory for organization, pass optional `owner` field:

```json
{
	"slug": "awesome-time-tracking",
	"owner": "ever-works",
	"name": "Awesome Time Tracking",
	"description": "Time Tracking - Software, Methodologies and Practices."
}
```

5. Generate GitHub repositories using a request to `http://localhost:3001/generate`
```json
{
	"slug": "awesome-time-tracking",
	"prompt": "Generate list of best time tracking software"
}
```

6. Update GitHub repositories (generate new items) using a request to `http://localhost:3001/sync`
```json
{
	"slug": "awesome-time-tracking",
	"prompt": "Generate list of best time tracking software"
}
```

> For now it will push directly to the main branch. New items are generated and deduplicated against existing items from data repository (so it should work incrementially).

7. Deploy to Vercel (optional) using a request to `http://localhost:3001/deploy/awesome-time-tracking/vercel`
```json
// Optional:
{
    "GITHUB_TOKEN": "gh_sqjhqwghsydghsydfgsdyfgdsyf",
    "VERCEL_TOKEN": "e21qwyu2ewgfcuydesgf7udsdsfds"
}
```

> Request body is optional for now, by default it will take values from `.env` during development. Don't forget to change it before going to production, because it will save these tokens inside user's gh actions secrets...

> This endpoint will trigger GitHub Actions Workflow inside website repository. Important thing to note is that we cannot reuse `GITHUB_TOKEN` from github actions workflow because it has short lifetime while our website needs long living github token to make periodically clones, pulls etc.

## Prompt used to generate awesome time tracking in ever works org

```
Please build a directory of time tracking software for bussiness. Split it into 2 categories: open-source and commercial.
```

> Feel free to improve this prompt
