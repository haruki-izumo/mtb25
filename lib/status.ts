import type { LucideIcon } from "lucide-react";
import {
  Award,
  CalendarClock,
  CheckCircle2,
  CircleDashed,
  ClipboardList,
  FileQuestion,
  Flag,
  RefreshCw,
  SkipForward,
  ThumbsDown,
  XCircle,
} from "lucide-react";
import type { ProcessStatus } from "@prisma/client";

export type StatusGroupId =
  | "ALL"
  | "OFFER"
  | "UPCOMING"
  | "FOLLOW_UP"
  | "NEEDS_UPDATE"
  | "CLOSED";

export type StatusConfig = {
  status: ProcessStatus;
  label: string;
  icon: LucideIcon;
  color: string;
  group: Exclude<StatusGroupId, "ALL" | "NEEDS_UPDATE">;
};

export type StatusGroupConfig = {
  id: StatusGroupId;
  label: string;
  statuses: ProcessStatus[];
  /** Derived groups (e.g. Needs update) are computed, not stored. */
  derived?: boolean;
  color?: string;
};

export const STATUS_CONFIG: Record<ProcessStatus, StatusConfig> = {
  OFFER: {
    status: "OFFER",
    label: "Offer",
    icon: Award,
    color: "#16a34a",
    group: "OFFER",
  },
  FIRST_STEP: {
    status: "FIRST_STEP",
    label: "First step",
    icon: Flag,
    color: "#2563eb",
    group: "UPCOMING",
  },
  NEXT_ROUND: {
    status: "NEXT_ROUND",
    label: "Next round",
    icon: CalendarClock,
    color: "#0891b2",
    group: "UPCOMING",
  },
  NEXT_STEP: {
    status: "NEXT_STEP",
    label: "Next step",
    icon: CircleDashed,
    color: "#ca8a04",
    group: "FOLLOW_UP",
  },
  ASSESSMENT: {
    status: "ASSESSMENT",
    label: "Assessment",
    icon: ClipboardList,
    color: "#7c3aed",
    group: "FOLLOW_UP",
  },
  DONE: {
    status: "DONE",
    label: "Done",
    icon: CheckCircle2,
    color: "#16a34a",
    group: "FOLLOW_UP",
  },
  RESCHEDULE: {
    status: "RESCHEDULE",
    label: "Reschedule",
    icon: RefreshCw,
    color: "#ea580c",
    group: "FOLLOW_UP",
  },
  SKIPPED: {
    status: "SKIPPED",
    label: "Skipped",
    icon: SkipForward,
    color: "#6b7280",
    group: "CLOSED",
  },
  FAILED: {
    status: "FAILED",
    label: "Failed",
    icon: ThumbsDown,
    color: "#dc2626",
    group: "CLOSED",
  },
  CANCELED: {
    status: "CANCELED",
    label: "Canceled",
    icon: XCircle,
    color: "#6b7280",
    group: "CLOSED",
  },
  NOT_HANDLED: {
    status: "NOT_HANDLED",
    label: "Not handled",
    icon: FileQuestion,
    color: "#6b7280",
    group: "CLOSED",
  },
  NOT_RESCHEDULED: {
    status: "NOT_RESCHEDULED",
    label: "Not rescheduled",
    icon: CalendarClock,
    color: "#6b7280",
    group: "CLOSED",
  },
};

export const STATUS_GROUPS: StatusGroupConfig[] = [
  {
    id: "ALL",
    label: "All",
    statuses: Object.keys(STATUS_CONFIG) as ProcessStatus[],
  },
  {
    id: "OFFER",
    label: "Offer",
    statuses: ["OFFER"],
    color: "#16a34a",
  },
  {
    id: "UPCOMING",
    label: "Upcoming",
    statuses: ["FIRST_STEP", "NEXT_ROUND"],
    color: "#2563eb",
  },
  {
    id: "FOLLOW_UP",
    label: "Follow-up",
    statuses: ["NEXT_STEP", "ASSESSMENT", "DONE", "RESCHEDULE"],
    color: "#ca8a04",
  },
  {
    id: "NEEDS_UPDATE",
    label: "Needs update",
    statuses: [],
    derived: true,
    color: "#dc2626",
  },
  {
    id: "CLOSED",
    label: "Closed",
    statuses: [
      "SKIPPED",
      "FAILED",
      "CANCELED",
      "NOT_HANDLED",
      "NOT_RESCHEDULED",
    ],
    color: "#6b7280",
  },
];

export function getStatusConfig(status: ProcessStatus): StatusConfig {
  return STATUS_CONFIG[status];
}

export function getStatusesInGroup(groupId: StatusGroupId): ProcessStatus[] {
  const group = STATUS_GROUPS.find((g) => g.id === groupId);
  return group?.statuses ?? [];
}
