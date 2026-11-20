import type { LucideIcon } from "lucide-react";
import {
  Calendar,
  CalendarDays,
  ClipboardList,
  FileText,
  Home,
  MessageSquare,
  MoreHorizontal,
  Settings,
  Users,
  UserRound,
  Briefcase,
  CheckSquare,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: string;
  disabled?: boolean;
};

export const PRIMARY_NAV: NavItem[] = [
  { href: "/", label: "Home", icon: Home },
  { href: "/meetings", label: "Meetings", icon: CalendarDays },
  { href: "/availability", label: "Availability", icon: Calendar },
  { href: "/interviews", label: "Interview", icon: Briefcase },
  { href: "/applications", label: "Application", icon: ClipboardList, disabled: true },
  { href: "/chat", label: "Chat", icon: MessageSquare, disabled: true },
  { href: "/todo", label: "To Do", icon: CheckSquare, disabled: true },
  { href: "/resumes", label: "Resume", icon: FileText, disabled: true },
];

export const SECONDARY_NAV: NavItem[] = [
  { href: "/profiles", label: "Profile", icon: UserRound },
  { href: "/team", label: "My Team", icon: Users },
  { href: "/more", label: "More", icon: MoreHorizontal, disabled: true },
];

export const SETTINGS_NAV: NavItem = {
  href: "/settings",
  label: "Settings",
  icon: Settings,
};
