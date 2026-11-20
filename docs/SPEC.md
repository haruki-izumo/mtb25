# Interview Manager — Product & Technical Spec

## Overview
An internal web app for a small team to manage job interviews across multiple candidate
profiles. Each profile publishes weekly availability. Team members book interviews into
open slots, track every round of each interview process, and move each process through a
status pipeline until it ends in an offer or is closed.

## Tech stack (use exactly this)
- Next.js 14+ (App Router), TypeScript (strict), React Server Components where sensible
- Tailwind CSS + shadcn/ui + lucide-react icons
- PostgreSQL + Prisma ORM
- Auth.js (NextAuth v5) with email/password (credentials) + role-based access
- date-fns + date-fns-tz for all time math (store everything in UTC)
- TanStack Query for client data fetching/mutations; Server Actions for writes
- Zod for validation (shared between forms and server)
- react-hook-form for forms
- Vitest for unit tests, Playwright for one happy-path e2e test
- Docker Compose for local Postgres

## Roles
- ADMIN: manages profiles, members, all interviews
- MEMBER: books/edits interviews for profiles assigned to them; sees team calendar
- Members are assigned to profiles (many-to-many)

## Layout (match the screenshots' style)
- Fixed narrow left icon rail (~80px, light gray bg) with icon + label below:
  Home, Meetings, Availability, Interview, Application, Chat, To Do, Resume,
  divider, Profile, My Team, More; Settings pinned at bottom.
  Active item = white rounded card. Badge support (e.g. red "99+").
