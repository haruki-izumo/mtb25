/** Resume prompt + JSON normalize — ported from rb5-extension/backend/src/manualGenerate.js */

export type Rb5Experience = {
  company?: string;
  role?: string;
  location?: string;
  start?: string;
  end?: string;
};

export type Rb5Profile = {
  name: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  location?: string;
  zipCode?: string;
  country?: string;
  linkedin?: string;
  github?: string;
  experience?: Rb5Experience[];
  education?: unknown[];
  certifications?: { name: string; date?: string }[];
  bulletMin?: number;
  bulletMax?: number;
  resumeTemplateId?: string;
};

function formatDuration(start: string, end: string) {
  const s = String(start || "").trim();
  const e = String(end || "").trim();
  if (!s && !e) return "";
  if (!e) return `${s} – Present`;
  return `${s} – ${e}`;
}

function buildFixedWorkHistory(
  profile: Rb5Profile,
  bulletMin?: number,
  bulletMax?: number,
) {
  const lo = Number.isFinite(Number(bulletMin))
    ? Number(bulletMin)
    : profile.bulletMin || 10;
  const hi = Number.isFinite(Number(bulletMax))
    ? Number(bulletMax)
    : profile.bulletMax || 12;
  const bulletCount = Math.max(1, Math.round((lo + hi) / 2));
  const list = Array.isArray(profile.experience) ? profile.experience : [];
  return list.map((e) => ({
    company_name: String(e.company || "").trim(),
    title: String(e.role || "").trim(),
    duration: formatDuration(String(e.start || ""), String(e.end || "")),
    location: String(e.location || "").trim(),
    start: String(e.start || "").trim(),
    end: String(e.end || "").trim(),
    bullet_count: bulletCount,
  }));
}

function buildFitKeywords(fit: unknown): string[] {
  if (!fit || typeof fit !== "object") return [];
  const f = fit as { keywords?: unknown; reasons?: unknown };
  if (Array.isArray(f.keywords)) {
    return f.keywords.map((k) => String(k || "").trim()).filter(Boolean);
  }
  if (Array.isArray(f.reasons)) {
    return f.reasons.map((k) => String(k || "").trim()).filter(Boolean);
  }
  return [];
}

export function buildPromptText(params: {
  profile: Rb5Profile;
  job_description: string;
  company?: string;
  role?: string;
  bulletMin?: number;
  bulletMax?: number;
  fit?: unknown;
}) {
  const { profile, job_description, company, role, bulletMin, bulletMax, fit } =
    params;
  const fixedWorkHistory = buildFixedWorkHistory(profile, bulletMin, bulletMax);
  const fitKeywords = buildFitKeywords(fit);
  const education = Array.isArray(profile.education) ? profile.education : [];
  const certifications = Array.isArray(profile.certifications)
    ? profile.certifications
    : [];

  const fixedWorkBlock = fixedWorkHistory.length
    ? fixedWorkHistory
        .map(
          (e, i) =>
            `${i + 1}. company_name: ${JSON.stringify(e.company_name)} | title: ${JSON.stringify(e.title)} | duration: ${JSON.stringify(e.duration)} | location: ${JSON.stringify(e.location)} | bullets: exactly ${e.bullet_count}`,
        )
        .join("\n")
    : "(none — return an empty work_history array)";

  return `You are an expert resume writer. Please generate a resume JSON based on the following data(no markdown, no commentary, no code fences).

JSON Data Generate Rules

Output ONLY the JSON object. No markdown, no backticks, no preamble, no explanation.
Use double quotes for every key and string. No trailing commas.
work_history MUST contain exactly one entry per company listed in FIXED WORK HISTORY, in the same order, with company_name and duration copied verbatim.
Bullets per company MUST match the count specified next to each company in FIXED WORK HISTORY — exact, not approximate.
Weave JD vocabulary (frameworks, methodologies, domain terms) naturally into summary + bullets. Cover every required item from fit_keywords across the resume body.
technical_skills count MUST be between 65 and 75 inclusive (aim for ≈ 70). Group every listed skill into exactly one skill_groups entry — no skill may appear in two groups.
NEVER include percentages or the "%" character in any bullet, summary, or headline. No "reduced X by 30%", no "improved performance 25%", no "boosted by 40%". The character "%" must not appear anywhere in the JSON. Quantify with absolute numbers only when natural (e.g., "served 12 million requests/day", "shipped 4 production services"); otherwise lead with action and qualitative impact.
Bullets should be plausible for the role and tightly aligned to the JOB DESCRIPTION. You do not have the candidate's actual achievements — write strong, JD-aligned bullets that a senior practitioner could credibly own; the candidate will edit any line that doesn't match their reality.
Do NOT include any field besides the seven listed above. Do NOT include comments inside the JSON.
If a section has no real data (e.g. no formal degree), use an empty array — not placeholder strings.

TARGET COMPANY: ${company || "(not provided)"}
TARGET ROLE: ${role || "(not provided)"}

JOB DESCRIPTION:
${job_description || ""}

fit_keywords:
${JSON.stringify(fitKeywords, null, 2)}

FIXED WORK HISTORY:
${fixedWorkBlock}

CANDIDATE EDUCATION (copy into education when present; otherwise []):
${JSON.stringify(education, null, 2)}

FIXED CERTIFICATIONS (copy into certifications exactly, in this order; if this array is empty, return []):
${JSON.stringify(certifications, null, 2)}
Do not invent certifications. Do not add a "suggested" field.

OUTPUT SCHEMA — exactly these seven fields, nothing else:
{
  "headline_role": "string — role-aligned headline",
  "summary": "string — short professional summary",
  "work_history": [
    {
      "company_name": "verbatim from FIXED WORK HISTORY",
      "duration": "verbatim from FIXED WORK HISTORY",
      "title": "role title",
      "location": "string",
      "bullets": ["exactly bullet_count strings for that company"]
    }
  ],
  "education": [
    { "degree": "", "school": "", "start": "YYYY-MM", "end": "YYYY-MM" }
  ],
  "certifications": [
    { "name": "verbatim from FIXED CERTIFICATIONS", "date": "verbatim date, or empty string" }
  ],
  "technical_skills": ["65 to 75 skill strings"],
  "skill_groups": [
    { "category": "string", "skills": ["subset of technical_skills; each skill in exactly one group"] }
  ]
}`;
}

