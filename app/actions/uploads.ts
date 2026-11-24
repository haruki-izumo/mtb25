"use server";

import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { z } from "zod";
import { requireSession } from "@/lib/auth-helpers";
import {
  extractTextFromPdfBuffer,
  isPdfJobDescriptionFile,
  validateJobDescriptionText,
} from "@/lib/job-description";

const ALLOWED_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
]);

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB
const JD_MAX_BYTES = 8 * 1024 * 1024;

function safeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}

/** Save a resume file under public/uploads/resumes and return its public URL. */
export async function uploadResumeFile(
  formData: FormData,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  try {
    await requireSession();
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return { ok: false, error: "Choose a resume file" };
    }
    if (file.size > MAX_BYTES) {
      return { ok: false, error: "Resume must be 8 MB or smaller" };
    }
    if (file.type && !ALLOWED_TYPES.has(file.type)) {
      return {
        ok: false,
        error: "Resume must be PDF, Word, or plain text",
      };
    }

    const ext = path.extname(file.name) || ".pdf";
    const base = safeFileName(path.basename(file.name, ext)) || "resume";
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fileName = `${stamp}-${base}${ext}`;
    const dir = path.join(process.cwd(), "public", "uploads", "resumes");
    await mkdir(dir, { recursive: true });
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(path.join(dir, fileName), buffer);

    return { ok: true, url: `/uploads/resumes/${fileName}` };
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "digest" in err &&
      typeof (err as { digest?: string }).digest === "string" &&
      (err as { digest: string }).digest.startsWith("NEXT_")
    ) {
      throw err;
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Upload failed",
    };
  }
}

export async function assertResumeUrl(url: string) {
  z
    .string()
    .min(1)
    .refine(
      (v) => v.startsWith("/uploads/resumes/") || /^https?:\/\//i.test(v),
      "Invalid resume URL",
    )
    .parse(url);
}

/**
 * Accept a .txt or .pdf job description and return extracted plain text
 * suitable for storing in Postgres (no null bytes).
 */
export async function extractJobDescriptionFile(
  formData: FormData,
): Promise<
  | { ok: true; text: string; fileName: string }
  | { ok: false; error: string }
> {
  try {
    await requireSession();
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return { ok: false, error: "Choose a job description file" };
    }
    if (file.size > JD_MAX_BYTES) {
      return { ok: false, error: "Job description must be 8 MB or smaller" };
    }

    const name = file.name.toLowerCase();
    const isPdf = isPdfJobDescriptionFile(file);
    const isTxt =
      name.endsWith(".txt") ||
      (!isPdf && (file.type === "text/plain" || file.type === ""));

    if (!isTxt && !isPdf) {
      return {
        ok: false,
        error: "Job description must be a .txt or .pdf file",
      };
    }

    let rawText: string;
    if (isPdf) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        rawText = await extractTextFromPdfBuffer(bytes);
      } catch {
        return {
          ok: false,
          error:
            "Could not read that PDF. Try another file or export the JD as .txt",
        };
      }
    } else {
      rawText = await file.text();
    }

    const checked = validateJobDescriptionText(rawText);
    if (!checked.ok) {
      return {
        ok: false,
        error: isPdf
          ? `${checked.error}. Scanned/image-only PDFs are not supported`
          : checked.error,
      };
    }

    return { ok: true, text: checked.text, fileName: file.name };
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "digest" in err &&
      typeof (err as { digest?: string }).digest === "string" &&
      (err as { digest: string }).digest.startsWith("NEXT_")
    ) {
      throw err;
    }
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "Failed to read job description",
    };
  }
}
