import type { LucideIcon } from "lucide-react";
import {
  Brain,
  CheckCircle2,
  ClipboardList,
  Code2,
  HelpCircle,
  Layers,
  RefreshCw,
  UserRound,
  XCircle,
  Ban,
} from "lucide-react";
import type { RoundOutcome, RoundType } from "@prisma/client";

export const ROUND_TYPE_CONFIG: Record<
  RoundType,
  { label: string; icon: LucideIcon; color: string }
> = {
  HR_RECRUITER: { label: "Recruiter", icon: UserRound, color: "#0891b2" },
  TECH: { label: "Technical", icon: Code2, color: "#2563eb" },
  ASSESSMENT: { label: "Assessment", icon: ClipboardList, color: "#7c3aed" },
  SYSTEM_DESIGN: { label: "System design", icon: Layers, color: "#ca8a04" },
  BEHAVIORAL: { label: "Behavioral", icon: Brain, color: "#db2777" },
  FINAL: { label: "Final", icon: CheckCircle2, color: "#16a34a" },
  OTHER: { label: "Other", icon: HelpCircle, color: "#6b7280" },
};

export const ROUND_OUTCOME_CONFIG: Record<
  RoundOutcome,
  { label: string; icon: LucideIcon; color: string }
> = {
  PENDING: { label: "Pending", icon: HelpCircle, color: "#ca8a04" },
  PASSED: { label: "Passed", icon: CheckCircle2, color: "#16a34a" },
  FAILED: { label: "Failed", icon: XCircle, color: "#dc2626" },
  RESCHEDULED: { label: "Rescheduled", icon: RefreshCw, color: "#ea580c" },
  CANCELED: { label: "Canceled", icon: Ban, color: "#6b7280" },
  NO_SHOW: { label: "No show", icon: XCircle, color: "#dc2626" },
};

/** Event color for calendar: yellow scheduled, cyan recruiter, gray canceled */
export function roundEventStyle(type: RoundType, outcome: RoundOutcome) {
  if (outcome === "CANCELED") {
    return { bg: "bg-slate-200", text: "text-slate-500 line-through", border: "border-slate-300" };
  }
  if (outcome === "PASSED" || outcome === "FAILED" || outcome === "NO_SHOW") {
    return { bg: "bg-emerald-50", text: "text-emerald-800", border: "border-emerald-200" };
  }
  if (outcome === "RESCHEDULED") {
    return { bg: "bg-orange-50", text: "text-orange-800", border: "border-orange-200" };
  }
  if (type === "HR_RECRUITER") {
    return { bg: "bg-cyan-100", text: "text-cyan-900", border: "border-cyan-300" };
  }
  return { bg: "bg-amber-100", text: "text-amber-900", border: "border-amber-300" };
}
