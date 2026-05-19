"use client";
import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { Ic, IcName } from "./Ic";
import { useApp } from "@/lib/i18n";

type NavItem =
  | { type: "group"; title: string }
  | { type: "item"; id: string; icon: IcName; label: string; count?: string; href: string };

export function LeftNav() {
  const { t } = useApp();
  const pathname = usePathname();

  const items: NavItem[] = [
    { type: "group", title: t("nav_group_operate") },
    { type: "item", id: "overview",   icon: "grid",     label: t("nav_overview"), href: "/" },
    { type: "item", id: "fleet",      icon: "cpu",      label: t("nav_fleet"), count: "14", href: "/fleet" },
    { type: "item", id: "runs",       icon: "play",     label: t("nav_runs"),  count: "312", href: "/live" },
    { type: "item", id: "alerts",     icon: "alert",    label: t("nav_alerts"),count: "3", href: "/alerts" },
    { type: "group", title: t("nav_group_build") },
    { type: "item", id: "workflows",  icon: "workflow", label: t("nav_workflows"), count: "9", href: "/workflow" },
    { type: "item", id: "triggers",   icon: "bolt",     label: t("nav_triggers"), href: "/events" },
    { type: "item", id: "integrations", icon: "plug",   label: t("nav_integrations"), href: "/datasources" },
    { type: "group", title: t("nav_group_govern") },
    { type: "item", id: "permissions",icon: "key",      label: t("nav_permissions"), href: "#" },
    { type: "item", id: "audit",      icon: "book",     label: t("nav_audit"), href: "#" },
    { type: "item", id: "compliance", icon: "shield",   label: t("nav_compliance"), href: "#" },
    { type: "group", title: t("nav_group_trust_yy") },
    { type: "item", id: "rule-check-yy", icon: "shield",   label: t("nav_rule_check_yy"), href: "/rule-check-yy" },
  ];

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname === href || pathname.startsWith(href + "/");
  };

  return (
    <nav
      className="w-[184px] flex-none border-r border-line bg-surface flex flex-col gap-[2px] text-[12.5px]"
      style={{ padding: "10px 8px" }}
    >
      {items.map((it, i) => {
        if (it.type === "group") {
          return (
            <div
              key={i}
              className="text-[10.5px] tracking-[0.06em] uppercase text-ink-4 font-semibold"
              style={{ padding: "10px 8px 4px" }}
            >
              {it.title}
            </div>
          );
        }
        const Icon = Ic[it.icon];
        const active = isActive(it.href);
        return (
          <Link
            key={it.id}
            href={it.href}
            className={clsx(
              "flex items-center gap-[9px] px-2 py-[6px] rounded-md cursor-pointer no-underline",
              active ? "bg-accent-bg text-[color:var(--c-accent)] font-medium" : "text-ink-2 hover:bg-panel hover:text-ink-1"
            )}
          >
            <span className="w-[14px] inline-flex"><Icon /></span>
            <span>{it.label}</span>
            {it.count && (
              <span
                className={clsx(
                  "ml-auto mono text-[10.5px]",
                  active ? "text-[color:var(--c-accent)]" : "text-ink-4"
                )}
              >
                {it.count}
              </span>
            )}
          </Link>
        );
      })}
      <div className="flex-1" />
      <div className="flex items-center gap-[9px] px-2 py-[6px] rounded-md cursor-pointer text-ink-2 hover:bg-panel hover:text-ink-1">
        <Ic.gear />
        <span>{t("nav_settings")}</span>
      </div>
    </nav>
  );
}
