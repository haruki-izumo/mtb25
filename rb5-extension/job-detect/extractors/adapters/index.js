/* =====================================================================
 * extractors/adapters/index.js — ordered site-adapter registry
 * =====================================================================
 * One entry per ATS / job-board family. match(ctx) decides whether the
 * adapter applies to the current host (or a Greenhouse embed); extract(ctx)
 * returns the { title?, company?, description? } it can find — any field it
 * omits is left to the generic fallback. ORDER IS SIGNIFICANT: the first
 * matching adapter wins (mirrors the original if/else chain).
 *
 * ctx = { firstText, doc, url, host, ghEmbed }:
 *   firstText(selectors)  first selector with text (job-detect/dom/query)
 *   doc                   the Document being read
 *   url                   location.href (string)
 *   host                  location.hostname
 *   ghEmbed               true when a Greenhouse embed widget is present
 *
 * Pure (no closures over extraction state) so each adapter is testable in
 * isolation. Moved verbatim from job-fit.js's inline registry; the only
 * change is mutation → return and globals → ctx. Dual export.
 * ===================================================================== */
(function () {
  "use strict";

  const ADAPTERS = [
    {
      id: "linkedin",
      match: (c) => c.host.includes("linkedin.com"),
      extract: (c) => ({
        title: c.firstText([
          ".job-details-jobs-unified-top-card__job-title h1",
          ".jobs-unified-top-card__job-title",
          ".top-card-layout__title",
          "h1",
        ]),
        company: c.firstText([
          ".job-details-jobs-unified-top-card__company-name a",
          ".job-details-jobs-unified-top-card__company-name",
          ".topcard__org-name-link",
          ".jobs-unified-top-card__company-name",
        ]),
        description: c.firstText([
          "#job-details",
          ".jobs-description__content .jobs-description-content__text",
          ".jobs-box__html-content",
          ".description__text",
        ]),
      }),
    },
    {
      id: "indeed",
      match: (c) => c.host.includes("indeed.com"),
      extract: (c) => ({
        title: c.firstText([
          "h1[data-testid='jobsearch-JobInfoHeader-title']",
          "h1.jobsearch-JobInfoHeader-title",
          "h1",
        ]),
        company: c.firstText([
          "[data-testid='inlineHeader-companyName'] a",
          "[data-testid='inlineHeader-companyName']",
          "div[data-testid='jobsearch-CompanyInfoContainer'] a",
        ]),
        description: c.firstText(["#jobDescriptionText", ".jobsearch-jobDescriptionText"]),
      }),
    },
    {
      id: "lever",
      match: (c) => c.host.includes("lever.co"),
      extract: (c) => ({
        title: c.firstText([".posting-headline h2", "h2", "h1"]),
        company: c.firstText([".main-header-text", ".main-header-logo", ".main-header"]),
        description: c.firstText([".section-wrapper.page-full-width", ".content-wrapper", ".section"]),
      }),
    },
    {
      id: "greenhouse",
      match: (c) => c.host.includes("greenhouse.io") || c.ghEmbed,
      extract: (c) => {
        // Covers classic boards.greenhouse.io, the newer job-boards(.eu)
        // .greenhouse.io template, AND the company-hosted JS embed widget
        // (?gh_jid=... / #grnhse_app). Same selectors for all three.
        // .app-title / .job__title h1 are the hosted-board / embed-widget
        // role title. On company career pages that embed via ?gh_jid=, the
        // role is rendered into the site's OWN markup (e.g. KERV uses
        // h3.career-title) while the page <h1>/<h2> is a listing heading
        // ("Open Positions") — so try common role-title classes before the
        // generic h1/h2 catch.
        const title = c.firstText([
          ".app-title",
          ".job__title h1",
          "[class*='job-title' i]",
          "[class*='career-title' i]",
          "[class*='posting-title' i]",
          "[class*='position-title' i]",
          "h1",
          "h2",
        ]);
        let company = c.firstText([".company-name", ".employer-name", "[class*='company-name' i]"]);
        if (!company) {
          // "Role at Company" from og:title AND the document title. Tried
          // BEFORE the URL slug: the slug is the greenhouse *board* name,
          // which is sometimes a generic word ("technology") or, worse, a
          // DIFFERENT legal entity than the one actually hiring — confirmed
          // real case: job-boards.greenhouse.io/embed/job_app?for=xai's own
          // document.title is "Job Application for Mobile Android Engineer
          // at SpaceXSI" (the real employer), while its `for=` slug is just
          // "xai" (the Greenhouse *board* name) → wrongly capitalized to
          // "Xai" by the fallback below. This block used to be ordered
          // AFTER that fallback despite this comment already saying it
          // should run first — the `for` slug always being present meant
          // it won every single time and this block never ran. Check BOTH
          // titles — og:title is often just the role ("Head of Customer
          // Support"), with the company only in document.title ("Job
          // Application for … at Relai").
          for (const ogt of [
            c.doc.querySelector("meta[property='og:title']")?.getAttribute("content") || "",
            c.doc.title || "",
          ]) {
            const m = ogt.match(/\bat\s+(.+?)\s*$/i);
            if (m) {
              const cand = m[1].trim();
              if (
                cand.toLowerCase() !== (title || "").toLowerCase() &&
                !/^(?:job ?board|careers?|jobs?|hiring|vacanc(?:y|ies))$/i.test(cand) &&
                // Aggregator / third-party boards title themselves generically
                // ("Third-Party Job Posts") — reject so the JD opener below
                // (the real employer) wins.
                !/\b(?:job ?posts?|third[\s-]?party)\b/i.test(cand)
              ) {
                company = cand;
                break;
              }
            }
          }
        }
        if (!company) {
          // Embed iframe names the company in the `for` query param; its
          // path slug is "embed"/"job_board" (was misread as "Embed"). Last
          // resort now — the board slug can be a generic word or a
          // different legal entity than the title's own "at <Company>".
          try {
            const forParam = new URL(c.url).searchParams.get("for");
            if (forParam) company = forParam.charAt(0).toUpperCase() + forParam.slice(1);
          } catch { /* malformed URL — ignore */ }
        }
        if (!company) {
          // Third-party / aggregator boards (…thirdpartyboard) title
          // themselves generically, but the real employer is named in the
          // JD's "At <Company>, we're / we / our …" opener — e.g.
          // "At Cloudbeds, we're not just building software". Tried before
          // the slug (which here is "cloudbedsthirdpartyboard", not a clean
          // brand). Requires a Capitalised name + the "…, we/our" anchor so
          // it doesn't grab arbitrary "At <place>," prose.
          const jd = c.firstText([".job__description", ".job__description.body", "#content .body", "#content", "#grnhse_app"]);
          const m = jd.match(/\bAt\s+([A-Z][A-Za-z0-9&.\-]*(?:\s+[A-Z][A-Za-z0-9&.\-]*){0,3}?)\s*,\s*(?:we\b|we['’]re\b|our\b|you\b)/);
          if (m) company = m[1].trim();
        }
        if (!company && !c.ghEmbed) {
          // Hosted boards: /<company>/jobs/<id> — first path segment. LAST
          // resort (after the title's "at <Company>") because the segment is
          // the board name, which can be a generic word. Reject the embed
          // wrapper segments too.
          const seg = new URL(c.url).pathname.split("/").filter(Boolean)[0] || "";
          if (seg && !/^(?:jobs?|embed|job_board)$/i.test(seg)) company = seg.charAt(0).toUpperCase() + seg.slice(1);
        }
        if (!company) {
          // og:site_name — on a company career page that embeds the widget
          // (?gh_jid=…), the site's own brand is the employer (KERV, etc.).
          // Tried before the logo alt because marketing-page headers are
          // full of non-brand logos (cookie-consent widgets, etc.). Reject
          // generic portal labels.
          const ogSite = (c.doc.querySelector("meta[property='og:site_name']")?.getAttribute("content") || "").trim();
          if (ogSite && !/^(?:careers?|jobs?|hiring|vacanc(?:y|ies)|job ?board)$/i.test(ogSite)) company = ogSite;
        }
        if (!company) {
          // Header logo alt — final resort, only a real brand logo. Reject
          // hero/banner, generic "Job Board Logo"/"Company Logo"/"Logo"/"Job
          // Board", portal-chrome logos with a Careers/Jobs/Hiring word, AND
          // cookie/consent widget buttons ("Revisit consent button",
          // "Cookieyes logo", "Close") that litter marketing-page headers.
          // Strip a trailing "logo" word ("Corelight Logo" → "Corelight").
          const logoAlt = Array.from(
            c.doc.querySelectorAll("header img[alt], [class*='logo' i] img[alt], a[href='/'] img[alt]")
          )
            .map((i) => (i.getAttribute("alt") || "").trim())
            .find((a) => a && !/banner|hero|cover|background|placeholder|consent|cookie|close|accept|^(?:job ?board|company)? ?logo$|^job ?board$|\b(?:careers?|jobs?|hiring|vacanc(?:y|ies))\b/i.test(a));
          if (logoAlt) company = logoAlt.replace(/\s*\blogo\s*$/i, "").trim();
        }
        const description = c.firstText([
          ".job__description",
          ".job__description.body",
          "#job-description",
          "#content .body",
          "#content",
          "#grnhse_app .job__description",
          "#grnhse_app #content",
          "#grnhse_app",
        ]);
        return { title, company, description };
      },
    },
    {
      id: "traffit",
      match: (c) => c.host.includes("traffit.com"),
      extract: (c) => {
        // Multi-tenant: each customer is a subdomain (sanoma.traffit.com),
        // so the subdomain is the company signal; og:site_name beats it.
        const ogSite = (c.doc.querySelector("meta[property='og:site_name']")?.getAttribute("content") || "").trim();
        const sub = String(c.host).split(".")[0] || "";
        const subPretty = sub && !/^www$/i.test(sub) ? sub.charAt(0).toUpperCase() + sub.slice(1) : "";
        return {
          company: ogSite || subPretty,
          title: c.firstText(["main h1", "article h1", "h1"]),
          description: c.firstText(["main article", "main", "article", "[class*='offer' i]", "[class*='public' i]"]),
        };
      },
    },
    {
      id: "zohorecruit",
      match: (c) => c.host.includes("zohorecruit"),
      // Deliberately no description — JSON-LD usually wins, else the
      // footer-stripped generic fallback produces a clean JD.
      extract: (c) => ({
        title: c.firstText([".cw-job-title", ".job-title", "h1"]),
        company:
          c.firstText([".cw-company-name", ".company-name"]) ||
          (c.doc.querySelector("meta[property='og:site_name']")?.getAttribute("content") || ""),
      }),
    },
    {
      id: "ashby",
      match: (c) => c.host.includes("ashbyhq.com"),
      extract: (c) => ({
        title: c.firstText(["h1"]),
        company: c.firstText([".ashby-job-posting-detail-company-name", "a[href*='/jobs']"]),
        description: c.firstText([".ashby-job-posting-detail-section", "main"]),
      }),
    },
    {
      id: "workable",
      match: (c) => c.host.includes("workable.com"),
      extract: (c) => ({
        title: c.firstText(["h1.job-title", "h1"]),
        company: c.firstText([".company-name", ".job-company"]),
        description: c.firstText(["section.job-content", ".job-description"]),
      }),
    },
    {
      id: "wellfound",
      match: (c) => c.host.includes("wellfound.com") || c.host.includes("angel.co"),
      extract: (c) => ({
        title: c.firstText(["[data-test='JobTitle']", "h1"]),
        company: c.firstText(["[data-test='StartupName']", "a[href*='/company/']"]),
        description: c.firstText([".description"]),
      }),
    },
    {
      id: "smartrecruiters",
      match: (c) => c.host.includes("smartrecruiters.com"),
      extract: (c) => ({
        title: c.firstText(["h1.job-title", "h1"]),
        company: c.firstText([".company-name", ".company"]),
        description: c.firstText(["#st-jobDescription", ".job-description"]),
      }),
    },
    {
      id: "hirehive",
      match: (c) => c.host.includes("hirehive.com"),
      extract: (c) => {
        const logoAlt = c.doc.querySelector("header img[alt]")?.getAttribute("alt") || "";
        return {
          title: c.firstText(["h1"]),
          company: logoAlt.trim() || c.host.split(".")[0],
          description: c.firstText(["main", "article", "#description", ".description"]),
        };
      },
    },
    {
      id: "workday",
      match: (c) => c.host.includes("workdayjobs.com") || c.host.includes("myworkdayjobs.com"),
      extract: (c) => ({
        title: c.firstText(["[data-automation-id='jobPostingHeader']", "h1", "h2"]),
        company: c.firstText(["[data-automation-id='companyName']", "img[data-automation-id='logo']"]),
        description: c.firstText(["[data-automation-id='jobPostingDescription']"]),
      }),
    },
    {
      id: "rippling",
      // Rippling ATS job board: ats.rippling.com/<company>/jobs/<uuid>.
      // The host can carry a region shard (ats.us1.rippling.com) and the
      // path an i18n locale prefix (/de-DE/<company>/jobs/<uuid>), so match
      // on the brand + a /jobs/ path rather than an exact host.
      match: (c) => c.host.includes("rippling.com") && /\/jobs\//.test(c.url),
      extract: (c) => {
        // Why an adapter: the generic fallback gets BOTH fields wrong here.
        //   • Role  — Rippling's first <h1> is a SECTION heading ("The
        //     Opportunity"), so the generic dom-h1 path titles the job
        //     "The Opportunity". The real role is in <title> / og:title
        //     ("Cloud Security Engineer | Career Opportunities"), both
        //     reliably the role; we set it here so dom-h1 never fires.
        //   • Company — og:title's second half is the generic "Career
        //     Opportunities", so the title-split heuristic mis-badges the
        //     ROLE ("Cloud Security Engineer") as the employer. The board
        //     slug — the path segment before "jobs" — is the real company
        //     ("workstreet" → "Workstreet").
        // Description is left to the generic JD-container logic.
        const out = {};
        const ogt = c.doc.querySelector("meta[property='og:title']")?.getAttribute("content") || "";
        // <title> is the clean role; og:title appends " | Career
        // Opportunities" — split on the pipe only (role titles can contain
        // a hyphen/en-dash, e.g. "Senior Java – React Engineer").
        const role = String(c.doc.title || ogt).split("|")[0].trim();
        if (role) out.title = role;
        try {
          const segs = new URL(c.url).pathname.split("/").filter(Boolean);
          const ji = segs.indexOf("jobs");
          const slug = ji > 0 ? segs[ji - 1] : segs[0] || "";
          if (slug && !/^jobs?$/i.test(slug)) {
            out.company = slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
          }
        } catch { /* malformed URL — ignore */ }
        return out;
      },
    },
    {
      id: "recruitcrm",
      match: (c) => c.host.includes("recruitcrm.io"),
      extract: (c) => {
        // RecruitCRM apply pages (recruitcrm.io/apply/<id>). og:title is
        // "Apply To <role> With <Company>". The JD renders inside a
        // same-origin iframe with no src (written by JS) — read its
        // contentDocument; the parent body otherwise has no JD text.
        const out = { title: c.firstText(["h1"]) };
        const ogt = c.doc.querySelector("meta[property='og:title']")?.getAttribute("content") || "";
        const withM = ogt.match(/\bwith\s+(.+?)\s*$/i);
        if (withM) out.company = withM[1].trim();
        if (!out.title) {
          const roleM = ogt.match(/^\s*apply to\s+(.+?)\s+with\s+/i);
          if (roleM) out.title = roleM[1].trim();
        }
        // Newer recruitcrm.io/apply/<id> (Next.js) pages don't always give
        // "… With <Company>" in og:title, but the employer's logo carries a
        // clean alt (alt="Remote Leverage"). Use it as a company fallback.
        if (!out.company) {
          const alt = (c.doc.querySelector("header img[alt], img[alt]:not([alt=''])")?.getAttribute("alt") || "").trim();
          if (alt && !/^(?:logo|company|apply|recruit\s*crm)$/i.test(alt)) out.company = alt;
        }
        let desc = "";
        const ifr = c.doc.querySelector("#view_html_iframe, iframe[title='Job Description' i]");
        if (ifr) {
          try {
            const idoc = ifr.contentDocument;
            if (idoc && idoc.body) desc = (idoc.body.innerText || idoc.body.textContent || "").trim();
          } catch { /* cross-origin — ignore */ }
        }
        if (!desc) desc = c.firstText(["#secondSectionOfApplyPage", "main", "article"]);
        // Only surface a description here if it's substantial. On the newer
        // Next.js layout the JD sits behind a "View Job Description" toggle
        // (rendered into un-hooked Tailwind divs); a thin hero/form match
        // would otherwise pre-empt the generic body-walk that reads the JD
        // once the panel is open, and would fail the >400-char page gate.
        if (desc && desc.length >= 400) out.description = desc;
        return out;
      },
    },
    {
      id: "bamboohr",
      match: (c) => c.host.includes("bamboohr.com"),
      extract: (c) => ({
        title: c.firstText(["h2.position", "h1"]),
        company: c.firstText([".company-name", "header h1"]),
        description: c.firstText([".module", "main"]),
      }),
    },
    {
      id: "jobvite",
      match: (c) => c.host.includes("jobvite.com"),
      extract: (c) => {
        // jobs.jobvite.com/<company>/job/<id> — the slug doubles as a clean
        // company fallback when the markup doesn't name it.
        const title = c.firstText([
          "h2.jv-header",
          ".jv-header h2",
          ".jv-job-detail-title",
          "main h1",
          "h1",
        ]);
        let company = c.firstText([".jv-company-name", ".jv-header-logo img", "[data-cy='company-name']"]);
        if (!company) {
          const logoAlt = c.doc.querySelector(".jv-header-logo img, header img[alt]")?.getAttribute("alt") || "";
          if (logoAlt) company = logoAlt.trim();
        }
        if (!company) {
          const seg = new URL(c.url).pathname.split("/").filter(Boolean)[0] || "";
          if (seg && !/^jobs?$/i.test(seg)) {
            company = seg.replace(/[-_]+/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
          }
        }
        const description = c.firstText([
          ".jv-job-detail-description",
          ".jv-job-description",
          ".jv-job-detail-meta + div",
          "main",
        ]);
        return { title, company, description };
      },
    },
    {
      id: "careerspage",
      // Manatal-powered careers-page.com sites (e.g.
      // billease.careers-page.com). No JSON-LD / <h1>; og:site_name is the
      // PLATFORM ("Manatal", not the employer) and the page title is
      // "<Role> | <Company>", so the generic fallback mis-set company to
      // "Manatal" and kept the "| <Company>" suffix on the role.
      match: (c) => c.host.includes("careers-page.com"),
      extract: (c) => {
        const out = {
          title: c.firstText([".single-job-header-row", ".job-header h1", "h1"]),
          description: c.firstText([".single-job-content .description", ".description", ".single-job-content"]),
        };
        // Company: the "<Role> | <Company>" title suffix (nice casing, e.g.
        // "BillEase"); else the host subdomain (billease.* -> "Billease").
        const t = c.doc.querySelector("meta[property='og:title']")?.getAttribute("content") || c.doc.title || "";
        const parts = t.split("|").map((s) => s.trim()).filter(Boolean);
        if (parts.length >= 2) out.company = parts[parts.length - 1];
        else {
          const sub = String(c.host).split(".")[0] || "";
          if (sub && !/^www$/i.test(sub)) out.company = sub.charAt(0).toUpperCase() + sub.slice(1);
        }
        return out;
      },
    },
    {
      id: "earcu",
      // eArcu ATS (careers.<company>.co.uk, ea1.earcu.com, …). The host
      // varies per employer, so match on the platform's DOM signature
      // instead of a hostname. eArcu's JD-container classes
      // ("PosDescriptionText", "earcu_posdescription") are concatenated
      // without separators, so the generic section-hook (\bdescription\b)
      // never matched them and detection came up empty.
      match: (c) =>
        !!c.doc.querySelector(".earcu_posdescription, .PosDescriptionText, .posDescriptionContainer") ||
        /\bpos_description\b|\bearcu_body\b/i.test(c.doc.body?.className || ""),
      extract: (c) => ({
        // .JobTitle h1 is the role. The page ALSO has an <h1>"Job
        // description" page heading and a ".../description" URL slug, so
        // target .JobTitle first. Company is left to the generic
        // title-split fallback (document.title is "<Company> - <Role>";
        // og:title is "<Company> Careers").
        title: c.firstText([".JobTitle h1", ".posDescriptionContainer .JobTitle", ".posDescriptionContainer h1"]),
        // .PosDescriptionText wraps BOTH the role JD (.earcu_posdescription)
        // AND the .permText block (About <Company> + recruitment-agency
        // notes) — using only .earcu_posdescription dropped those sections.
        // The map / benefits / share widgets are siblings outside it, so
        // they don't leak in. (A stray "Apply Now" line is scrubbed by
        // stripShareLines downstream.)
        description: c.firstText([".PosDescriptionText", ".earcu_posdescription", ".posDescriptionContainer"]),
      }),
    },
    {
      id: "ttcportals",
      match: (c) => c.host.includes("ttcportals.com"),
      extract: (c) => {
        // TalentReef-style: JD in .job-details__main, no JSON-LD; the host
        // subdomain is noise so the header logo alt is the cleanest brand.
        const out = {
          title: c.firstText([".job-details__main h1", "h1"]),
          description: c.firstText([".job-details__main", "#job-details", ".padded-v-medium.space-medium"]),
        };
        const logoAlt =
          c.doc.querySelector("header img[alt], [class*='logo' i] img[alt]")?.getAttribute("alt") || "";
        if (logoAlt && !/banner|hero|cover|background|placeholder|^logo$/i.test(logoAlt)) {
          out.company = logoAlt.trim();
        }
        return out;
      },
    },
    // ---- Adapters below added after comparing against a competitor
    // extension's own per-ATS selectors (no company/third-party-rights
    // concern — same owner). firstText() returns plain trimmed text, not
    // HTML, matching every adapter above — selectors that cross-reference
    // multiple elements (join several sections, etc.) use c.doc directly
    // and join their own .innerText, for the same reason. ----
    {
      id: "icims",
      match: (c) => c.host.includes("icims.com"),
      extract: (c) => ({
        title: c.firstText(["h1.iCIMS_Header"]),
        description: c.firstText(["div.iCIMS_JobContent"]),
      }),
    },
    {
      id: "paylocity",
      match: (c) => c.host.includes("paylocity.com") && c.url.includes("/Details"),
      extract: (c) => {
        // Title is "<Company> - <Position>" — splits on the LAST '-'.
        const t = c.doc.title || "";
        const i = t.lastIndexOf("-");
        const out = { description: c.firstText([".job-preview-details", ".preview-location"]) };
        if (i >= 2) {
          out.company = t.slice(0, i).trim();
          out.title = t.slice(i + 1).trim();
        }
        return out;
      },
    },
    {
      id: "oraclecloud",
      match: (c) => c.host.includes("oraclecloud.com"),
      extract: (c) => {
        const out = { title: c.firstText(["h1.job-details__title"]) };
        // Title is "<Position> - <Company>" — company AFTER the last '-',
        // minus trailing filler like "Careers"/"Career Site".
        const t = c.doc.title || "";
        const i = t.lastIndexOf("-");
        if (i >= 2) {
          const company = t
            .slice(i + 1)
            .replace(/(?:[\s|·—–-]*\b(?:careers?|site)\b)+[\s|·—–-]*$/i, "")
            .trim();
          if (company) out.company = company;
        }
        const sections = Array.from(c.doc.querySelectorAll(".job-details__section"))
          .map((el) => (el.innerText || el.textContent || "").trim())
          .filter(Boolean);
        if (sections.length) out.description = sections.join("\n\n");
        return out;
      },
    },
    {
      id: "dayforcehcm",
      match: (c) => c.host.includes("dayforcehcm.com"),
      extract: (c) => ({
        title: c.firstText(['h1[test-id="job-detail-title"]']),
        description: c.firstText(["#main-content .ant-card-bordered"]),
      }),
    },
    {
      id: "teamtailor",
      match: (c) => c.host.includes("teamtailor.com"),
      extract: (c) => {
        const company = c.doc.querySelector('meta[property="og:site_name"]')?.content?.trim() || "";
        let title = c.doc.querySelector('meta[property="og:title"]')?.content?.trim() || "";
        // og:title is "<Position> - <Company>" — strip the company suffix.
        if (company && title.endsWith(company)) title = title.slice(0, -company.length).trim();
        if (title.endsWith("-")) title = title.slice(0, -1).trim();
        const sections = Array.from(c.doc.querySelectorAll("main section"));
        // Last section is the application form, not part of the posting.
        const description = sections
          .slice(0, -1)
          .map((el) => (el.innerText || el.textContent || "").trim())
          .filter(Boolean)
          .join("\n\n");
        const out = {};
        if (title) out.title = title;
        if (company) out.company = company;
        if (description) out.description = description;
        return out;
      },
    },
    {
      id: "comeet",
      match: (c) => c.host.includes("comeet.com"),
      extract: (c) => {
        const out = {};
        const rawTitle = (c.doc.title || "").trim();
        const atIndex = rawTitle.lastIndexOf(" at ");
        out.title = c.firstText([".positionName"]) || (atIndex > 0 ? rawTitle.slice(0, atIndex).trim() : rawTitle);
        if (atIndex > 0) out.company = rawTitle.slice(atIndex + 4).trim();
        const blocks = Array.from(c.doc.querySelectorAll(".userDesignedContent"))
          .map((el) => (el.innerText || el.textContent || "").trim())
          .filter(Boolean);
        if (blocks.length) out.description = blocks.join("\n\n");
        return out;
      },
    },
    {
      id: "dice",
      match: (c) => c.host.includes("dice.com") && !c.url.includes("job-applications"),
      extract: (c) => {
        const positionEl = c.doc.querySelector("h1");
        const out = { title: (positionEl?.innerText || positionEl?.textContent || "").trim() };
        const companyEl = positionEl?.parentElement?.parentElement?.children?.[0]?.querySelector("a");
        if (companyEl) out.company = (companyEl.innerText || companyEl.textContent || "").trim();
        const parts = [];
        for (const sel of ["span.order-3", "div.order-4"]) {
          const el = c.doc.querySelector(sel);
          if (el) parts.push((el.innerText || el.textContent || "").trim());
        }
        for (const h2 of c.doc.querySelectorAll("h2")) {
          const label = (h2.textContent || "").trim().toLowerCase();
          if ((label === "job details" || label === "company info") && h2.parentElement) {
            parts.push((h2.parentElement.innerText || h2.parentElement.textContent || "").trim());
          }
        }
        if (parts.length) out.description = parts.filter(Boolean).join("\n\n");
        return out;
      },
    },
    {
      id: "eightfold",
      match: (c) => c.host.includes("eightfold.ai"),
      extract: (c) => ({
        title: c.firstText(["h1.position-title"]),
        description: c.firstText(["div.position-job-description-column"]),
      }),
    },
    {
      id: "jobdiva",
      match: (c) => c.host.includes("jobdiva.com"),
      extract: (c) => {
        const out = { title: c.firstText([".jd-job-title"]) };
        const labelEl = c.doc.querySelector(".jd-desc-title");
        const bodyEl = labelEl?.parentElement?.nextSibling;
        if (bodyEl && bodyEl.nodeType === 1) {
          out.description = (bodyEl.innerText || bodyEl.textContent || "").trim();
        }
        return out;
      },
    },
    {
      id: "motionrecruitment",
      match: (c) => c.host.includes("motionrecruitment.com"),
      extract: (c) => {
        // A dead/unknown posting 404s on the same URL shape as a real job
        // view — the job-view container (not just any <h1>) has to be
        // present, or an unrelated page heading would get reported as a job.
        if (c.doc.querySelector('[class*="NotFoundView_module"]')) return {};
        if (!c.doc.querySelector('[class*="JobView_module"]')) return {};
        return {
          title: c.firstText(['h1[class*="JobView_module_h1"]', "h1"]),
          // Motion is a staffing agency — the applicant applies to Motion,
          // not whichever client the posting body describes.
          company: "Motion Recruitment",
          description: c.firstText(['[class*="jobDescription"]', '[class^="Job_jobDescription"]']),
        };
      },
    },
    {
      id: "pinpointhq",
      match: (c) => c.host.includes("pinpointhq.com"),
      extract: (c) => {
        const out = { title: c.doc.querySelector('meta[property="og:title"]')?.content?.trim() || "" };
        const company = (c.doc.title || "").split("|").pop().replace(/careers/i, "").trim();
        if (company) out.company = company;
        out.description = c.firstText([".external-panel__content--ruled"]);
        return out;
      },
    },
    {
      id: "careerplug",
      match: (c) => c.host.includes("careerplug.com"),
      extract: (c) => {
        const title = c.doc.querySelector('meta[property="og:title"]')?.content?.trim() || "";
        const out = { title };
        const rawTitle = c.doc.querySelector("title")?.textContent?.trim() || "";
        if (title) {
          const company = rawTitle.replace(title, "").replace(" | ", "").trim();
          if (company) out.company = company;
        }
        const container = c.doc.querySelector("div.content-body");
        const jd = container?.querySelector("div.job-description-container");
        const meta = container?.querySelector("div.job-info");
        const parts = [meta, jd]
          .filter(Boolean)
          .map((el) => (el.innerText || el.textContent || "").trim())
          .filter(Boolean);
        if (parts.length) out.description = parts.join("\n\n");
        return out;
      },
    },
    {
      id: "recruitee",
      match: (c) => c.host.includes("recruitee.com"),
      extract: (c) => {
        const company = c.doc.querySelector('meta[property="og:site_name"]')?.content?.trim() || "";
        let title = c.firstText(["h1"]);
        if (!title) {
          const ogTitle = c.doc.querySelector('meta[property="og:title"]')?.content?.trim() || "";
          title =
            company && ogTitle.startsWith(`${company} - `) ? ogTitle.slice(company.length + 3).trim() : ogTitle;
        }
        const out = { title };
        if (company) out.company = company;
        out.description = c.firstText([".custom-css-style-job-description", '[class*="job-description"]']);
        return out;
      },
    },
    {
      id: "freshteam",
      match: (c) => c.host.includes("freshteam.com"),
      extract: (c) => {
        const companyRaw = c.doc.querySelector('meta[property="og:description"]')?.content?.trim() || "";
        const company = companyRaw.split("|")[0].replace("Posted by :", "").trim();
        const positionRaw = c.doc.querySelector('meta[property="og:title"]')?.content?.trim() || "";
        const parts = positionRaw ? positionRaw.split(" - ") : [];
        const title = (parts.length > 1 ? parts.slice(0, -1).join(" - ") : positionRaw).replace(
          "Hiring for ",
          ""
        ).trim();
        const out = { title };
        if (company) out.company = company;
        const header = c.firstText([".job-details-header .content .row .col-xs-8"]);
        const body = c.firstText([".job-details-content > :first-child"]);
        if (body) out.description = header ? `${header}\n\n${body}` : body;
        return out;
      },
    },
    {
      id: "avature",
      match: (c) => c.host.includes("avature.net"),
      extract: (c) => {
        const out = {};
        let title = c.firstText([".banner__text__title"]);
        let company = "";
        const subdomain = c.host.split(".")[0];
        if (subdomain && subdomain !== "www") company = subdomain.charAt(0).toUpperCase() + subdomain.slice(1);
        if (!title) {
          // "<Position> - - <id> - <Company>"
          const parts = (c.doc.title || "").split(" - ").map((s) => s.trim()).filter(Boolean);
          if (parts.length) {
            title = parts[0];
            const last = parts[parts.length - 1];
            if (last && !/^\d+$/.test(last)) company = last;
          }
        }
        out.title = title;
        if (company) out.company = company;
        out.description = c.firstText([
          ".article__content__view__field.description--rich-text",
          ".description--rich-text",
        ]);
        return out;
      },
    },
    {
      id: "epam",
      match: (c) => c.host.includes("careers.epam.com"),
      extract: (c) => {
        let title = c.firstText([
          '[data-testid="job-details-banner-title"]',
          '[class*="JobDetailsBanner_title"]',
          "h1",
        ]);
        if (!title) title = (c.doc.title || "").split("|")[0].trim();
        return {
          title,
          // Single-employer careers site — no per-vacancy employer element.
          company: "EPAM Systems",
          description: c.firstText(['[data-testid="description-container"]', '[class*="Description_container"]']),
        };
      },
    },
    {
      id: "gusto",
      match: (c) => c.host.includes("gusto.com") || c.host.includes("gusto-hiring.com"),
      extract: (c) => {
        const t = c.doc.title || "";
        const parts = t.split(" at ");
        const out = { title: parts[0]?.trim() || "" };
        if (parts[1]) out.company = parts[1].trim();
        out.description = c.firstText(['[data-action="job_postings-show"]']);
        return out;
      },
    },
  ];

  if (typeof window !== "undefined" && window.ProactiveJobDetect) {
    window.ProactiveJobDetect.extractors.adapters = ADAPTERS;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = ADAPTERS;
})();
