"use client";
import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/client/api";
import { useSession, fmtDateTime } from "@/lib/client/session";
import { Async, Card, EmptyState, PageHeader, cx } from "@/components/ui";
import { Pill } from "@/components/status";

interface Entry { id: string; at: string; kind: string; title: string; detail: string; actorName: string; origin: string; via: string | null; link: string | null }
const KINDS = ["", "task", "alert", "conflict", "document", "message", "approval", "handover", "observation", "inventory", "ai", "mcp", "member"];

export default function TimelinePage() {
  const { api: path, tz, can } = useSession();
  const [kind, setKind] = useState("");
  const swr = useSWR<{ entries: Entry[] }>(path(`/timeline${kind ? `?kind=${kind}` : ""}`), fetcher, { refreshInterval: 30_000 });
  return (
    <>
      <PageHeader title="Timeline" subtitle="Everything that happened, who did it, and where it came from (person, system rule, or AI agent via MCP)." />
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter">
        {KINDS.filter((k) => k !== "message" || can("view_messages")).map((k) => (
          <button key={k || "all"} onClick={() => setKind(k)} aria-pressed={kind === k} className={cx("rounded-full border px-3 py-1 text-sm", kind === k ? "border-teal-700 bg-teal-700 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50")}>{k || "all"}</button>
        ))}
      </div>
      <Async {...swr} retry={() => swr.mutate()} empty={(d) => (d.entries.length ? null : <EmptyState title="Nothing here yet" />)}>
        {(d) => (
          <Card className="divide-y divide-slate-100">
            {d.entries.map((e) => (
              <div key={e.id} className="flex flex-wrap gap-3 p-3">
                <span className="w-28 shrink-0 text-sm text-slate-500">{fmtDateTime(e.at, tz)}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] text-slate-900">{e.link ? <Link className="hover:underline" href={e.link}>{e.title}</Link> : e.title}</p>
                  {e.detail && <p className="line-clamp-2 text-sm text-slate-600">{e.detail}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <Pill tone="slate">{e.kind}</Pill>
                  <Pill tone={e.origin === "AGENT" ? "violet" : e.origin === "SYSTEM" ? "amber" : "teal"}>{e.origin === "AGENT" ? "AI agent" : e.origin === "SYSTEM" ? "system" : "person"}{e.via === "SIMULATED" ? " · simulated" : ""}</Pill>
                  <span className="text-sm text-slate-600">{e.actorName}</span>
                </div>
              </div>
            ))}
          </Card>
        )}
      </Async>
    </>
  );
}
