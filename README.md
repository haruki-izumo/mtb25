# Interview Manager

Internal web app for managing job interviews across candidate profiles.

## Tech stack

- Next.js (App Router) + TypeScript + Tailwind CSS + shadcn/ui
- PostgreSQL + Prisma
- Docker Compose for local Postgres

## Prerequisites

- Node.js 20+
- Docker Desktop **or** PostgreSQL 16+ locally on port 5432

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Start Postgres

**Docker Compose (recommended):**

```bash
docker compose up -d
```

This starts Postgres with user/password/db `interview` / `interview` / `interview_manager`.

**Local Postgres:** create a role and database that match `.env.example` (or update `DATABASE_URL`):

```sql
CREATE ROLE interview LOGIN PASSWORD 'interview' CREATEDB;
CREATE DATABASE interview_manager OWNER interview;
```

### 3. Environment

```bash
cp .env.example .env
```

Default connection string:

```
DATABASE_URL="postgresql://interview:interview@localhost:5432/interview_manager?schema=public"
```

### 4. Migrate and seed

```bash
npx prisma migrate dev --name init
npm run db:seed
```

Or in one step after migrations exist:

```bash
npx prisma migrate reset
```

### 5. Auth secret

Ensure `.env` has `AUTH_SECRET` (see `.env.example`). Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 6. Run the app

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and sign in.

### Tests

```bash
npm test
```

## Seed accounts

Password for all users: `password123`

| Email | Role |
|-------|------|
| admin@example.com | ADMIN |
| taylor@example.com | MEMBER |
| jamie@example.com | MEMBER |
| chris@example.com | MEMBER |
| avery@example.com | MEMBER |
| drew@example.com | MEMBER |
| morgan@example.com | INTERVIEWER |

Seed includes 6 profiles (US/UK/CA), weekly availability, ~25 interview processes with rounds across the current and previous week, and team announcements.

## Useful scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start Next.js dev server |
| `npm run db:migrate` | Run Prisma migrations |
| `npm run db:seed` | Seed realistic demo data |
| `npm run db:studio` | Open Prisma Studio |
| `npm run db:reset` | Reset DB, remigrate, and seed |

## Deploy (Render)

Set these environment variables on the Render service (local `.env` is not uploaded):

| Variable | Required | Notes |
|----------|----------|--------|
| `DATABASE_URL` | yes | Render Postgres connection string |
| `AUTH_SECRET` | yes | Long random string (same generator as Setup §5) |
| `AUTH_URL` | yes | Public app URL, e.g. `https://your-service.onrender.com` |
| `EXTENSION_JWT_SECRET` | recommended | Separate secret for the Chrome extension API JWTs |

Without `AUTH_SECRET`, Auth.js fails at runtime with `MissingSecret`.

**Build / start commands**

| Setting | Value |
|---------|--------|
| Build Command | `npm install && npx prisma migrate deploy && npm run build` |
| Start Command | `npm run start` |

`npm run build` runs `prisma generate` before `next build` so TypeScript sees the current schema. `prisma migrate deploy` applies migrations to the Render database.

**Seed demo users (one-time)**

`migrate deploy` does **not** create accounts. Until you seed, `admin@example.com` / `password123` will fail with “Invalid email or password”.

From your machine (use the Postgres **External** URL from Render):

```bash
$env:DATABASE_URL="postgresql://USER:PASSWORD@HOST/DB?sslmode=require"
npm run db:seed
```

Or in the Render shell for the web service (migrate first if tables are missing):

```bash
npx prisma migrate deploy
npx prisma db seed
```

If seed fails with `The table public.Round does not exist`, migrations were never applied — run `migrate deploy` then seed again.

Warning: the seed script **wipes all existing rows** then recreates demo data.

## Notes

- All timestamps are stored in **UTC**
- Status / sidebar group definitions live in `lib/status.ts`
- See `docs/SPEC.md` for the full product and technical spec
