"use client";
import Link from "next/link";
import { use, useState } from "react";
import useSWR from "swr";
import { ArrowLeft, FileText, GitCompare, Pill as PillIcon } from "lucide-react";
import { fetcher } from "@/lib/client/api";
import { useSession, fmtDateTime, fmtTime } from "@/lib/client/session";
import { Async, Card, PageHeader } from "@/components/ui";
import { LevelBadge, Pill, TaskStateBadge } from "@/components/status";
import { TaskActions, type ActionInfo } from "@/components/TaskActions";
import { EvidenceList, type EvidenceRef } from "@/components/Evidence";
import { SourceViewer, type SourceRef } from "@/components/SourceViewer";

interface Detail {
  task: { id: string; title: string; description: string; state: string; version: number; category: string; priority: string; scheduledAt: string; windowStart: string; windowEnd: string; assigneeMemberId: string | null; assigneeName: string | null; acknowledgedAt: string | null; completedAt: string | null; completedByName: string | null; completionEvidence: { declaration?: string; note?: string } | null; nonRepeatable: boolean; requiredQualification: string | null };
  events: { id: string; type: string; fromState: string | null; toState: string | null; actorType: string; actorName: string; createdAt: string; payload: Record<string, unknown> }[];
  administrations: { id: string; status: string; recordedByName: string | null; administeredAt: string; note: string }[];
  conflicts: { id: string; kind: string; title: string; state: string; evidence: EvidenceRef[]; resolution: string | null; clinicallySignificant: boolean }[];
  alerts: { id: string; title: string; level: string; state: string; ruleId: string }[];
  messageReports: { id: string; itemType: string; payload: Record<string, unknown>; confidence: number; sourceSpan: { start: number; end: number }; message: { id: string; text: string; sentAt: string; senderName: string } | null }[];
  source: { documentId: string; title: string; span: { start: number; end: number }; extractedItemId: string } | null;
  actions: ActionInfo[];
}

