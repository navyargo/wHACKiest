"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import useSWR from "swr";
import { Bell, Bot, ClipboardList, FileText, Home, MessageSquare, Package, ShieldCheck, Siren, Users, History, LogOut, Phone, FlaskConical } from "lucide-react";
import { api, fetcher } from "@/lib/client/api";
import { useSession, fmtDateTime } from "@/lib/client/session";
import { cx, Button } from "./ui";
import { LiveBadge, Pill } from "./status";
import { DemoBar } from "./DemoBar";

const NAV = [
  { href: "/", label: "Today", icon: Home, perm: "view_patient", mobile: true },
  { href: "/alerts", label: "Alerts & gaps", icon: Siren, perm: "view_patient", mobile: true },
  { href: "/handover", label: "Handover", icon: ClipboardList, perm: "record_care", mobile: true },
  { href: "/documents", label: "Documents", icon: FileText, perm: "view_documents" },
  { href: "/messages", label: "Messages", icon: MessageSquare, perm: "view_messages" },
  { href: "/inventory", label: "Inventory", icon: Package, perm: "view_patient" },
  { href: "/approvals", label: "Approvals", icon: ShieldCheck, perm: "view_patient" },
  { href: "/timeline", label: "Timeline", icon: History, perm: "view_patient" },
  { href: "/circle", label: "Care circle", icon: Users, perm: "view_patient" },
  { href: "/assistant", label: "Assistant & MCP", icon: Bot, perm: "use_assistant", mobile: true },
];

export const SAFETY_NOTICE = "CareRelay is not an emergency or medical monitoring service. In an emergency, call your local emergency number (112 in India).";

