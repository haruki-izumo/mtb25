import { mkdir, writeFile, readFile } from "fs/promises";
import path from "path";
import type { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  buildPromptText,
  extractJsonObject,
  normalizeResultInfo,
} from "@/lib/rb5/prompt";
import {
  buildCoverPdf,
  buildResumePdf,
  normalizeTemplateId,
} from "@/lib/rb5/pdf";
import { getPromptProfileForUser } from "@/lib/rb5/profile-adapter";
import { chatCompletion } from "@/lib/rb5/gemini";

async function savePdfBase64(fileName: string, base64: string) {
  const dir = path.join(process.cwd(), "public", "uploads", "applications");
  await mkdir(dir, { recursive: true });
  const safe = fileName.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const out = `${stamp}-${safe}`;
  await writeFile(path.join(dir, out), Buffer.from(base64, "base64"));
  return `/uploads/applications/${out}`;
}

export async function fileToBase64Payload(url: string | null | undefined) {
  if (!url) return null;
  if (url.startsWith("/uploads/")) {
    const full = path.join(process.cwd(), "public", url.replace(/^\//, ""));
    const buf = await readFile(full);
    const name = path.basename(full);
    return {
      name,
      type: "application/pdf",
      file: buf.toString("base64"),
    };
  }
  return null;
}

export async function composeResumePrompt(params: {
  userId: string;
  role: Role;
  profileId: string;
  job_description: string;
  company?: string;
  roleTitle?: string;
  bulletMin?: number;
  bulletMax?: number;
  fit?: unknown;
}) {
  const loaded = await getPromptProfileForUser(
    params.profileId,
    params.userId,
    params.role,
  );
  if (!loaded) {
    const err = new Error("Profile not found");
    (err as Error & { status: number }).status = 404;
    throw err;
  }
  return buildPromptText({
    profile: loaded.prompt,
    job_description: params.job_description,
    company: params.company,
    role: params.roleTitle,
    bulletMin: params.bulletMin,
    bulletMax: params.bulletMax,
    fit: params.fit,
  });
}

async function persistGeneration(params: {
  userId: string;
  profileId: string;
  resultInfo: ReturnType<typeof normalizeResultInfo>;
  resumeFile: { name: string; type: string; file: string };
  coverFile: { name: string; type: string; file: string };
  jd_url?: string;
  resumeTemplate: string;
  mode?: string;
  keyPreview?: string;
}) {
  const resumePdfUrl = await savePdfBase64(
    params.resumeFile.name || "resume.pdf",
    params.resumeFile.file,
  );
  const coverPdfUrl = await savePdfBase64(
    params.coverFile.name || "cover_letter.pdf",
    params.coverFile.file,
  );
  const now = new Date();
  const app = await prisma.application.create({
    data: {
      profileId: params.profileId,
      ownerId: params.userId,
      company: params.resultInfo.job_data.company_name || "Unknown",
      jobTitle: params.resultInfo.job_data.job_title || "Unknown",
      url: params.jd_url || null,
      status: "APPLIED",
      applied: true,
      submitted: false,
      appliedAt: now,
      mode: params.mode || null,
      resumeTemplate: params.resumeTemplate,
      keyPreview: params.keyPreview || null,
      resultInfo: params.resultInfo,
      resumePdfUrl,
      coverPdfUrl,
    },
  });

  return {
    generationId: app.id,
    resultInfo: params.resultInfo,
    resultFiles: [params.resumeFile, params.coverFile],
  };
}

export async function finishManualGenerate(params: {
  userId: string;
  role: Role;
  profileId: string;
  job_description?: string;
  company?: string;
  roleTitle?: string;
  jd_url?: string;
  resumeTemplate?: string;
  aiResponseText: string;
}) {
  const loaded = await getPromptProfileForUser(
    params.profileId,
    params.userId,
    params.role,
  );
  if (!loaded) {
    const err = new Error("Profile not found");
    (err as Error & { status: number }).status = 404;
    throw err;
  }

  const parsed = extractJsonObject(params.aiResponseText);
  const resultInfo = normalizeResultInfo(parsed, {
    profile: loaded.prompt,
    company: params.company,
    role: params.roleTitle,
    job_description: params.job_description,
  });
  const templateId = normalizeTemplateId(
    params.resumeTemplate || loaded.prompt.resumeTemplateId || "style2",
  );
  const [resumeFile, coverFile] = await Promise.all([
    buildResumePdf(resultInfo.resume, templateId),
    buildCoverPdf(
      resultInfo.cover_letter,
      resultInfo.job_data,
      resultInfo.resume,
    ),
  ]);

  return persistGeneration({
    userId: params.userId,
    profileId: params.profileId,
    resultInfo,
    resumeFile,
    coverFile,
    jd_url: params.jd_url,
    resumeTemplate: templateId,
    mode: "manual",
  });
}

export async function fullGenerateAndDownload(params: {
  userId: string;
  role: Role;
  profileId: string;
  job_description: string;
  company?: string;
  roleTitle?: string;
  jd_url?: string;
  resumeTemplate?: string;
  bulletMin?: number;
  bulletMax?: number;
  mode?: string;
  keyIndex?: number;
  fit?: unknown;
}) {
  const loaded = await getPromptProfileForUser(
    params.profileId,
    params.userId,
    params.role,
  );
  if (!loaded) {
    const err = new Error("Profile not found");
    (err as Error & { status: number }).status = 404;
    throw err;
  }

  const mode =
    String(params.mode || "free").toLowerCase() === "pro" ? "PRO" : "FREE";
  const keys = await prisma.profileApiKey.findMany({
    where: { profileId: params.profileId, mode },
    orderBy: { createdAt: "asc" },
  });
  const idx = Number(params.keyIndex) || 0;
  const keyRow = keys[idx] || keys[0];
  if (!keyRow) {
    const err = new Error(
      `No ${mode.toLowerCase()} API key on this profile. Add one in Profiles → Settings.`,
    );
    (err as Error & { status: number; code: string }).status = 400;
    (err as Error & { code: string }).code = "no_api_key";
    throw err;
  }

  const promptText = buildPromptText({
    profile: loaded.prompt,
    job_description: params.job_description,
    company: params.company,
    role: params.roleTitle,
    bulletMin: params.bulletMin,
    bulletMax: params.bulletMax,
    fit: params.fit,
  });

  const aiText = await chatCompletion({
    apiKey: keyRow.key,
    prompt: promptText,
  });
  const parsed = extractJsonObject(aiText);
  const resultInfo = normalizeResultInfo(parsed, {
    profile: loaded.prompt,
    company: params.company,
    role: params.roleTitle,
    job_description: params.job_description,
  });
  const templateId = normalizeTemplateId(
    params.resumeTemplate || loaded.prompt.resumeTemplateId || "style2",
  );
  const [resumeFile, coverFile] = await Promise.all([
    buildResumePdf(resultInfo.resume, templateId),
    buildCoverPdf(
      resultInfo.cover_letter,
      resultInfo.job_data,
      resultInfo.resume,
    ),
  ]);

  const preview =
    keyRow.key.length > 8
      ? `${keyRow.key.slice(0, 4)}…${keyRow.key.slice(-4)}`
      : "****";

  return persistGeneration({
    userId: params.userId,
    profileId: params.profileId,
    resultInfo,
    resumeFile,
    coverFile,
    jd_url: params.jd_url,
    resumeTemplate: templateId,
    mode: mode.toLowerCase(),
    keyPreview: preview,
  });
}
