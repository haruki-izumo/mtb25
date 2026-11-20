const PDFDocument = require("pdfkit");

const RESUME_TEMPLATES = [
  { id: "default", name: "Default" },
  { id: "style2", name: "Classic Centered" },
];

function collectPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

function fmtMonth(v) {
  if (!v) return "";
  const m = /^(\d{4})-(\d{2})$/.exec(String(v));
  if (!m) return String(v);
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const idx = Number(m[2]) - 1;
  return months[idx] ? `${months[idx]} ${m[1]}` : String(v);
}

function fmtSpan(start, end) {
  const s = fmtMonth(start);
  const e = fmtMonth(end);
  if (!s && !e) return "";
  if (!e || /^present$/i.test(String(end || "").trim())) return `${s || "—"} – Present`;
  return `${s} – ${e}`;
}

function normalizeTemplateId(id) {
  const raw = String(id || "").trim();
  if (RESUME_TEMPLATES.some((t) => t.id === raw)) return raw;
  return "default";
}

function collectBoldTerms(resume = {}) {
  const terms = new Set();
  for (const g of resume.skill_groups || []) {
    for (const s of g.skills || []) {
      const t = String(s || "").trim();
      if (t) terms.add(t);
    }
  }
  for (const s of resume.technical_skills || []) {
    const t = String(s || "").trim();
    if (t) terms.add(t);
  }
  return [...terms].sort((a, b) => b.length - a.length);
}

function splitRichSegments(text, boldTerms = []) {
  const src = String(text || "");
  if (!src) return [];

  const escaped = boldTerms
    .filter(Boolean)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const termAlt = escaped.length ? escaped.join("|") : "(?!)";
  const re = new RegExp(
    `(\\b(?:\\d{1,3}%|\\d+\\+?\\s+years?)\\b|${termAlt})`,
    "gi",
  );

  const parts = [];
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) {
      parts.push({ text: src.slice(last, m.index), bold: false });
    }
    parts.push({ text: m[0], bold: true });
    last = m.index + m[0].length;
  }
  if (last < src.length) parts.push({ text: src.slice(last), bold: false });
  return parts.length ? parts : [{ text: src, bold: false }];
}

function pageBottom(doc) {
  return doc.page.height - doc.page.margins.bottom;
}

/** Absolute-positioned drawing must add pages itself — PDFKit won't. */
function ensureSpace(doc, needed = 16) {
  if (doc.y + needed <= pageBottom(doc)) return;
  doc.addPage();
  doc.x = doc.page.margins.left;
}

/**
 * PDFKit's text({ continued: true, width }) breaks when fonts change mid-paragraph
 * (especially after centered header text) — width collapses to a thin left ribbon.
 * Place runs manually with measured word wrap + explicit page breaks instead.
 */
function drawRichText(doc, text, { boldTerms = [], fontSize = 10, indent = 0, lineGap = 1.5 } = {}) {
  const marginLeft = doc.page.margins.left;
  const left = marginLeft + indent;
  const maxWidth = doc.page.width - doc.page.margins.right - left;
  const lineHeight = fontSize * 1.25 + lineGap;
  const parts = splitRichSegments(text, boldTerms);

  const tokens = [];
  for (const part of parts) {
    const chunks = String(part.text || "").split(/(\s+)/);
    for (const chunk of chunks) {
      if (!chunk) continue;
      tokens.push({ text: chunk, bold: part.bold });
    }
  }

  let x = left;
  let y = doc.y;
  doc.fontSize(fontSize);

  const fontName = (bold) => (bold ? "Helvetica-Bold" : "Helvetica");

  const newLine = () => {
    x = left;
    y += lineHeight;
    if (y + fontSize > pageBottom(doc)) {
      doc.addPage();
      y = doc.page.margins.top;
      x = left;
    }
  };

  const paint = (str, bold) => {
    doc.font(fontName(bold)).fontSize(fontSize);
    doc.text(str, x, y, { lineBreak: false, continued: false });
    x += doc.widthOfString(str);
  };

  if (y + fontSize > pageBottom(doc)) {
    doc.addPage();
    y = doc.page.margins.top;
    x = left;
  }

  for (const token of tokens) {
    doc.font(fontName(token.bold)).fontSize(fontSize);
    const w = doc.widthOfString(token.text);
    const isSpace = /^\s+$/.test(token.text);

    if (!isSpace && x > left && x + w > left + maxWidth) newLine();

    if (!isSpace && w > maxWidth) {
      let rest = token.text;
      while (rest.length) {
        doc.font(fontName(token.bold)).fontSize(fontSize);
        let fit = rest.length;
        while (fit > 1 && doc.widthOfString(rest.slice(0, fit)) > maxWidth) fit -= 1;
        paint(rest.slice(0, fit), token.bold);
        rest = rest.slice(fit);
        if (rest.length) newLine();
      }
      continue;
    }

    if (isSpace && x === left) continue;
    paint(token.text, token.bold);
  }

  doc.x = marginLeft;
  doc.y = y + lineHeight;
}