export function extractJsonObject(text: string) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Empty AI response");

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fence ? fence[1].trim() : raw;

  try {
    return JSON.parse(candidate);
  } catch {
    /* fall through */
  }

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(candidate.slice(start, end + 1));
  }
  throw new Error("Could not parse JSON from ChatGPT response");
}

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v ?? "").trim()).filter(Boolean);
}

function parseDurationToStartEnd(duration: string) {
  const raw = String(duration || "").trim();
  if (!raw) return { start: "", end: "" };
  const parts = raw
    .split(/\s+[–—-]\s+|\s*[–—]\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    const endRaw = parts[1];
    return {
      start: parts[0],
      end: /^present$/i.test(endRaw) ? "" : endRaw,
    };
  }
  return { start: raw, end: "" };
}

function datesForExperience(
  entry: Record<string, unknown> | undefined,
  profileEntry: Rb5Experience | undefined,
) {
  const profileStart = String(profileEntry?.start || "").trim();
  const profileEnd = String(profileEntry?.end || "").trim();
  if (profileStart || profileEnd) {
    return { start: profileStart, end: profileEnd };
  }
  const fromDuration = parseDurationToStartEnd(String(entry?.duration || ""));
  return {
    start: String(entry?.start || fromDuration.start || "").trim(),
    end: String(entry?.end || fromDuration.end || "").trim(),
  };
}

function defaultCoverLetter(params: {
  profile: Rb5Profile;
  company?: string;
  role?: string;
  summary?: string;
}) {
  const { profile, company, role, summary } = params;
  const name =
    [profile.firstName, profile.lastName].filter(Boolean).join(" ") ||
    profile.name ||
    "Candidate";
  const targetRole = role || "the open role";
  const targetCompany = company || "your team";
  const opener = summary
    ? summary.split(/(?<=[.!?])\s+/)[0]
    : `I bring experience aligned with ${targetRole}.`;
  return `Dear Hiring Manager,

I am writing to apply for the ${targetRole} position at ${targetCompany}. ${opener}

I would welcome the chance to discuss how my background can support your goals. Thank you for your consideration.

Sincerely,
${name}`;
}