- Second column (~280px): contextual sidebar (filters, mini-calendar, category lists with counts)
- Main content area: white, rounded cards, subtle borders, blue primary (#2563eb-ish),
  green for success, yellow/cyan event colors. Font: Lato or Inter.
- Timezone selector in the top-right of calendar pages (default America/New_York, "UTC-4 Eastern (EST)" style label).

## Data model (Prisma)
- User: id, name, email, passwordHash, role (ADMIN|MEMBER), avatarColor, createdAt
- Team: id, name ("Furious Five" style), members User[]
- Profile: id, code (e.g. "US-04"), displayName, fullName, email, phone, location, zipCode,
  country (ISO code, show flag emoji), timezone (IANA), linkedinUrl, githubUrl,
  resumeFileUrl, starred Boolean, assignedMembers User[], createdAt
- Experience: id, profileId, company, role, location, startDate, endDate (nullable = Present)
- AvailabilityRule: id, profileId, weekday (0-6), startMinute, endMinute
  (recurring weekly, in the profile's timezone)
- AvailabilityOverride: id, profileId, date, startMinute?, endMinute?, type (BLOCK|OPEN)
- InterviewProcess: id, profileId, companyName, jobTitle, jobUrl?, ownerMemberId,
  status (enum below), note (text), createdAt, updatedAt
- Round: id, processId, roundNumber, type (HR_RECRUITER|TECH|ASSESSMENT|SYSTEM_DESIGN|
  BEHAVIORAL|FINAL|OTHER), startAt (UTC), endAt (UTC), interviewerName, meetingLink?,
  bookedById (User), outcome (PENDING|PASSED|FAILED|RESCHEDULED|CANCELED|NO_SHOW),
  rating Int? (1-5), feedback text?, createdAt
- Announcement: id, title, body, createdAt (for "Team updates" panel)
- Application (optional, phase 8): id, profileId, company, jobTitle, url, status, appliedAt

## Process status pipeline
Grouped exactly like the Interviews sidebar:
- ALL, OFFER
- UPCOMING: FIRST_STEP, NEXT_ROUND
- FOLLOW_UP: NEXT_STEP, ASSESSMENT, DONE, RESCHEDULE
- "Needs update" (derived, red-bordered item): any process with a Round whose endAt < now
  and outcome = PENDING
- CLOSED: SKIPPED, FAILED, CANCELED, NOT_HANDLED, NOT_RESCHEDULED
Each item shows a live count. Status can be changed from a pill dropdown on each card.
Put status/group definitions in one config file (lib/status.ts) with label, icon, color.

## Booking rules (critical — implement server-side)
- Open slots = AvailabilityRules for that date (converted from the profile's timezone to UTC)
  + OPEN overrides − BLOCK overrides − existing non-canceled Rounds for the profile
- Slot granularity 15 min; round duration chosen at booking (15/30/45/60/90 min)
- Booking must run in a Prisma transaction that re-checks for overlap
  (overlap = existing.startAt < new.endAt AND existing.endAt > new.startAt) and rejects conflicts
- Booking outside availability is allowed only for ADMIN with an explicit "override" checkbox
- Put slot calculation in lib/availability.ts as pure functions with Vitest tests
  (include DST-boundary and cross-midnight timezone tests)

## Pages
1. Home (/): big live clock + date; countdown card to the next round
   (hh:mm:ss, profile code, company, time); quick-link tiles (Meetings, Availability, Chat,
   Profile, Interview); 3 stat cards (Next step count, Follow-up count, Upcoming count);
   previous week vs this week (meeting count + avg rating with up/down arrow);
   "Today's meetings" checklist with progress bar (x/y done); "Team updates" panel.
2. Meetings (/meetings): week calendar (Sun–Sat, hourly rows, 30-min lines, red current-time
   line). Events show time, icon by round type, "Company | Job title", colored by status
   (yellow = scheduled, cyan = recruiter call, gray strikethrough = canceled,
   icons for done ✓ / rescheduled ↻). Side-by-side layout for overlapping events.
   Sidebar: mini month calendar (selected week highlighted), filter by Member, filter by
   Profile, filter chips by round type. Day/Week toggle. Click event → round detail drawer.
3. Availability (/availability): select a profile (searchable combobox with flag);
   week grid showing available blocks in green, booked/blocked in gray diagonal hatch.
   Click-drag on empty cells to add availability; click a green block to edit/delete.
   Tab for editing recurring weekly rules. Button "Get availability as Text" →
   modal with copyable plain-text summary for the next 7 days in the selected timezone, e.g.
   "Mon Sep 28: 10:00am–3:00pm EST". Clicking a green slot opens the booking dialog.
4. Interview (/interviews): sidebar = status groups with counts (see pipeline).
   Top bar: date range segmented control (All time/Today/7d/30d/90d/1y), From→To pickers,
   search, sort (date asc/desc), "Advanced filters" (profile, member, round type).
   Each process = card: colored icon, "Company · Job title", "PROFILE-CODE.Name · N rounds ·
   Next: date", inline note input, "in N days" (green), status pill dropdown, delete (confirm).
   Below the header: horizontal row of round cards (number badge, type icon, date/time range,
   interviewer, 5-star rating, feedback text, outcome icon) + dashed "Add round" card.
   Editing a round opens a dialog (outcome, rating, feedback, reschedule).
5. Profiles (/profiles): sidebar with All / Starred / by country (flag + count).
   Table (Name with flag, Email, Star) with grid/list toggle and search.
   Right detail panel with tabs Profile | Settings | Resume | History:
   copyable fields (copy icon), Experience list, resume upload/preview,
   history = all processes for that profile.
6. My Team (/team): members table (avatar initials with color, name, email, role icon,
   assigned profiles shown as flag + count by country). Admin can invite/edit/assign.
7. Settings: user timezone, password, theme.

## Non-functional
- All times stored in UTC; display in the user's selected timezone
- Server-side authorization on every action (members can only mutate assigned profiles)
- Optimistic UI for status changes and ratings
- Empty, loading (skeleton) and error states on every page
- Seed script: 1 admin, 5 members, 6 profiles (US/UK/CA), weekly availability,
  ~25 processes with realistic rounds spread over the current and previous week
- README with setup instructions