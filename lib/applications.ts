import type { ApplicationStatus } from "@prisma/client";

export const APPLICATION_STATUSES = [
  "SAVED",
  "APPLIED",
  "SCREENING",
  "INTERVIEWING",
  "OFFER",
  "REJECTED",
  "WITHDRAWN",
] as const satisfies readonly ApplicationStatus[];

type StatusStyle = { label: string; className: string };

export function applicationStatusStyle(status: ApplicationStatus): StatusStyle {
  switch (status) {
    case "SAVED":
      return {
        label: "Saved",
        className: "bg-slate-100 text-slate-700",
      };
    case "APPLIED":
      return {
        label: "Applied",
        className: "bg-blue-50 text-blue-700",
      };
    case "SCREENING":
      return {
        label: "Screening",
        className: "bg-amber-50 text-amber-800",
      };
    case "INTERVIEWING":
      return {
        label: "Interviewing",
        className: "bg-cyan-50 text-cyan-800",
      };
    case "OFFER":
      return {
        label: "Offer",
        className: "bg-emerald-50 text-emerald-700",
      };
    case "REJECTED":
      return {
        label: "Rejected",
        className: "bg-red-50 text-red-700",
      };
    case "WITHDRAWN":
      return {
        label: "Withdrawn",
        className: "bg-slate-100 text-slate-500",
      };
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}
