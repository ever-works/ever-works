# Ever Works Backend APIs

Built with NestJs

## How to run

1. Clone https://github.com/ever-co/ever-works
2. Update `.env` file (each app has own `env.example`)
3. Create directory object (in memory) using `http://localhost:3001/directories` 
```json
{
	"slug": "awesome-time-tracking",
	"name": "Awesome Time Tracking",
	"description": "Time Tracking - Software, Methodologies and Practices."
}
```

4. Generate GitHub repositories using `http://localhost:3001/generate`
```json
{
	"slug": "awesome-time-tracking",
	"prompt": "Generate list of best time tracking software"
}
```

5. Deploy to Vercel (optional) using `http://localhost:3001/deploy/awesome-time-tracking/vercel`
```json
// Optional:
{
    "GITHUB_TOKEN": "gh_sqjhqwghsydghsydfgsdyfgdsyf",
    "VERCEL_TOKEN": "e21qwyu2ewgfcuydesgf7udsdsfds"
}
```

> Request body is optional, by default it will take values from `.env` during development. 
