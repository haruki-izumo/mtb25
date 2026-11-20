# Extension ↔ Interview Manager backend

The Chrome extension no longer needs the standalone Express server in `rb5-extension/backend`.

## Pointing at the main app

In `sidepanel.js`:

```js
const API_BASE = "https://mtb25.onrender.com/api";
const DASHBOARD_URL = "https://mtb25.onrender.com/profiles";
```

For local Next.js, switch those to `http://localhost:3000/...`.

`manifest.json` includes `https://mtb25.onrender.com/*` (and localhost) host permissions.

## Login

Use Interview Manager users (seed):

- `admin@example.com` / `password123`
- member accounts also work (bidder role in the extension)

JWT is issued by `POST /api/auth/login` against Prisma `User` (bcrypt), separate from the NextAuth cookie session used by the web UI.

## Merged capabilities

| Area | Next.js routes |
|------|----------------|
| Profiles | `GET /api/profiles`, `GET /api/profiles/:id` |
| Manual generate | `POST /api/manual-generate/compose`, `/finish` |
| Free/Pro generate | `POST /api/full-generate-and-download` |
| Applications | `GET/PATCH /api/me/applications…` |
| API keys | `GET/POST /api/settings/api-keys?profileId=` |
| Stubs | prompts, templates, fit-rules, LinkedIn counts, etc. |

Generations are stored as Prisma `Application` rows with PDF files under `public/uploads/applications/`.

## Standalone backend

`rb5-extension/backend` remains for reference / smoke tests but is not required when the Next app is running.
