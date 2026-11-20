type AnswerQuestion = {
  label: string;
  options: string[] | null;
};

type AnswerProfile = {
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  location?: string;
  zipCode?: string;
  country?: string;
  linkedin?: string;
  github?: string;
  experience?: { start?: string }[];
  autoFillPrefs?: Record<string, unknown>;
} | null;

type AnswerResume = {
  contact?: {
    full_name?: string;
    email?: string;
    phone?: string;
    location?: string;
    linkedin?: string;
    github?: string;
  };
  summary?: string;
  headline_role?: string;
  experience?: { start?: string }[];
} | null;

type JobData = {
  company_name?: string;
  job_title?: string;
} | null;

export function flattenQuestions(questions: unknown): AnswerQuestion[] {
  if (!Array.isArray(questions)) return [];
  return questions.map((q) => {
    if (typeof q === "string") return { label: q, options: null };
    if (q && typeof q === "object") {
      const obj = q as Record<string, unknown>;
      return {
        label: String(obj.label || obj.question || obj.text || "").trim(),
        options: Array.isArray(obj.options)
          ? obj.options.map(String)
          : null,
      };
    }
    return { label: String(q || ""), options: null };
  });
}

function pickOption(
  options: string[] | null | undefined,
  predicates: Array<(o: string) => boolean>,
) {
  if (!options?.length) return null;
  for (const pred of predicates) {
    const hit = options.find((o) => pred(String(o).toLowerCase()));
    if (hit) return hit;
  }
  return null;
}

function estimateYears(profile: AnswerProfile, resume: AnswerResume) {
  const exps = resume?.experience?.length
    ? resume.experience
    : profile?.experience || [];
  let minStart: number | null = null;
  for (const e of exps) {
    const m = /^(\d{4})/.exec(String(e.start || ""));
    if (m) {
      const y = Number(m[1]);
      if (!minStart || y < minStart) minStart = y;
    }
  }
  if (!minStart) return 3;
  return Math.max(1, new Date().getFullYear() - minStart);
}

