const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;
const DEFAULT_RANGE_DAYS = 30;
const TIMELINE_LIMIT = 200;

class AnalyticsQueryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "AnalyticsQueryError";
    this.status = status;
  }
}

function applicationStamp(now = new Date().toISOString()) {
  return {
    applied: true,
    appliedAt: now,
    submitted: false,
    createdAt: now,
    updatedAt: now,
  };
}

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function todayInZone(timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function assertDay(value, label) {
  const day = String(value || "").trim();
  if (!DAY_RE.test(day)) {
    throw new AnalyticsQueryError(`${label} must be YYYY-MM-DD`);
  }
  const [year, month, date] = day.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, date));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== date
  ) {
    throw new AnalyticsQueryError(`${label} is not a real calendar day`);
  }
  return day;
}

function addDays(day, delta) {
  const [year, month, date] = day.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, date));
  utc.setUTCDate(utc.getUTCDate() + delta);
  return utc.toISOString().slice(0, 10);
}

function daySpan(from, to) {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  const start = Date.UTC(y1, m1 - 1, d1);
  const end = Date.UTC(y2, m2 - 1, d2);
  return Math.round((end - start) / 86400000) + 1;
}

function eachDay(from, to) {
  const days = [];
  let cursor = from;
  const span = daySpan(from, to);
  for (let i = 0; i < span; i += 1) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

function resolveRange(query = {}) {
  const timeZone = String(query.timeZone || query.tz || "UTC").trim() || "UTC";
  if (!isValidTimeZone(timeZone)) {
    throw new AnalyticsQueryError("Invalid timezone");
  }

  const fromRaw = String(query.from || "").trim();
  const toRaw = String(query.to || "").trim();
  const end = toRaw ? assertDay(toRaw, "to") : todayInZone(timeZone);

  let start;
  if (fromRaw) {
    start = assertDay(fromRaw, "from");
  } else {
    const daysRaw = query.days == null || query.days === "" ? DEFAULT_RANGE_DAYS : Number(query.days);
    if (!Number.isInteger(daysRaw) || daysRaw < 1 || daysRaw > MAX_RANGE_DAYS) {
      throw new AnalyticsQueryError(`days must be an integer from 1 to ${MAX_RANGE_DAYS}`);
    }
    start = addDays(end, -(daysRaw - 1));
  }

  if (start > end) {
    throw new AnalyticsQueryError("from must be on or before to");
  }
  if (daySpan(start, end) > MAX_RANGE_DAYS) {
    throw new AnalyticsQueryError(`Range cannot exceed ${MAX_RANGE_DAYS} days`);
  }

  return { from: start, to: end, timeZone };
}

function applicationDay(iso, timeZone) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function profileName(profileId, nameById) {
  if (!profileId) return "Unknown profile";
  return nameById.get(profileId) || "Unknown profile";
}

function buildApplicationAnalytics(generations, profiles, query = {}) {
  const range = resolveRange(query);
  const profileId = String(query.profileId || "").trim();
  const list = Array.isArray(generations) ? generations : [];
  const profileList = Array.isArray(profiles) ? profiles : [];
  const nameById = new Map(profileList.map((profile) => [profile._id, profile.name || "Untitled"]));

  const scoped = profileId ? list.filter((gen) => (gen.profileId || "") === profileId) : list;

  const dayCounts = new Map();
  const profileStats = new Map();

  function ensureProfile(id) {
    if (!profileStats.has(id)) {
      profileStats.set(id, {
        profileId: id,
        profileName: profileName(id, nameById),
        total: 0,
        inRange: 0,
        firstAt: null,
        lastAt: null,
      });
    }
    return profileStats.get(id);
  }

  for (const profile of profileList) {
    if (!profileId || profile._id === profileId) ensureProfile(profile._id);
  }
  if (profileId) ensureProfile(profileId);

  const timeline = [];

  for (const gen of scoped) {
    const id = gen.profileId || "";
    const stats = ensureProfile(id);
    stats.total += 1;
    const at = gen.createdAt || null;
    if (at && (!stats.firstAt || at < stats.firstAt)) stats.firstAt = at;
    if (at && (!stats.lastAt || at > stats.lastAt)) stats.lastAt = at;

    const day = applicationDay(gen.createdAt, range.timeZone);
    if (!day || day < range.from || day > range.to) continue;

    stats.inRange += 1;
    if (!dayCounts.has(day)) dayCounts.set(day, new Map());
    const byProfile = dayCounts.get(day);
    byProfile.set(id, (byProfile.get(id) || 0) + 1);

    timeline.push({
      id: gen.id,
      profileId: id,
      profileName: profileName(id, nameById),
      company: gen.company || "",
      role: gen.role || "",
      jd_url: gen.jd_url || "",
      mode: gen.mode || "",
      createdAt: gen.createdAt || null,
    });
  }

  timeline.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

  const byDay = eachDay(range.from, range.to).map((date) => {
    const byProfileMap = dayCounts.get(date) || new Map();
    const byProfile = [...byProfileMap.entries()]
      .map(([id, count]) => ({
        profileId: id,
        profileName: profileName(id, nameById),
        count,
      }))
      .sort((a, b) => b.count - a.count || a.profileName.localeCompare(b.profileName));
    const count = byProfile.reduce((sum, row) => sum + row.count, 0);
    return { date, count, byProfile };
  });

  const byProfile = [...profileStats.values()].sort(
    (a, b) =>
      b.inRange - a.inRange ||
      b.total - a.total ||
      a.profileName.localeCompare(b.profileName),
  );

  const activeDays = byDay.filter((day) => day.count > 0);
  const busiestDay = activeDays.reduce((best, day) => {
    if (!best || day.count > best.count || (day.count === best.count && day.date > best.date)) {
      return { date: day.date, count: day.count };
    }
    return best;
  }, null);

  const inRange = byDay.reduce((sum, day) => sum + day.count, 0);
  const applications = byProfile.reduce((sum, row) => sum + row.total, 0);

  return {
    timezone: range.timeZone,
    from: range.from,
    to: range.to,
    profileId,
    summary: {
      applications,
      inRange,
      profiles: byProfile.filter((row) => row.total > 0).length,
      daysWithApplications: activeDays.length,
      busiestDay,
      averagePerDay: byDay.length ? Math.round((inRange / byDay.length) * 10) / 10 : 0,
    },
    byProfile,
    byDay,
    timeline: timeline.slice(0, TIMELINE_LIMIT),
    timelineTotal: timeline.length,
    timelineTruncated: timeline.length > TIMELINE_LIMIT,
  };
}

module.exports = {
  AnalyticsQueryError,
  applicationStamp,
  buildApplicationAnalytics,
  resolveRange,
};
