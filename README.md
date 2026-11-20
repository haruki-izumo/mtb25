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

Seed includes 6 profiles (US/UK/CA), weekly availability, ~25 interview processes with rounds across the current and previous week, and team announcements.

## Useful scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start Next.js dev server |
| `npm run db:migrate` | Run Prisma migrations |
| `npm run db:seed` | Seed realistic demo data |
| `npm run db:studio` | Open Prisma Studio |
| `npm run db:reset` | Reset DB, remigrate, and seed |

## Notes

- All timestamps are stored in **UTC**
- Status / sidebar group definitions live in `lib/status.ts`
- See `docs/SPEC.md` for the full product and technical spec
