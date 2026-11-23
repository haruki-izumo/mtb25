/** Postgres UTF-8 text columns reject null bytes (error 22021). */
export function containsNullBytes(value: string): boolean {
  return value.includes("\u0000");
}

export function isPlainTextJobDescriptionFile(file: File): boolean {
  const name = file.name.toLowerCase();
  if (name.endsWith(".txt")) return true;
  if (file.type === "text/plain") return true;
  return false;
}

export function sanitizeJobDescriptionText(raw: string): string {
  // Strip null bytes that appear when binary files (e.g. PDF) are read as text.
  return raw.replace(/\u0000/g, "").trim();
}

export function validateJobDescriptionText(
  text: string,
): { ok: true; text: string } | { ok: false; error: string } {
  const cleaned = sanitizeJobDescriptionText(text);
  if (containsNullBytes(text)) {
    return {
      ok: false,
      error:
        "Job description must be a plain .txt file (PDF/Word binary files are not supported)",
    };
  }
  if (cleaned.length < 20) {
    return {
      ok: false,
      error: "Job description file must have at least 20 characters",
    };
  }
  if (cleaned.length > 50000) {
    return {
      ok: false,
      error: "Job description is too long (max 50,000 characters)",
    };
  }
  // Heuristic: PDF headers / binary junk after stripping nulls
  if (
    cleaned.startsWith("%PDF") ||
    cleaned.includes("endobj") ||
    /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(cleaned)
  ) {
    return {
      ok: false,
      error:
        "Job description looks like a binary file. Upload a .txt export instead of PDF/Word",
    };
  }
  return { ok: true, text: cleaned };
}