export function Shell({ children }: { children: ReactNode }) {
  const { me, patient, can, api: path, setPatientId } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const nav = NAV.filter((n) => can(n.perm));
  const counts = useSWR<{ alerts: { id: string }[] }>(path("/alerts"), fetcher, { refreshInterval: 20_000 });
  const approvals = useSWR<{ approvals: { canDecide: boolean }[] }>(path("/approvals?state=PENDING"), fetcher, { refreshInterval: 20_000 });
  const notes = useSWR<{ notifications: { id: string; title: string; body: string; readAt: string | null; createdAt: string; channel: string; alertId: string | null; taskId: string | null }[] }>(path("/notifications"), fetcher, { refreshInterval: 20_000 });
  const [showNotes, setShowNotes] = useState(false);
  const notesRef = useRef<HTMLDivElement>(null);
  const bellButtonRef = useRef<HTMLButtonElement>(null);

  const badge = (href: string) => (href === "/alerts" ? counts.data?.alerts.length : href === "/approvals" ? approvals.data?.approvals.filter((a) => a.canDecide).length : undefined);
  const unread = notes.data?.notifications.filter((n) => !n.readAt).length ?? 0;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && showNotes) {
        setShowNotes(false);
        bellButtonRef.current?.focus();
      }
    }
    if (showNotes) {
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }
  }, [showNotes]);

  return (
    <div className="min-h-screen pb-24 md:pb-12 md:pl-60">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-md focus:bg-teal-900 focus:px-4 focus:py-2.5 focus:text-sm focus:font-semibold focus:text-white focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-teal-900">
        Skip to main content
      </a>

      {/* Sidebar (desktop) */}
      <aside aria-label="Sidebar navigation" className="fixed inset-y-0 left-0 z-20 hidden w-60 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="border-b border-slate-200 px-5 py-4">
          <p className="text-lg font-semibold text-teal-900">CareRelay</p>
          <p className="text-xs text-slate-600">No missed care · No ambiguous responsibility</p>
        </div>
        <nav aria-label="Main navigation" className="flex-1 overflow-y-auto p-2">
          {nav.map((n) => {
            const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
            const b = badge(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "mb-0.5 flex min-h-[44px] items-center gap-3 rounded-md px-3 py-2 text-[15px] transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-700",
                  active ? "bg-teal-50 font-semibold text-teal-950" : "text-slate-800 hover:bg-slate-100",
                )}
              >
                <n.icon className="h-5 w-5 shrink-0" aria-hidden />
                <span className="flex-1">{n.label}</span>
                {!!b && <span className="rounded-full bg-red-700 px-2 py-0.5 text-xs font-semibold text-white" aria-label={`${b} pending`}>{b}</span>}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-slate-200 p-3 text-sm">
          <p className="font-semibold text-slate-900">{me.user.name}</p>
          <p className="text-slate-600">{patient.role.replace(/_/g, " ").toLowerCase()}</p>
          <button
            className="mt-2 inline-flex min-h-[44px] items-center gap-1.5 text-slate-700 hover:text-slate-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-700"
            onClick={async () => { await api("POST", "/api/auth/logout", undefined, { revalidate: false }); router.push("/login"); }}
          >
            <LogOut className="h-4 w-4" aria-hidden /> Sign out
          </button>
        </div>
      </aside>

      {/* Header */}
      <header role="banner" className="sticky top-0 z-10 border-b border-slate-200 bg-white/95">
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 md:px-6">
          <span className="font-semibold text-teal-900 md:hidden">CareRelay</span>
          {me.patients.length > 1 ? (
            <select aria-label="Select active patient" className="min-h-[44px] rounded border border-slate-300 px-2 py-1 text-sm text-slate-900 focus-visible:outline-teal-700" value={patient.id} onChange={(e) => setPatientId(e.target.value)}>
              {me.patients.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
            </select>
          ) : (
            <span className="text-sm text-slate-800">Caring for <strong>{patient.displayName}</strong> ({patient.age})</span>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {me.ai.mode === "LIVE" ? <LiveBadge what={me.ai.label.replace(" (LIVE)", "")} /> : <Pill tone="slate" icon={FlaskConical}>{me.ai.label}</Pill>}
            {me.voiceEnabled && <LiveBadge what="ElevenLabs voice" />}
            <div className="relative">
              <Button
                ref={bellButtonRef}
                size="sm"
                variant="ghost"
                aria-haspopup="dialog"
                aria-expanded={showNotes}
                aria-label={`Notifications, ${unread} unread`}
                onClick={() => setShowNotes((s) => !s)}
              >
                <Bell className="h-5 w-5" aria-hidden />
                {unread > 0 && <span className="rounded-full bg-red-700 px-1.5 text-xs font-semibold text-white">{unread}</span>}
              </Button>
              {showNotes && (
                <div
                  ref={notesRef}
                  role="dialog"
                  aria-modal="true"
                  aria-label="Notifications panel"
                  className="absolute right-0 z-30 mt-2 max-h-[70vh] w-[22rem] overflow-y-auto rounded-lg border border-slate-200 bg-white p-2 shadow-lg"
                >
                  <div className="flex items-center justify-between border-b border-slate-100 px-2 py-1">
                    <p className="text-xs font-semibold text-slate-700">Notifications ({unread} unread)</p>
                    <button
                      className="rounded p-1 text-xs text-slate-600 hover:bg-slate-100"
                      onClick={() => setShowNotes(false)}
                      aria-label="Close notifications"
                    >
                      Close
                    </button>
                  </div>
                  <p className="px-2 py-1 text-xs text-slate-600">Opening a notification marks it read only.</p>
                  {(notes.data?.notifications ?? []).length === 0 && <p className="p-3 text-sm text-slate-700">No notifications.</p>}
                  {notes.data?.notifications.map((n) => (
                    <button
                      key={n.id}
                      className={cx("block w-full min-h-[44px] rounded-md p-2 text-left text-sm hover:bg-slate-50 focus-visible:outline-teal-700", !n.readAt && "bg-teal-50/70")}
                      onClick={async () => {
                        if (!n.readAt) await api("POST", path(`/notifications/${n.id}/read`));
                        setShowNotes(false);
                        router.push(n.alertId ? `/alerts?id=${n.alertId}` : n.taskId ? `/tasks/${n.taskId}` : "/handover");
                      }}
                    >
                      <p className="font-semibold text-slate-900">{n.channel === "VOICE_ELEVENLABS" && <Phone className="mr-1 inline h-3.5 w-3.5" aria-label="Voice notification" />}{n.title}</p>
                      <p className="line-clamp-2 text-slate-700">{n.body}</p>
                      <p className="mt-0.5 text-xs text-slate-600">Delivered {fmtDateTime(n.createdAt, patient.timezone)}{n.readAt ? " · read" : ""}</p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        {me.demoMode && <DemoBar />}
        <p className="bg-amber-100 px-4 py-1 text-center text-xs font-medium text-amber-950 md:px-6">Synthetic demo data — not medical guidance.</p>
      </header>

      <main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-6 md:px-6 focus:outline-none">{children}</main>

      <footer className="fixed inset-x-0 bottom-16 z-10 border-t border-slate-200 bg-white px-4 py-2 text-center text-xs text-slate-800 md:bottom-0 md:left-60" role="contentinfo">
        {SAFETY_NOTICE}
      </footer>

      {/* Bottom nav (mobile) */}
      <nav aria-label="Mobile navigation" className="fixed inset-x-0 bottom-0 z-20 flex h-16 border-t border-slate-200 bg-white md:hidden">
        {nav.filter((n) => n.mobile).map((n) => {
          const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
          return (
            <Link
              key={n.href}
              href={n.href}
              aria-current={active ? "page" : undefined}
              className={cx("flex flex-1 flex-col items-center justify-center gap-0.5 text-xs min-h-[44px]", active ? "font-semibold text-teal-900" : "text-slate-700")}
            >
              <n.icon className="h-5 w-5" aria-hidden />
              <span>{n.label.split(" ")[0]}</span>
            </Link>
          );
        })}
        <Link href="/more" className={cx("flex flex-1 flex-col items-center justify-center gap-0.5 text-xs min-h-[44px]", pathname === "/more" ? "font-semibold text-teal-900" : "text-slate-700")}>
          <Users className="h-5 w-5" aria-hidden />
          <span>More</span>
        </Link>
      </nav>
    </div>
  );
}

export function MoreLinks() {
  const { can } = useSession();
  return (
    <ul className="space-y-2">
      {NAV.filter((n) => can(n.perm)).map((n) => (
        <li key={n.href}>
          <Link href={n.href} className="flex min-h-[44px] items-center gap-3 rounded-lg border border-slate-200 bg-white p-3 text-slate-900 hover:border-teal-700">
            <n.icon className="h-5 w-5 shrink-0" aria-hidden />
            <span className="font-medium">{n.label}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
