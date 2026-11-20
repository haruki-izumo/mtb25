import { z } from "zod";
import {
  PROJECT_CURRENCIES,
  PROJECT_PRIORITIES,
} from "@/lib/projects/status";

const priorityValues = PROJECT_PRIORITIES.map((p) => p.value) as [
  (typeof PROJECT_PRIORITIES)[number]["value"],
  ...(typeof PROJECT_PRIORITIES)[number]["value"][],
];

const currencyValues = PROJECT_CURRENCIES as unknown as [
  (typeof PROJECT_CURRENCIES)[number],
  ...(typeof PROJECT_CURRENCIES)[number][],
];

const dateKey = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .or(z.literal(""))
  .optional();

export const projectFormSchema = z
  .object({
    projectName: z.string().trim().min(1, "Project name is required").max(200),
    clientId: z.string().min(1, "Client is required"),
    country: z
      .string()
      .trim()
      .length(2, "Country is required")
      .transform((v) => v.toUpperCase()),
    city: z.string().trim().max(120).optional().or(z.literal("")),
    industry: z.string().trim().max(80).optional().or(z.literal("")),
    projectTypeId: z.string().min(1).nullable().optional().or(z.literal("")),
    description: z.string().trim().min(1, "Description is required").max(10000),
    scopeOfWork: z.string().trim().max(10000).optional().or(z.literal("")),
    budget: z.coerce.number().min(0, "Budget must be ≥ 0"),
    currency: z.enum(currencyValues).default("USD"),
    contractValue: z.coerce.number().min(0).optional().nullable(),
    paymentTerms: z.string().trim().max(200).optional().or(z.literal("")),
    dateSecured: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Date secured is required"),
    startDate: dateKey,
    expectedEndDate: dateKey,
    actualEndDate: dateKey,
    projectManagerId: z.string().min(1, "Project manager is required"),
    teamMemberIds: z.array(z.string().min(1)).default([]),
    priority: z.enum(priorityValues).default("MEDIUM"),
    progressPercent: z.coerce.number().int().min(0).max(100).default(0),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    notes: z.string().trim().max(10000).optional().or(z.literal("")),
  })
  .superRefine((data, ctx) => {
    if (data.startDate && data.expectedEndDate) {
      if (data.expectedEndDate < data.startDate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["expectedEndDate"],
          message: "Expected end must be on or after start date",
        });
      }
    }
    if (
      data.contractValue != null &&
      Number.isFinite(data.contractValue) &&
      data.contractValue < 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contractValue"],
        message: "Contract value must be ≥ 0",
      });
    }
  });

export type ProjectFormValues = z.infer<typeof projectFormSchema>;

export const createClientSchema = z.object({
  name: z.string().trim().min(1).max(160),
  country: z
    .string()
    .trim()
    .length(2)
    .transform((v) => v.toUpperCase()),
  contactPerson: z.string().trim().max(120).optional().or(z.literal("")),
  email: z.string().trim().email().optional().or(z.literal("")),
  phone: z.string().trim().max(40).optional().or(z.literal("")),
});

export const changeStatusSchema = z.object({
  projectId: z.string().min(1),
  toStatusId: z.string().min(1),
  comment: z.string().trim().max(2000).optional().or(z.literal("")),
  actualEndDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .or(z.literal("")),
});