function sectionRule(doc, title) {
  ensureSpace(doc, 36);
  doc.moveDown(0.55);
  doc.x = doc.page.margins.left;
  doc.fontSize(11).font("Helvetica-Bold").fillColor("#000").text(String(title).toUpperCase());
  const y = doc.y + 1;
  doc
    .moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .strokeColor("#222")
    .lineWidth(0.8)
    .stroke();
  doc.y = y + 8;
  doc.x = doc.page.margins.left;
  doc.strokeColor("#000").lineWidth(1);
}

function drawSquareBullet(doc, x, y) {
  const size = 3.2;
  if (y > pageBottom(doc) || y < doc.page.margins.top) return;
  doc.save();
  doc.rect(x, y - size + 0.5, size, size).fill("#111");
  doc.restore();
}

function drawJobHeader(doc, { title, dates, location, left, right, contentWidth }) {
  ensureSpace(doc, location ? 36 : 22);
  const rowY = doc.y;
  doc.fontSize(11).font("Helvetica-Bold").fillColor("#111");

  if (dates) {
    doc.fontSize(10).font("Helvetica-Oblique");
    const dateWidth = Math.min(doc.widthOfString(dates) + 2, contentWidth * 0.35);
    doc.fontSize(11).font("Helvetica-Bold");
    doc.text(title || "Role", left, rowY, {
      width: Math.max(80, contentWidth - dateWidth - 10),
      lineBreak: false,
    });
    doc
      .fontSize(10)
      .font("Helvetica-Oblique")
      .fillColor("#333")
      .text(dates, right - dateWidth, rowY, {
        width: dateWidth,
        align: "right",
        lineBreak: false,
      });
    doc.y = rowY + 14;
  } else {
    doc.text(title || "Role", left, rowY, { width: contentWidth, lineBreak: false });
    doc.y = rowY + 14;
  }

  doc.x = left;
  doc.fillColor("#000");
  if (location) {
    ensureSpace(doc, 14);
    doc
      .fontSize(9)
      .font("Helvetica")
      .fillColor("#555")
      .text(String(location), left, doc.y, { width: contentWidth, lineBreak: false });
    doc.y += 12;
    doc.fillColor("#000");
  }
}

function certLabel(c) {
  if (typeof c === "string") return c.trim();
  const name = String(c?.name || "").trim();
  if (!name) return "";
  const date = String(c?.date || "").trim();
  const suggested = c?.suggested ? " (suggested)" : "";
  return `${name}${date ? ` (${date})` : ""}${suggested}`;
}