export function answerOne(
  { label, options }: AnswerQuestion,
  profile: AnswerProfile,
  resume: AnswerResume,
  jobData: JobData,
) {
  const q = String(label || "").toLowerCase();
  const contact = resume?.contact || {};
  const prefs = profile?.autoFillPrefs || {};

  const fromPref = (keys: string[]) => {
    for (const k of keys) {
      const v = prefs[k];
      if (v != null && String(v).trim()) return String(v).trim();
    }
    return null;
  };

  if (
    /authorized|work authorization|legally.*(work|authorized)|eligible to work/.test(
      q,
    )
  ) {
    const pref = fromPref([
      "workAuthorization",
      "authorizedToWork",
      "work_authorization",
    ]);
    if (pref) return pref;
    if (options) {
      return (
        pickOption(options, [
          (o) => /\byes\b/.test(o) && !/no/.test(o),
          (o) => /citizen|permanent|authorized|eligible/.test(o),
        ]) || options[0]
      );
    }
    return "Yes";
  }

  if (/sponsor|sponsorship|visa|h-?1b|require.*visa/.test(q)) {
    const pref = fromPref([
      "needsSponsorship",
      "sponsorship",
      "visaSponsorship",
    ]);
    if (pref) return pref;
    if (options) {
      return (
        pickOption(options, [
          (o) => /\bno\b/.test(o) && !/yes/.test(o),
          (o) => /do not need|not required|no sponsorship/.test(o),
        ]) || options[0]
      );
    }
    return "No";
  }

  if (/relocat/.test(q)) {
    const pref = fromPref(["willingToRelocate", "relocate"]);
    if (pref) return pref;
    if (options) {
      return (
        pickOption(options, [(o) => /\byes\b/.test(o), (o) => /\bno\b/.test(o)]) ||
        options[0]
      );
    }
    return "Yes, for the right opportunity";
  }

  if (/remote|hybrid|on-?site|work from (home|office)/.test(q)) {
    const pref = fromPref(["workPreference", "remotePreference"]);
    if (pref) return pref;
    if (options) {
      return (
        pickOption(options, [
          (o) => /remote|hybrid|flexible|any/.test(o),
          (o) => /\byes\b/.test(o),
        ]) || options[0]
      );
    }
    return "Open to remote, hybrid, or on-site as needed";
  }

  if (/salary|compensation|pay expectation|expected (pay|salary)/.test(q)) {
    const pref = fromPref(["salaryExpectation", "expectedSalary", "salary"]);
    if (pref) return pref;
    if (options) return options[Math.floor(options.length / 2)] || options[0];
    return "Negotiable based on total compensation and role scope";
  }

  if (
    /start date|when can you (start|begin)|available to start|notice period/.test(
      q,
    )
  ) {
    const pref = fromPref(["startDate", "availability", "noticePeriod"]);
    if (pref) return pref;
    if (options) {
      return (
        pickOption(options, [
          (o) => /immediate|asap|2 week|two week|available/.test(o),
        ]) || options[0]
      );
    }
    return "I can start within two weeks of an offer";
  }

  if (/how did you (hear|find)|source|referral/.test(q)) {
    const pref = fromPref(["howDidYouHear", "source"]);
    if (pref) return pref;
    if (options) {
      return (
        pickOption(options, [
          (o) => /linkedin|company (site|website)|job board|careers/.test(o),
        ]) || options[0]
      );
    }
    return "Company careers page / LinkedIn";
  }

  if (/years?.{0,20}experience|how many years/.test(q)) {
    const pref = fromPref(["yearsExperience", "experienceYears"]);
    if (pref) return pref;
    const years = estimateYears(profile, resume);
    if (options) {
      const n = String(years);
      const hit = options.find(
        (o) => o.includes(n) || new RegExp(`\\b${years}\\b`).test(o),
      );
      if (hit) return hit;
      return (
        options[Math.min(options.length - 1, Math.max(0, years - 1))] ||
        options[0]
      );
    }
    return String(years);
  }

  if (/linkedin/.test(q)) {
    return contact.linkedin || profile?.linkedin || fromPref(["linkedin"]) || "";
  }
  if (/github|portfolio|website|personal site/.test(q)) {
    return (
      contact.github ||
      profile?.github ||
      fromPref(["github", "portfolio", "website"]) ||
      ""
    );
  }
  if (/phone|mobile|cell/.test(q)) {
    return contact.phone || profile?.phone || "";
  }
  if (/email|e-mail/.test(q)) {
    return contact.email || profile?.email || "";
  }
  if (/city|location|where.*(live|based)|current (city|location)/.test(q)) {
    return contact.location || profile?.location || "";
  }
  if (/zip|postal|postcode/.test(q)) {
    return profile?.zipCode || fromPref(["zipCode", "postalCode"]) || "";
  }
  if (/country/.test(q)) {
    return profile?.country || fromPref(["country"]) || "";
  }
  if (/first name/.test(q)) {
    return profile?.firstName || contact.full_name?.split(" ")[0] || "";
  }
  if (/last name|surname|family name/.test(q)) {
    return (
      profile?.lastName ||
      contact.full_name?.split(" ").slice(1).join(" ") ||
      ""
    );
  }
  if (/full name|legal name|^name$/.test(q)) {
    return (
      contact.full_name ||
      [profile?.firstName, profile?.lastName].filter(Boolean).join(" ") ||
      profile?.name ||
      ""
    );
  }

  if (/why (do you want|are you interested)|why this (role|company|job)/.test(q)) {
    const company = jobData?.company_name || "your team";
    const role = jobData?.job_title || "this role";
    return `I'm excited about ${role} at ${company} because it aligns with my experience and the impact I want to make. I'd welcome the chance to contribute and grow with the team.`;
  }

  if (/tell us about yourself|brief intro|about you/.test(q)) {
    if (resume?.summary) return resume.summary;
    const name =
      contact.full_name ||
      [profile?.firstName, profile?.lastName].filter(Boolean).join(" ") ||
      "I";
    const role =
      resume?.headline_role || jobData?.job_title || "software professional";
    return `${name} is a ${role} with hands-on experience delivering results across relevant projects. Happy to share more details in an interview.`;
  }

  if (options?.length) {
    return (
      pickOption(options, [
        (o) => /\byes\b/.test(o),
        (o) => /n\/a|not applicable|prefer not|decline/.test(o),
      ]) || options[0]
    );
  }

  if (resume?.summary && /experience|background|qualif/.test(q)) {
    return resume.summary.slice(0, 600);
  }

  return fromPref(["defaultAnswer"]) || "";
}

export function answerQuestions(input: {
  questions: unknown;
  profile?: AnswerProfile;
  resume?: AnswerResume;
  jobData?: JobData;
}) {
  const list = flattenQuestions(input.questions);
  return list.map((q) => ({
    question: q.label,
    answer: answerOne(
      q,
      input.profile ?? null,
      input.resume ?? null,
      input.jobData ?? null,
    ),
  }));
}
