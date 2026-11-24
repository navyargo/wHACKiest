"use client";
import { AlertOctagon, AlertTriangle, Ban, CheckCircle2, CircleDashed, Clock, FlaskConical, GitCompare, Hourglass, Info, PlayCircle, Radio, ShieldQuestion, UserCheck, UserX, Zap } from "lucide-react";
import type { ComponentType } from "react";
import { cx } from "./ui";

type Tone = "green" | "amber" | "red" | "violet" | "slate" | "teal";
const TONE: Record<Tone, string> = {
  green: "bg-emerald-50 text-emerald-800 border-emerald-200",
  amber: "bg-amber-50 text-amber-900 border-amber-200",
  red: "bg-red-50 text-red-800 border-red-200",
  violet: "bg-violet-50 text-violet-800 border-violet-200",
  slate: "bg-slate-100 text-slate-700 border-slate-200",
  teal: "bg-teal-50 text-teal-800 border-teal-200",
};

export function Pill({ tone, icon: Icon, children, className }: { tone: Tone; icon?: ComponentType<{ className?: string }>; children: React.ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium", TONE[tone], className)}>
      {Icon && <Icon className="h-3.5 w-3.5" aria-hidden />}
      {children}
    </span>
  );
}

const TASK: Record<string, [Tone, ComponentType<{ className?: string }>, string]> = {
  PROPOSED: ["slate", CircleDashed, "Proposed"],
  AWAITING_VERIFICATION: ["violet", ShieldQuestion, "Needs verification"],
  UNASSIGNED: ["red", UserX, "No owner"],
  ASSIGNED: ["amber", Hourglass, "Assigned — not accepted"],
  AWAITING_ACKNOWLEDGEMENT: ["amber", Hourglass, "Awaiting acceptance"],
  ACKNOWLEDGED: ["teal", UserCheck, "Accepted"],
  IN_PROGRESS: ["teal", PlayCircle, "In progress"],
  COMPLETED: ["green", CheckCircle2, "Completed"],
  OVERDUE: ["red", Clock, "Overdue — no record"],
  CONFLICTING: ["violet", GitCompare, "Conflicting reports"],
  ESCALATED: ["red", AlertOctagon, "Escalated"],
  REASSIGNED: ["amber", Hourglass, "Reassigned — not accepted"],
  CANCELLED: ["slate", Ban, "Cancelled"],
};
export function TaskStateBadge({ state }: { state: string }) {
  const [tone, icon, label] = TASK[state] ?? ["slate", Info, state];
  return <Pill tone={tone} icon={icon}>{label}</Pill>;
}

const LEVEL: Record<string, [Tone, ComponentType<{ className?: string }>, string]> = {
  INFORMATIONAL: ["slate", Info, "Informational"],
  LOW: ["slate", Info, "Low"],
  MEDIUM: ["amber", AlertTriangle, "Medium"],
  HIGH: ["red", AlertTriangle, "High"],
  URGENT: ["red", Zap, "Urgent coordination required"],
};
/** Operational coordination risk — never medical severity. */
export function LevelBadge({ level }: { level: string }) {
  const [tone, icon, label] = LEVEL[level] ?? ["slate", Info, level];
  return <Pill tone={tone} icon={icon}>{`Coordination risk: ${label}`}</Pill>;
}

export function SimulatedBadge({ what }: { what?: string }) {
  return <Pill tone="amber" icon={FlaskConical}>{`SIMULATED${what ? ` · ${what}` : ""}`}</Pill>;
}
export function LiveBadge({ what }: { what?: string }) {
  return <Pill tone="green" icon={Radio}>{`LIVE${what ? ` · ${what}` : ""}`}</Pill>;
}
