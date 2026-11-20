import { PrismaClient, ProcessStatus, RoundOutcome, RoundType, Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import {
  addDays,
  addMinutes,
  nextSunday,
  previousSunday,
  setHours,
  setMinutes,
  startOfDay,
  subWeeks,
} from "date-fns";

const prisma = new PrismaClient();

const PASSWORD = "password123";

type ProfileSeed = {
  code: string;
  displayName: string;
  fullName: string;
  email: string;
  phone: string;
  location: string;
  zipCode: string;
  country: string;
  timezone: string;
  linkedinUrl: string;
  githubUrl: string;
  starred: boolean;
  experiences: {
    company: string;
    role: string;
    location: string;
    startOffsetYears: number;
    endOffsetYears: number | null;
  }[];
  /** weekday 0=Sun..6=Sat, minutes from midnight in profile TZ */
  rules: { weekday: number; startMinute: number; endMinute: number }[];
};

const PROFILES: ProfileSeed[] = [
  {
    code: "US-01",
    displayName: "Alex",
    fullName: "Alex Rivera",
    email: "alex.rivera@example.com",
    phone: "+1-212-555-0101",
    location: "New York, NY",
    zipCode: "10001",
    country: "US",
    timezone: "America/New_York",
    linkedinUrl: "https://linkedin.com/in/alexrivera",
    githubUrl: "https://github.com/alexrivera",
    starred: true,
    experiences: [
      {
        company: "Stripe",
        role: "Senior Software Engineer",
        location: "New York, NY",
        startOffsetYears: 3,
        endOffsetYears: null,
      },
      {
        company: "Shopify",
        role: "Software Engineer",
        location: "Remote",
        startOffsetYears: 6,
        endOffsetYears: 3,
      },
    ],
    rules: [
      { weekday: 1, startMinute: 10 * 60, endMinute: 15 * 60 },
      { weekday: 2, startMinute: 9 * 60, endMinute: 12 * 60 },
      { weekday: 3, startMinute: 13 * 60, endMinute: 17 * 60 },
      { weekday: 4, startMinute: 10 * 60, endMinute: 16 * 60 },
      { weekday: 5, startMinute: 9 * 60, endMinute: 12 * 60 },
    ],
  },
  {
    code: "US-04",
    displayName: "Jordan",
    fullName: "Jordan Lee",
    email: "jordan.lee@example.com",
    phone: "+1-415-555-0144",
    location: "San Francisco, CA",
    zipCode: "94105",
    country: "US",
    timezone: "America/Los_Angeles",
    linkedinUrl: "https://linkedin.com/in/jordanlee",
    githubUrl: "https://github.com/jordanlee",
    starred: true,
    experiences: [
      {
        company: "Airbnb",
        role: "Staff Engineer",
        location: "San Francisco, CA",
        startOffsetYears: 2,
        endOffsetYears: null,
      },
      {
        company: "Dropbox",
        role: "Senior Engineer",
        location: "San Francisco, CA",
        startOffsetYears: 5,
        endOffsetYears: 2,
      },
    ],
    rules: [
      { weekday: 1, startMinute: 9 * 60, endMinute: 14 * 60 },
      { weekday: 3, startMinute: 10 * 60, endMinute: 16 * 60 },
      { weekday: 4, startMinute: 9 * 60, endMinute: 12 * 60 },
      { weekday: 5, startMinute: 13 * 60, endMinute: 17 * 60 },
    ],
  },
  {
    code: "US-07",
    displayName: "Sam",
    fullName: "Sam Patel",
    email: "sam.patel@example.com",
    phone: "+1-312-555-0177",
    location: "Chicago, IL",
    zipCode: "60601",
    country: "US",
    timezone: "America/Chicago",
    linkedinUrl: "https://linkedin.com/in/sampatel",
    githubUrl: "https://github.com/sampatel",
    starred: false,
    experiences: [
      {
        company: "Capital One",
        role: "Backend Engineer",
        location: "Chicago, IL",
        startOffsetYears: 4,
        endOffsetYears: null,
      },
    ],
    rules: [
      { weekday: 1, startMinute: 11 * 60, endMinute: 16 * 60 },
      { weekday: 2, startMinute: 10 * 60, endMinute: 15 * 60 },
      { weekday: 4, startMinute: 9 * 60, endMinute: 13 * 60 },
    ],
  },
  {
    code: "UK-02",
    displayName: "Morgan",
    fullName: "Morgan Blake",
    email: "morgan.blake@example.com",
    phone: "+44-20-7946-0202",
    location: "London, UK",
    zipCode: "EC2A 4BX",
    country: "GB",
    timezone: "Europe/London",
    linkedinUrl: "https://linkedin.com/in/morganblake",
    githubUrl: "https://github.com/morganblake",
    starred: true,
    experiences: [
      {
        company: "Monzo",
        role: "Platform Engineer",
        location: "London, UK",
        startOffsetYears: 2,
        endOffsetYears: null,
      },
      {
        company: "Deliveroo",
        role: "Software Engineer",
        location: "London, UK",
        startOffsetYears: 5,
        endOffsetYears: 2,
      },
    ],
    rules: [
      { weekday: 1, startMinute: 9 * 60, endMinute: 13 * 60 },
      { weekday: 2, startMinute: 14 * 60, endMinute: 18 * 60 },
      { weekday: 3, startMinute: 9 * 60, endMinute: 12 * 60 },
      { weekday: 5, startMinute: 10 * 60, endMinute: 15 * 60 },
    ],
  },
  {
    code: "UK-05",
    displayName: "Casey",
    fullName: "Casey Quinn",
    email: "casey.quinn@example.com",
    phone: "+44-161-555-0505",
    location: "Manchester, UK",
    zipCode: "M1 1AE",
    country: "GB",
    timezone: "Europe/London",
    linkedinUrl: "https://linkedin.com/in/caseyquinn",
    githubUrl: "https://github.com/caseyquinn",
    starred: false,
    experiences: [
      {
        company: "BBC",
        role: "Full Stack Developer",
        location: "Manchester, UK",
        startOffsetYears: 3,
        endOffsetYears: null,
      },
    ],
    rules: [
      { weekday: 2, startMinute: 9 * 60, endMinute: 14 * 60 },
      { weekday: 3, startMinute: 13 * 60, endMinute: 17 * 60 },
      { weekday: 4, startMinute: 10 * 60, endMinute: 16 * 60 },
    ],
  },
  {
    code: "CA-03",
    displayName: "Riley",
    fullName: "Riley Nguyen",
    email: "riley.nguyen@example.com",
    phone: "+1-416-555-0303",
    location: "Toronto, ON",
    zipCode: "M5V 2T6",
    country: "CA",
    timezone: "America/Toronto",
    linkedinUrl: "https://linkedin.com/in/rileynguyen",
    githubUrl: "https://github.com/rileynguyen",
    starred: false,
    experiences: [
      {
        company: "Shopify",
        role: "Senior Frontend Engineer",
        location: "Toronto, ON",
        startOffsetYears: 1,
        endOffsetYears: null,
      },
      {
        company: "Wealthsimple",
        role: "Software Engineer",
        location: "Toronto, ON",
        startOffsetYears: 4,
        endOffsetYears: 1,
      },
    ],
    rules: [
      { weekday: 1, startMinute: 10 * 60, endMinute: 15 * 60 },
      { weekday: 3, startMinute: 9 * 60, endMinute: 14 * 60 },
      { weekday: 4, startMinute: 13 * 60, endMinute: 17 * 60 },
      { weekday: 5, startMinute: 9 * 60, endMinute: 12 * 60 },
    ],
  },
];

const COMPANIES = [
  { company: "Google", title: "Software Engineer L5" },
  { company: "Meta", title: "Senior Software Engineer" },
  { company: "Amazon", title: "SDE II" },
  { company: "Apple", title: "Software Engineer" },
  { company: "Microsoft", title: "Senior SWE" },
  { company: "Netflix", title: "Senior Backend Engineer" },
  { company: "Uber", title: "Staff Engineer" },
  { company: "Airbnb", title: "Senior Full Stack Engineer" },
  { company: "Snowflake", title: "Software Engineer" },
  { company: "Datadog", title: "Backend Engineer" },
  { company: "Cloudflare", title: "Systems Engineer" },
  { company: "Notion", title: "Full Stack Engineer" },
  { company: "Figma", title: "Software Engineer" },
  { company: "Stripe", title: "Backend Engineer" },
  { company: "OpenAI", title: "Member of Technical Staff" },
  { company: "Anthropic", title: "Software Engineer" },
  { company: "Coinbase", title: "Senior Engineer" },
  { company: "Square", title: "Software Engineer" },
  { company: "LinkedIn", title: "Senior SWE" },
  { company: "Twilio", title: "Platform Engineer" },
  { company: "Atlassian", title: "Senior Developer" },
  { company: "Dropbox", title: "Software Engineer" },
  { company: "Pinterest", title: "Backend Engineer" },
  { company: "Spotify", title: "Senior Engineer" },
  { company: "Slack", title: "Full Stack Engineer" },
];

const STATUSES: ProcessStatus[] = [
  "FIRST_STEP",
  "NEXT_ROUND",
  "NEXT_STEP",
  "ASSESSMENT",
  "DONE",
  "RESCHEDULE",
  "OFFER",
  "SKIPPED",
  "FAILED",
  "CANCELED",
  "NOT_HANDLED",
  "NOT_RESCHEDULED",
  "FIRST_STEP",
  "NEXT_ROUND",
  "NEXT_STEP",
  "ASSESSMENT",
  "DONE",
  "OFFER",
  "FIRST_STEP",
  "NEXT_ROUND",
  "NEXT_STEP",
  "RESCHEDULE",
  "FAILED",
  "CANCELED",
  "DONE",
];

const ROUND_TYPES: RoundType[] = [
  "HR_RECRUITER",
  "TECH",
  "ASSESSMENT",
  "SYSTEM_DESIGN",
  "BEHAVIORAL",
  "FINAL",
  "OTHER",
];

const INTERVIEWERS = [
  "Priya Sharma",
  "James Chen",
  "Olivia Brooks",
  "Marcus Webb",
  "Elena Vasquez",
  "Noah Kim",
  "Ava Thompson",
  "Liam Foster",
];

function utcAtLocalWeekdayHour(
  weekStart: Date,
  dayOffset: number,
  hour: number,
  minute = 0,
): Date {
  const day = addDays(weekStart, dayOffset);
  return setMinutes(setHours(startOfDay(day), hour), minute);
}

async function main() {
  console.log("Clearing existing data...");
  await prisma.round.deleteMany();
  await prisma.interviewProcess.deleteMany();
  await prisma.application.deleteMany();
  await prisma.availabilityOverride.deleteMany();
  await prisma.availabilityRule.deleteMany();
  await prisma.userAvailabilityOverride.deleteMany();
  await prisma.userAvailabilityRule.deleteMany();
  await prisma.experience.deleteMany();
  await prisma.announcement.deleteMany();
  await prisma.profile.deleteMany();
  await prisma.user.deleteMany();
  await prisma.team.deleteMany();

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const now = new Date();

  const team = await prisma.team.create({
    data: { name: "Furious Five" },
  });

  const admin = await prisma.user.create({
    data: {
      name: "Admin User",
      email: "admin@example.com",
      passwordHash,
      role: Role.ADMIN,
      avatarColor: "#2563eb",
      teamId: team.id,
    },
  });

  const memberDefs = [
    { name: "Taylor Brooks", email: "taylor@example.com", color: "#7c3aed" },
    { name: "Jamie Ortiz", email: "jamie@example.com", color: "#db2777" },
    { name: "Chris Nguyen", email: "chris@example.com", color: "#0891b2" },
    { name: "Avery Kim", email: "avery@example.com", color: "#ea580c" },
    { name: "Drew Patel", email: "drew@example.com", color: "#16a34a" },
  ];

  const members = [];
  for (const m of memberDefs) {
    members.push(
      await prisma.user.create({
        data: {
          name: m.name,
          email: m.email,
          passwordHash,
          role: Role.MEMBER,
          avatarColor: m.color,
          teamId: team.id,
        },
      }),
    );
  }

  const interviewer = await prisma.user.create({
    data: {
      name: "Morgan Reed",
      email: "morgan@example.com",
      passwordHash,
      role: Role.INTERVIEWER,
      avatarColor: "#4f46e5",
      timezone: "America/New_York",
      teamId: team.id,
      availabilityRules: {
        create: [
          { weekday: 1, startMinute: 9 * 60, endMinute: 12 * 60 },
          { weekday: 1, startMinute: 13 * 60, endMinute: 17 * 60 },
          { weekday: 2, startMinute: 10 * 60, endMinute: 16 * 60 },
          { weekday: 3, startMinute: 9 * 60, endMinute: 15 * 60 },
          { weekday: 4, startMinute: 11 * 60, endMinute: 17 * 60 },
          { weekday: 5, startMinute: 9 * 60, endMinute: 13 * 60 },
        ],
      },
    },
  });

  console.log(
    `Created team "${team.name}" with 1 admin + ${members.length} members + interviewer ${interviewer.email}`,
  );

  const profiles = [];
  for (let i = 0; i < PROFILES.length; i++) {
    const p = PROFILES[i];
    const assigned = [members[i % members.length], members[(i + 1) % members.length]];

    const profile = await prisma.profile.create({
      data: {
        code: p.code,
        displayName: p.displayName,
        fullName: p.fullName,
        email: p.email,
        phone: p.phone,
        location: p.location,
        zipCode: p.zipCode,
        country: p.country,
        timezone: p.timezone,
        linkedinUrl: p.linkedinUrl,
        githubUrl: p.githubUrl,
        starred: p.starred,
        assignedMembers: {
          connect: assigned.map((u) => ({ id: u.id })),
        },
        experiences: {
          create: p.experiences.map((e) => {
            const start = new Date(now);
            start.setUTCFullYear(start.getUTCFullYear() - e.startOffsetYears);
            start.setUTCMonth(0, 1);
            start.setUTCHours(0, 0, 0, 0);
            let end: Date | null = null;
            if (e.endOffsetYears !== null) {
              end = new Date(now);
              end.setUTCFullYear(end.getUTCFullYear() - e.endOffsetYears);
              end.setUTCMonth(0, 1);
              end.setUTCHours(0, 0, 0, 0);
            }
            return {
              company: e.company,
              role: e.role,
              location: e.location,
              startDate: start,
              endDate: end,
            };
          }),
        },
        interviewerId: interviewer.id,
        availabilityRules: {
          create: p.rules,
        },
      },
    });
    profiles.push(profile);
  }

  console.log(`Created ${profiles.length} profiles with availability + experience`);

  // One BLOCK override (holiday-ish) and one OPEN override this week
  const thisWeekStart = previousSunday(startOfDay(now));
  await prisma.availabilityOverride.createMany({
    data: [
      {
        profileId: profiles[0].id,
        date: addDays(thisWeekStart, 3),
        type: "BLOCK",
        startMinute: null,
        endMinute: null,
      },
      {
        profileId: profiles[1].id,
        date: addDays(thisWeekStart, 6),
        type: "OPEN",
        startMinute: 10 * 60,
        endMinute: 14 * 60,
      },
    ],
  });

  const prevWeekStart = subWeeks(thisWeekStart, 1);
  const nextWeekStart = nextSunday(thisWeekStart);

  let processCount = 0;
  let roundCount = 0;

  for (let i = 0; i < 25; i++) {
    const profile = profiles[i % profiles.length];
    const owner = members[i % members.length];
    const job = COMPANIES[i % COMPANIES.length];
    const status = STATUSES[i];
    const company = job.company;
    const jobTitle = job.title;

    const process = await prisma.interviewProcess.create({
      data: {
        profileId: profile.id,
        companyName: company,
        jobTitle,
        jobUrl: `https://careers.example.com/${company.toLowerCase()}/${i + 1}`,
        ownerMemberId: owner.id,
        status,
        note:
          i % 4 === 0
            ? "Strong culture fit; follow up on system design feedback."
            : i % 3 === 0
              ? "Waiting on recruiter availability."
              : null,
      },
    });
    processCount++;

    const roundCountForProcess = status === "FIRST_STEP" ? 1 : status === "OFFER" ? 4 : 2 + (i % 3);
    const usePrevWeek = i % 2 === 0;
    const weekBase = usePrevWeek ? prevWeekStart : thisWeekStart;

    for (let r = 0; r < roundCountForProcess; r++) {
      const dayOffset = (i + r * 2) % 5; // Mon-Fri-ish (Sun+1..Sun+5)
      const hour = 10 + ((i + r) % 6);
      const duration = [30, 45, 60, 90][(i + r) % 4];
      const startAt = utcAtLocalWeekdayHour(weekBase, dayOffset + 1, hour, (r * 15) % 60);
      // Spread a few into next week for upcoming
      const adjustedStart =
        status === "FIRST_STEP" || status === "NEXT_ROUND"
          ? utcAtLocalWeekdayHour(nextWeekStart, (r % 4) + 1, hour, 0)
          : startAt;
      const endAt = addMinutes(adjustedStart, duration);

      let outcome: RoundOutcome = "PENDING";
      let rating: number | null = null;
      let feedback: string | null = null;

      if (r < roundCountForProcess - 1) {
        outcome = "PASSED";
        rating = 3 + ((i + r) % 3);
        feedback = "Solid answers; clear communication.";
      } else if (status === "FAILED") {
        outcome = "FAILED";
        rating = 2;
        feedback = "Gaps on system design tradeoffs.";
      } else if (status === "CANCELED" || status === "SKIPPED") {
        outcome = "CANCELED";
      } else if (status === "DONE" || status === "OFFER") {
        outcome = "PASSED";
        rating = 4 + (i % 2);
        feedback = "Ready to move forward.";
      } else if (status === "RESCHEDULE" || status === "NOT_RESCHEDULED") {
        outcome = "RESCHEDULED";
      } else if (
        // Create a few stale PENDING rounds in the past for "Needs update"
        (status === "NEXT_STEP" || status === "ASSESSMENT") &&
        usePrevWeek
      ) {
        outcome = "PENDING";
      }

      // Past rounds that are still PENDING (needs update)
      const finalStart =
        outcome === "PENDING" && (status === "NEXT_STEP" || status === "ASSESSMENT") && usePrevWeek
          ? utcAtLocalWeekdayHour(prevWeekStart, dayOffset + 1, hour, 0)
          : adjustedStart;
      const finalEnd = addMinutes(finalStart, duration);

      await prisma.round.create({
        data: {
          processId: process.id,
          roundNumber: r + 1,
          type: ROUND_TYPES[(i + r) % ROUND_TYPES.length],
          startAt: finalStart,
          endAt: finalEnd,
          interviewerName: interviewer.name,
          clientInterviewerName: INTERVIEWERS[(i + r) % INTERVIEWERS.length],
          clientInterviewerAbout: `${INTERVIEWERS[(i + r) % INTERVIEWERS.length]} is a hiring manager at the client company for this round.`,
          meetingLink: `https://meet.example.com/${process.id.slice(0, 8)}-r${r + 1}`,
          bookedById: owner.id,
          outcome,
          rating,
          feedback,
        },
      });
      roundCount++;
    }
  }

  await prisma.announcement.createMany({
    data: [
      {
        title: "Weekly sync moved to Tuesday",
        body: "Standup is now 10:00am Eastern every Tuesday. Bring profile availability updates.",
        createdAt: addDays(now, -1),
      },
      {
        title: "New UK profiles onboarded",
        body: "UK-02 and UK-05 are live with London timezones. Assign coverage before Friday.",
        createdAt: addDays(now, -3),
      },
      {
        title: "Interview feedback SLA",
        body: "Please submit round outcomes within 24 hours so Needs update stays empty.",
        createdAt: addDays(now, -5),
      },
    ],
  });

  console.log(`Created ${processCount} processes with ${roundCount} rounds`);
  console.log("Seed complete.");
  console.log("");
  console.log("Login credentials (all users):");
  console.log(`  admin@example.com / ${PASSWORD}`);
  console.log(`  taylor@example.com / ${PASSWORD}`);
  console.log(`  jamie@example.com / ${PASSWORD}`);
  console.log(`  chris@example.com / ${PASSWORD}`);
  console.log(`  avery@example.com / ${PASSWORD}`);
  console.log(`  drew@example.com / ${PASSWORD}`);
  console.log(`  morgan@example.com / ${PASSWORD}  (INTERVIEWER)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
