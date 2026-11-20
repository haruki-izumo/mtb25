"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  PRIMARY_NAV,
  SECONDARY_NAV,
  SETTINGS_NAV,
  type NavItem,
} from "@/lib/nav";

function RailButton({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  const content = (
    <span
      className={cn(
        "relative flex w-full flex-col items-center gap-1 rounded-xl px-1 py-2 text-[10px] font-medium transition-colors",
        active
          ? "bg-white text-slate-900 shadow-sm"
          : "text-slate-500 hover:bg-white/70 hover:text-slate-800",
        item.disabled && "pointer-events-none opacity-40",
      )}
    >
      <Icon className="size-5" strokeWidth={1.75} />
      <span className="leading-none">{item.label}</span>
      {item.badge ? (
        <span className="absolute top-1 right-1 rounded-full bg-red-500 px-1 text-[9px] font-semibold text-white">
          {item.badge}
        </span>
      ) : null}
    </span>
  );

  if (item.disabled) {
    return <div className="w-full px-2">{content}</div>;
  }

  return (
    <Link href={item.href} className="w-full px-2">
      {content}
    </Link>
  );
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function IconRail() {
  const pathname = usePathname();

  return (
    <aside className="fixed inset-y-0 left-0 z-40 flex w-20 flex-col bg-slate-100 py-3">
      <nav className="flex flex-1 flex-col items-center gap-0.5 overflow-y-auto">
        {PRIMARY_NAV.map((item) => (
          <RailButton
            key={item.href}
            item={item}
            active={isActive(pathname, item.href)}
          />
        ))}

        <div className="my-2 h-px w-10 bg-slate-300" />

        {SECONDARY_NAV.map((item) => (
          <RailButton
            key={item.href}
            item={item}
            active={isActive(pathname, item.href)}
          />
        ))}
      </nav>

      <div className="mt-auto pt-2">
        <RailButton
          item={SETTINGS_NAV}
          active={isActive(pathname, SETTINGS_NAV.href)}
        />
      </div>
    </aside>
  );
}