export default function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { api: path, tz } = useSession();
  const swr = useSWR<Detail>(path(`/tasks/${id}`), fetcher, { refreshInterval: 15_000 });
  const [src, setSrc] = useState<SourceRef | null>(null);
  return (
    <>
      <Link href="/" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900"><ArrowLeft className="h-4 w-4" aria-hidden /> Back to Today</Link>
      <Async {...swr} retry={() => swr.mutate()}>
        {(d) => {
          const t = d.task;
          const openConflicts = d.conflicts.filter((c) => c.state === "OPEN");
          return (
            <div className="space-y-5">
              <PageHeader title={t.title} subtitle={<span className="flex flex-wrap items-center gap-2"><TaskStateBadge state={t.state} /> <span>Due {fmtDateTime(t.scheduledAt, tz)} · window {fmtTime(t.windowStart, tz)}–{fmtTime(t.windowEnd, tz)} · {t.priority.toLowerCase()} priority</span></span>} />
              <Card className="p-4">
                <dl className="grid gap-3 sm:grid-cols-3">
                  <div><dt className="text-sm text-slate-500">Owner</dt><dd className="font-medium">{t.assigneeName ?? "No owner"}</dd></div>
                  <div><dt className="text-sm text-slate-500">Accepted</dt><dd className="font-medium">{t.acknowledgedAt ? fmtDateTime(t.acknowledgedAt, tz) : "Not yet"}</dd></div>
                  <div><dt className="text-sm text-slate-500">Completed</dt><dd className="font-medium">{t.completedAt ? `${fmtDateTime(t.completedAt, tz)} by ${t.completedByName ?? "—"}` : "No record"}</dd></div>
                  {t.requiredQualification && <div><dt className="text-sm text-slate-500">Requires</dt><dd className="font-medium">{t.requiredQualification}</dd></div>}
                  {t.completionEvidence?.declaration && <div className="sm:col-span-2"><dt className="text-sm text-slate-500">Declaration</dt><dd>“{t.completionEvidence.declaration}”</dd></div>}
                </dl>
                {t.description && <p className="mt-3 text-slate-700">{t.description}</p>}
                {d.source && (
                  <button className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-teal-700 hover:underline" onClick={() => setSrc({ type: "DOCUMENT", id: d.source!.documentId, span: d.source!.span })}>
                    <FileText className="h-4 w-4" aria-hidden /> Source: {d.source.title}
                  </button>
                )}
                <div className="mt-4"><TaskActions task={{ ...t, actions: d.actions }} full /></div>
              </Card>

              {openConflicts.map((c) => (
                <Card key={c.id} className="border-violet-300 p-4">
                  <h2 className="mb-1 flex items-center gap-2 font-semibold text-violet-900"><GitCompare className="h-5 w-5" aria-hidden /> {c.title}</h2>
                  <p className="mb-3 text-sm text-violet-900">The records disagree. CareRelay does not decide which is right{c.clinicallySignificant ? " — an authorised person must verify" : ""}. Resolve it from the alert.</p>
                  <div className="grid gap-3 md:grid-cols-2">
                    {c.evidence.map((e, i) => (
                      <div key={i} className="rounded-md border border-slate-200 bg-white p-3">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Report {i + 1}</p>
                        <EvidenceList evidence={[e]} />
                      </div>
                    ))}
                  </div>
                </Card>
              ))}

              {d.administrations.length > 0 && (
                <Card className="p-4">
                  <h2 className="mb-2 font-semibold">Administration records</h2>
                  <ul className="space-y-2">{d.administrations.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center gap-2"><PillIcon className="h-4 w-4 text-slate-500" aria-hidden /> {a.recordedByName} recorded at {fmtTime(a.administeredAt, tz)} {a.note && `— “${a.note}”`} {a.status === "DISPUTED" ? <Pill tone="violet">Second record — needs verification</Pill> : <Pill tone="green">Original record</Pill>}</li>
                  ))}</ul>
                </Card>
              )}

              {d.messageReports.length > 0 && (
                <Card className="p-4">
                  <h2 className="mb-2 font-semibold">Linked messages (AI interpretation)</h2>
                  <ul className="space-y-2">{d.messageReports.map((r) => (
                    <li key={r.id} className="rounded-md bg-slate-50 p-3">
                      {r.message ? <p>“{r.message.text}” — {r.message.senderName}, {fmtTime(r.message.sentAt, tz)}</p> : <p className="text-slate-500">Message hidden for your role</p>}
                      <p className="text-sm text-slate-600">Read as {r.itemType.replace(/_/g, " ").toLowerCase()}{r.payload.claim ? `: ${String(r.payload.claim).replace("_", " ").toLowerCase()}` : ""} ({Math.round(r.confidence * 100)}% confidence)</p>
                    </li>
                  ))}</ul>
                </Card>
              )}

              {d.alerts.length > 0 && (
                <Card className="p-4">
                  <h2 className="mb-2 font-semibold">Alerts about this task</h2>
                  <ul className="space-y-1">{d.alerts.map((a) => <li key={a.id} className="flex flex-wrap items-center gap-2"><LevelBadge level={a.level} /><Link className="text-teal-800 hover:underline" href={`/alerts?id=${a.id}`}>{a.title}</Link><span className="text-sm text-slate-500">{a.ruleId} · {a.state.toLowerCase()}</span></li>)}</ul>
                </Card>
              )}

              <Card className="p-4">
                <h2 className="mb-3 font-semibold">History</h2>
                <ol className="relative ml-2 border-l border-slate-200">
                  {d.events.map((e) => (
                    <li key={e.id} className="mb-3 ml-4">
                      <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border border-white bg-teal-600" aria-hidden />
                      <p className="text-[15px] text-slate-900"><strong>{e.type.replace(/_/g, " ").toLowerCase()}</strong>{e.toState && e.fromState !== e.toState ? ` → ${e.toState.replace(/_/g, " ").toLowerCase()}` : ""}{e.payload.targetName ? ` (${String(e.payload.targetName)})` : ""}</p>
                      <p className="text-sm text-slate-600">{e.actorName} · {e.actorType.toLowerCase()} · {fmtDateTime(e.createdAt, tz)}</p>
                      {["reason", "declaration", "note", "claim"].map((k) => (e.payload[k] ? <p key={k} className="text-sm text-slate-700">{k}: “{String(e.payload[k])}”</p> : null))}
                    </li>
                  ))}
                </ol>
              </Card>
            </div>
          );
        }}
      </Async>
      <SourceViewer source={src} onClose={() => setSrc(null)} />
    </>
  );
}
