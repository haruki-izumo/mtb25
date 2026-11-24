/** Postgres UTF-8 text columns reject null bytes (error 22021). */
export function containsNullBytes(value: string): boolean {
  return value.includes("\u0000");
}

export function isJobDescriptionFile(file: File): boolean {
  const name = file.name.toLowerCase();
  if (name.endsWith(".txt") || name.endsWith(".pdf")) return true;
  if (file.type === "text/plain" || file.type === "application/pdf") return true;
  return false;
}

export function isPdfJobDescriptionFile(file: {
  name: string;
  type?: string;
}): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith(".pdf") || file.type === "application/pdf";
}

export function sanitizeJobDescriptionText(raw: string): string {
  return raw.replace(/\u0000/g, "").trim();
}

export function validateJobDescriptionText(
  text: string,
): { ok: true; text: string } | { ok: false; error: string } {
  if (containsNullBytes(text)) {
    return {
      ok: false,
      error:
        "Job description contains invalid characters. Re-upload as .txt or a text-based PDF",
    };
  }

  const cleaned = sanitizeJobDescriptionText(text);
  if (cleaned.length < 20) {
    return {
      ok: false,
      error:
        "Could not read enough text from the job description (need at least 20 characters)",
    };
  }
  if (cleaned.length > 50000) {
    return {
      ok: false,
      error: "Job description is too long (max 50,000 characters)",
    };
  }
  // Raw PDF bytes mistaken for text
  if (cleaned.startsWith("%PDF")) {
    return {
      ok: false,
      error: "Could not extract text from that PDF. Try another file or a .txt export",
    };
  }
  return { ok: true, text: cleaned };
}

export async function extractTextFromPdfBuffer(
  data: Uint8Array,
): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(data);
  const result = await extractText(pdf, { mergePages: true });
  const text = result.text;
  if (Array.isArray(text)) return text.join("\n");
  return String(text ?? "");
}