async function buildResumePdfDefault(resume = {}) {
  const doc = new PDFDocument({ margin: 50, size: "LETTER" });
  const contact = resume.contact || {};

  doc
    .fontSize(18)
    .font("Helvetica-Bold")
    .fillColor("#111")
    .text(contact.full_name || "Resume", { align: "center" });
  const contactParts = [
    contact.email,
    contact.phone,
    contact.location,
    contact.linkedin,
    contact.github,
  ]
    .map((v) => String(v || "").trim())
    .filter(Boolean);
  if (contactParts.length) {
    doc.moveDown(0.25);
    doc
      .fontSize(9)
      .font("Helvetica")
      .fillColor("#333")
      .text(contactParts.join("  |  "), { align: "center" });
  }
  doc.fillColor("#000");

  if (resume.summary) {
    sectionRule(doc, "Summary");
    doc.fontSize(10).font("Helvetica").text(resume.summary, { align: "left" });
  }

  const exp = resume.experience || [];
  if (exp.length) {
    sectionRule(doc, "Experience");
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const contentWidth = right - left;
    for (const e of exp) {
      drawJobHeader(doc, {
        title: [e.role, e.company].filter(Boolean).join(" | "),
        dates: fmtSpan(e.start, e.end),
        location: e.location,
        left,
        right,
        contentWidth,
      });
      doc.fillColor("#000").font("Helvetica").fontSize(10);
      for (const b of e.bullets || []) {
        doc.text(`• ${b}`, { indent: 10 });
      }
      if ((e.tools_and_tech || []).length) {
        doc.fontSize(9).fillColor("#444").text(`Tools: ${e.tools_and_tech.join(", ")}`, { indent: 10 });
        doc.fillColor("#000");
      }
      doc.moveDown(0.5);
    }
  }

  const edu = resume.education || [];
  if (edu.length) {
    sectionRule(doc, "Education");
    for (const e of edu) {
      const head = [e.degree, e.school].filter(Boolean).join(" — ");
      doc.fontSize(11).font("Helvetica-Bold").text(head || "Education");
      const span = fmtSpan(e.start, e.end);
      if (span) doc.fontSize(9).font("Helvetica").fillColor("#555").text(span);
      doc.fillColor("#000").moveDown(0.4);
    }
  }

  const certs = (resume.certifications || []).map(certLabel).filter(Boolean);
  if (certs.length) {
    sectionRule(doc, "Certifications");
    doc.fontSize(10).font("Helvetica");
    for (const c of certs) doc.text(`• ${c}`);
  }

  const groups = (resume.skill_groups || []).filter((g) => (g.skills || []).length);
  if (groups.length) {
    sectionRule(doc, "Skills");
    doc.fontSize(10).font("Helvetica");
    for (const g of groups) {
      const line =
        g.category && groups.length > 1
          ? `${g.category}: ${g.skills.join(", ")}`
          : g.skills.join(", ");
      doc.text(line);
    }
  }

  const buf = await collectPdf(doc);
  return {
    name: "resume.pdf",
    type: "application/pdf",
    file: buf.toString("base64"),
  };
}