export function normalizeResultInfo(
  parsed: unknown,
  opts: {
    profile: Rb5Profile;
    company?: string;
    role?: string;
    job_description?: string;
  },
) {
  const { profile, company, role, job_description } = opts;
  const flat =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  const resumeIn =
    flat.resume &&
    typeof flat.resume === "object" &&
    !Array.isArray(flat.work_history)
      ? (flat.resume as Record<string, unknown>)
      : flat;
  const contactIn =
    (resumeIn.contact as Record<string, unknown> | undefined) || {};
  const fullName =
    String(contactIn.full_name || "") ||
    [profile.firstName, profile.lastName].filter(Boolean).join(" ") ||
    profile.name ||
    "";

  const workHistory = Array.isArray(resumeIn.work_history)
    ? resumeIn.work_history
    : null;
  const experienceSource = workHistory
    ? workHistory
    : Array.isArray(resumeIn.experience)
      ? resumeIn.experience
      : [];

  const profileExperience = Array.isArray(profile.experience)
    ? profile.experience
    : [];
  const experience = (
    experienceSource as Record<string, unknown>[]
  ).map((e, index) => {
    const dates = datesForExperience(e, profileExperience[index]);
    return {
      role: String(e?.role || e?.job_title || e?.title || "").trim(),
      company: String(e?.company || e?.company_name || "").trim(),
      start: dates.start,
      end: dates.end,
      location: String(e?.location || "").trim(),
      bullets: asStringArray(e?.bullets),
      tools_and_tech: asStringArray(e?.tools_and_tech),
      challenges_and_solutions: String(
        e?.challenges_and_solutions || "",
      ).trim(),
    };
  });

  const education = (
    Array.isArray(resumeIn.education) ? resumeIn.education : []
  ).map((e) => {
    const row = e as Record<string, unknown>;
    const years = String(row?.years || "").trim();
    const fromYears = years
      ? parseDurationToStartEnd(years)
      : { start: "", end: "" };
    const degreeParts = [row?.degree, row?.field]
      .map((v) => String(v || "").trim())
      .filter(Boolean);
    return {
      degree: degreeParts.join(" — ") || String(row?.degree || "").trim(),
      school: String(row?.school || row?.institution || "").trim(),
      start: String(row?.start || fromYears.start || "").trim(),
      end: String(row?.end || fromYears.end || "").trim(),
      field: String(row?.field || "").trim(),
      institution: String(row?.institution || row?.school || "").trim(),
      years,
    };
  });

  let skill_groups = (
    Array.isArray(resumeIn.skill_groups) ? resumeIn.skill_groups : []
  )
    .map((g) => {
      const row = g as Record<string, unknown>;
      return {
        category: String(row?.category || row?.group_name || "").trim(),
        skills: asStringArray(row?.skills),
      };
    })
    .filter((g) => g.skills.length);

  const technicalSkills = [
    ...asStringArray(resumeIn.technical_skills),
    ...skill_groups.flatMap((g) => g.skills),
  ].filter((skill, idx, all) => all.indexOf(skill) === idx);

  if (!skill_groups.length && technicalSkills.length) {
    skill_groups = [{ category: "Technical Skills", skills: technicalSkills }];
  }

  const parsedCertifications = (
    Array.isArray(resumeIn.certifications) ? resumeIn.certifications : []
  )
    .map((c) => {
      if (typeof c === "string") {
        const name = c.trim();
        return name ? { name, date: "" } : null;
      }
      if (!c || typeof c !== "object") return null;
      const row = c as Record<string, unknown>;
      const name = String(row.name || row.title || "").trim();
      if (!name) return null;
      return { name, date: String(row.date || "").trim() };
    })
    .filter(Boolean) as { name: string; date: string }[];

  const profileCertifications = (
    Array.isArray(profile.certifications) ? profile.certifications : []
  )
    .map((c) => {
      const name = String(c?.name || "").trim();
      if (!name) return null;
      return { name, date: String(c.date || "").trim() };
    })
    .filter(Boolean) as { name: string; date: string }[];
  const certifications = profileCertifications.length
    ? profileCertifications
    : parsedCertifications;

  const jobIn =
    flat.job_data && typeof flat.job_data === "object"
      ? (flat.job_data as Record<string, unknown>)
      : {};
  const headline = String(
    resumeIn.headline || resumeIn.headline_role || role || "",
  ).trim();
  const summary = String(resumeIn.summary || "").trim();
  const fitKeywordsUsed = asStringArray(
    resumeIn.fit_keywords_used || flat.fit_keywords_used,
  );
  const coverLetter =
    String(flat.cover_letter || "").trim() ||
    defaultCoverLetter({
      profile,
      company,
      role: role || headline,
      summary,
    });

  return {
    resume: {
      contact: {
        full_name: fullName,
        email: String(contactIn.email || profile.email || "").trim(),
        phone: String(contactIn.phone || profile.phone || "").trim(),
        location: String(contactIn.location || profile.location || "").trim(),
        linkedin: String(contactIn.linkedin || profile.linkedin || "").trim(),
        github: String(contactIn.github || profile.github || "").trim(),
      },
      headline_role: headline,
      summary,
      technical_skills: technicalSkills,
      experience: experience.length
        ? experience
        : (profile.experience || []).map((e) => ({
            role: e.role || "",
            company: e.company || "",
            start: e.start || "",
            end: e.end || "",
            location: e.location || "",
            bullets: [] as string[],
            tools_and_tech: [] as string[],
            challenges_and_solutions: "",
          })),
      education: education.length
        ? education
        : (profile.education || []).map((e) => {
            const row = e as Record<string, unknown>;
            return {
              degree: String(row.degree || ""),
              school: String(row.school || ""),
              start: String(row.start || ""),
              end: String(row.end || ""),
            };
          }),
      certifications,
      skill_groups,
      fit_keywords_used: fitKeywordsUsed,
    },
    cover_letter: coverLetter,
    job_data: {
      company_name: String(jobIn.company_name || company || "").trim(),
      job_title: String(jobIn.job_title || role || headline || "").trim(),
      job_description: String(
        jobIn.job_description || job_description || "",
      ).trim(),
      recommended_tone: String(
        jobIn.recommended_tone || "professional",
      ).trim(),
    },
  };
}
