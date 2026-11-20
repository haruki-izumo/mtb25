/* =====================================================================
 * job-detect/sites/paycom.js — Paycom career portal
 * (*.paycomonline.net/v4/ats/web.php/portal/<clientkey>/jobs/<id>;
 * older pcN.paycomonline.com hosts serve the same SPA and 302 onto
 * this URL shape).
 * =====================================================================
 * Ported from BidHub's packages/job-parsers/content/platforms/paycom/
 * index.js.
 *
 * The posting is rendered client-side: an H1 title, a location
 * subtitle, then "Overview" / "Description" / "Qualifications"
 * sections — each an H2 followed by a `.job-posting-content` block
 * (or, for Overview, a label/value list). The page ALSO injects a
 * JobPosting JSON-LD (`script#google-job-json-ld`), which is the ONLY
 * place the employer is named — the header itself just shows the
 * tenant's logo + "Careers" — plus datePosted/employmentType/address.
 * ===================================================================== */
(function () {
  "use strict";

  const JOB_PATH_PATTERN = /\/v4\/ats\/web\.php\/portal\/[^/]+\/jobs\/\d+\/?$/i;
  function isPaycomJobPath(pathname) {
    return JOB_PATH_PATTERN.test(String(pathname || ""));
  }
  const cleanText = (value) => String(value ?? "").replace(/​/g, "").replace(/\s+/g, " ").trim();

  function readPaycomJsonLd(doc = document) {
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(script.textContent || "");
        const candidates = Array.isArray(parsed) ? parsed : [parsed];
        const posting = candidates.find((entry) => entry && entry["@type"] === "JobPosting");
        if (posting) return posting;
      } catch { /* not JSON (or not ours) — keep scanning */ }
    }
    return null;
  }

  // The posting card: the nearest ancestor of the title that also holds a
  // section heading. Keeps the portal header ("Careers", "Sign In") and the
  // footer out of the description.
  function getPostingRoot(titleElement, doc) {
    let node = titleElement.parentElement;
    while (node && node !== doc.body) {
      if (node.querySelector("h2")) return node;
      node = node.parentElement;
    }
    return titleElement.parentElement || doc.body;
  }

  // A section's content, as plain text: the heading's first ancestor that
  // carries more text than the heading itself. Prefer its
  // `.job-posting-content` block, else everything but the heading
  // (Overview's label/value pairs). Falls back to the siblings between this
  // heading and the next. `content` and the siblings are live, attached
  // elements (innerText preferred); the cloned-and-trimmed `container` is
  // detached, so only textContent reaches it there — same distinction
  // job-detect/sites/greenhouse.js's fix draws for live elements vs.
  // job-detect/sites/ashby.js's htmlFragmentToText for detached ones.
  function getSectionText(heading) {
    const headingText = cleanText(heading.textContent);
    let container = heading.parentElement;
    while (container && cleanText(container.textContent) === headingText) {
      container = container.parentElement;
    }
    if (container && container.querySelectorAll("h2").length === 1) {
      const content = container.querySelector(".job-posting-content");
      if (content) return (content.innerText || content.textContent || "").trim();
      const clone = container.cloneNode(true);
      clone.querySelectorAll("h2").forEach((el) => el.remove());
      return (clone.textContent || "").trim();
    }
    let wrapper = heading;
    while (wrapper.parentElement && wrapper.parentElement !== container && !wrapper.nextElementSibling) {
      wrapper = wrapper.parentElement;
    }
    const parts = [];
    for (let node = wrapper.nextElementSibling; node; node = node.nextElementSibling) {
      if (node.matches("h2") || node.querySelector("h2")) break;
      parts.push((node.innerText || node.textContent || "").trim());
    }
    return parts.filter(Boolean).join("\n");
  }

  function formatJsonLdLocation(posting) {
    const address = posting?.jobLocation?.address;
    if (!address || typeof address !== "object") return null;
    const cityState = [address.addressLocality, address.addressRegion].filter(Boolean).join(", ");
    return [cityState, address.postalCode, address.addressCountry].map(cleanText).filter(Boolean).join(" ") || null;
  }
  const humanizeEmploymentType = (value) => cleanText(value).toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());

  function parsePaycomJob(doc = document, loc = window.location) {
    if (!isPaycomJobPath(loc?.pathname)) return null;
    const posting = readPaycomJsonLd(doc);
    const titleElement = doc.querySelector("h1");
    if (!titleElement) return null; // SPA shell still loading ("Loading...") — the JSON-LD lands with the render
    const title = cleanText(titleElement.textContent) || cleanText(posting?.title) || null;
    if (!title) return null;

    const root = getPostingRoot(titleElement, doc);
    const sections = Array.from(root.querySelectorAll("h2"))
      .map((heading) => ({ heading: cleanText(heading.textContent), text: getSectionText(heading) }))
      .filter((section) => section.heading && section.text);

    // The location subtitle sits in the header block, BEFORE the first
    // section heading; Overview's label/value rows reuse the same
    // subtitle1 typography, so a posting without a location line must not
    // borrow one from there.
    const firstHeading = root.querySelector("h2");
    const locationElement = Array.from(root.querySelectorAll('[class*="ui-typography-subtitle1"]'))
      .filter((el) => !firstHeading || firstHeading.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING)
      .find((el) => cleanText(el.textContent));
    const location = cleanText(locationElement?.textContent) || formatJsonLdLocation(posting);

    const details = [];
    if (location) details.push(["Location", location]);
    if (posting?.employmentType && !/^other$/i.test(posting.employmentType)) {
      details.push(["Employment type", humanizeEmploymentType(posting.employmentType)]);
    }
    if (posting?.datePosted) details.push(["Posted", posting.datePosted]);

    const descriptionParts = [];
    if (details.length) descriptionParts.push(details.map(([label, value]) => `${label}: ${value}`).join("\n"));
    for (const section of sections) descriptionParts.push(`${section.heading}\n${section.text}`);
    if (sections.length === 0) {
      // No rendered sections yet — the JSON-LD description (plain text) is
      // the fallback body.
      const text = cleanText(String(posting?.description ?? "").replace(/&nbsp;/g, " "));
      if (!text) return null;
      descriptionParts.push(text);
    }
    const description = descriptionParts.join("\n\n");

    return {
      title,
      // Company-less rule: the employer is only ever named in the JSON-LD;
      // null = "no employer named".
      company: cleanText(posting?.hiringOrganization?.name) || null,
      description,
      ...(posting?.datePosted ? { postedDate: posting.datePosted } : {}),
    };
  }

  window.ProactiveJobDetect.parser(() => parsePaycomJob());
})();