async function buildResumePdfStyle2(resume = {}) {
  const doc = new PDFDocument({
    margin: 48,
    size: "LETTER",
  });
  const contact = resume.contact || {};
  const boldTerms = collectBoldTerms(resume);
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentWidth = right - left;

  // Centered header
  doc
    .fontSize(22)
    .font("Helvetica-Bold")
    .fillColor("#111")
    .text(contact.full_name || "Resume", { align: "center" });

  const contactParts = [
    contact.email,
    contact.phone,
    contact.location,
    contact.linkedin,
    contact.github,
  ]
    .map((v) => String(v || "").trim())
    .filter(Boolean);
  if (contactParts.length) {
    doc.moveDown(0.25);
    doc
      .fontSize(9)
      .font("Helvetica")
      .fillColor("#333")
      .text(contactParts.join("  |  "), { align: "center" });
  }
  // Centered text leaves doc.x mid-page; pin back to the left margin.
  doc.x = left;
  doc.fillColor("#000");

  if (resume.summary) {
    sectionRule(doc, "Professional Summary");
    drawRichText(doc, resume.summary, { boldTerms, fontSize: 10, lineGap: 2 });
  }

  const groups = (resume.skill_groups || []).filter((g) => (g.skills || []).length);
  if (groups.length) {
    sectionRule(doc, "Core Skills");
    for (const g of groups) {
      const label = String(g.category || "").trim();
      const skills = (g.skills || []).join(", ");
      const line = label ? `${label}: ${skills}` : skills;
      ensureSpace(doc, 18);
      drawSquareBullet(doc, left + 2, doc.y + 7);
      drawRichText(doc, line, {
        boldTerms: label ? [label, `${label}:`] : [],
        fontSize: 10,
        indent: 12,
        lineGap: 1.2,
      });
    }
  }

  const exp = resume.experience || [];
  if (exp.length) {
    sectionRule(doc, "Employment History");
    for (const e of exp) {
      drawJobHeader(doc, {
        title: [e.role, e.company].filter(Boolean).join(" | "),
        dates: fmtSpan(e.start, e.end),
        location: e.location,
        left,
        right,
        contentWidth,
      });

      for (const b of e.bullets || []) {
        ensureSpace(doc, 20);
        drawSquareBullet(doc, left + 2, doc.y + 7);
        drawRichText(doc, b, {
          boldTerms,
          fontSize: 10,
          indent: 12,
          lineGap: 1.5,
        });
      }
      doc.moveDown(0.25);
    }
  }

  const edu = resume.education || [];
  if (edu.length) {
    sectionRule(doc, "Education");
    for (const e of edu) {
      drawJobHeader(doc, {
        title: [e.degree, e.school].filter(Boolean).join(" — ") || "Education",
        dates: e.years || fmtSpan(e.start, e.end),
        left,
        right,
        contentWidth,
      });
    }
  }

  const certs = (resume.certifications || []).map(certLabel).filter(Boolean);
  if (certs.length) {
    sectionRule(doc, "Certifications");
    for (const c of certs) {
      ensureSpace(doc, 16);
      drawSquareBullet(doc, left + 2, doc.y + 7);
      drawRichText(doc, c, { fontSize: 10, indent: 12, lineGap: 1.2 });
    }
  }

  const buf = await collectPdf(doc);
  return {
    name: "resume.pdf",
    type: "application/pdf",
    file: buf.toString("base64"),
  };
}

async function buildResumePdf(resume = {}, templateId = "default") {
  const id = normalizeTemplateId(templateId);
  if (id === "style2") return buildResumePdfStyle2(resume);
  return buildResumePdfDefault(resume);
}

async function buildCoverPdf(coverLetter, jobData = {}, resume = {}) {
  const doc = new PDFDocument({ margin: 54, size: "LETTER" });
  const name = resume?.contact?.full_name || "";
  if (name) {
    doc.fontSize(12).font("Helvetica-Bold").text(name);
    doc.moveDown(0.5);
  }
  const company = jobData.company_name || "";
  const role = jobData.job_title || "";
  if (company || role) {
    doc.fontSize(10).font("Helvetica").fillColor("#444");
    if (role) doc.text(`Re: ${role}`);
    if (company) doc.text(company);
    doc.fillColor("#000").moveDown(0.8);
  }
  doc.fontSize(11).font("Helvetica").text(String(coverLetter || "").trim() || "(empty)", {
    align: "left",
    lineGap: 3,
  });
  const buf = await collectPdf(doc);
  return {
    name: "cover_letter.pdf",
    type: "application/pdf",
    file: buf.toString("base64"),
  };
}

async function buildJdPdf({ job_description, company, role, jobUrl }) {
  const doc = new PDFDocument({ margin: 50, size: "LETTER" });
  doc.fontSize(14).font("Helvetica-Bold").text(role || "Job Description");
  if (company) doc.fontSize(11).font("Helvetica").text(company);
  if (jobUrl) doc.fontSize(9).fillColor("#555").text(jobUrl);
  doc.fillColor("#000").moveDown();
  doc.fontSize(10).font("Helvetica").text(String(job_description || ""), { lineGap: 2 });
  const buf = await collectPdf(doc);
  const safe = String(company || role || "job").replace(/[^\w.-]+/g, "_").slice(0, 40);
  return {
    name: `${safe || "job"}.pdf`,
    type: "application/pdf",
    file: buf.toString("base64"),
  };
}

module.exports = {
  buildResumePdf,
  buildCoverPdf,
  buildJdPdf,
  RESUME_TEMPLATES,
  normalizeTemplateId,
};
