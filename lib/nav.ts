import type { LucideIcon } from "lucide-react";
import {
  Calendar,
  CalendarDays,
  ClipboardList,
  FolderKanban,
  Home,
  Settings,
  Users,
  UserRound,
  Briefcase,
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
  { href: "/projects", label: "Projects", icon: FolderKanban },
];

export const SECONDARY_NAV: NavItem[] = [
  { href: "/profiles", label: "Profile", icon: UserRound },
  { href: "/team", label: "My Team", icon: Users },
];

export const SETTINGS_NAV: NavItem = {
  href: "/settings",
  label: "Settings",
  icon: Settings,
};
