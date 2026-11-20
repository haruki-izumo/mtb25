import { createRequire } from "module";
import path from "path";

const requireFromHere = createRequire(
  path.join(process.cwd(), "lib", "rb5", "pdf.cjs"),
);

const pdf = requireFromHere("./pdf.cjs") as {
  buildResumePdf: (
    resume: unknown,
    templateId?: string,
  ) => Promise<{ name: string; type: string; file: string }>;
  buildCoverPdf: (
    coverLetter: string,
    jobData?: unknown,
    resume?: unknown,
  ) => Promise<{ name: string; type: string; file: string }>;
  buildJdPdf: (opts: {
    job_description?: string;
    company?: string;
    role?: string;
    jobUrl?: string;
  }) => Promise<{ name: string; type: string; file: string }>;
  normalizeTemplateId: (id?: string) => string;
  RESUME_TEMPLATES: { id: string; name: string }[];
};

export const buildResumePdf = pdf.buildResumePdf;
export const buildCoverPdf = pdf.buildCoverPdf;
export const buildJdPdf = pdf.buildJdPdf;
export const normalizeTemplateId = pdf.normalizeTemplateId;
export const RESUME_TEMPLATES = pdf.RESUME_TEMPLATES;
