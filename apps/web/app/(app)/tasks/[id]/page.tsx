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
      <Link href="/" className="mb-3 inline-flex min-h-[44px] items-center gap-1.5 text-sm font-medium text-slate-700 hover:text-slate-900 focus-visible:outline-teal-700">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Back to Today
      </Link>
      <Async {...swr} retry={() => swr.mutate()}>
        {(d) => {
          const t = d.task;
          const openConflicts = d.conflicts.filter((c) => c.state === "OPEN");
          const isOverdue = t.state === "OVERDUE";
          return (
            <div className="space-y-5">
              <PageHeader title={t.title} subtitle={<span className="flex flex-wrap items-center gap-2"><TaskStateBadge state={t.state} /> <span>Due {fmtDateTime(t.scheduledAt, tz)} · window {fmtTime(t.windowStart, tz)}–{fmtTime(t.windowEnd, tz)} · {t.priority.toLowerCase()} priority</span></span>} />
              {isOverdue && (
                <div role="alert" aria-live="assertive" className="sr-only">
                  Critical alert: Task {t.title} is overdue with no record.
                </div>
              )}
              <Card className="p-4" role="region" aria-labelledby="task-overview-heading">
                <h2 id="task-overview-heading" className="sr-only">Task Overview</h2>
                <dl className="grid gap-3 sm:grid-cols-3">
                  <div><dt className="text-sm font-medium text-slate-700">Owner</dt><dd className="font-semibold text-slate-900">{t.assigneeName ?? "No owner"}</dd></div>
                  <div><dt className="text-sm font-medium text-slate-700">Accepted</dt><dd className="font-semibold text-slate-900">{t.acknowledgedAt ? fmtDateTime(t.acknowledgedAt, tz) : "Not yet"}</dd></div>
                  <div><dt className="text-sm font-medium text-slate-700">Completed</dt><dd className="font-semibold text-slate-900">{t.completedAt ? `${fmtDateTime(t.completedAt, tz)} by ${t.completedByName ?? "—"}` : "No record"}</dd></div>
                  {t.requiredQualification && <div><dt className="text-sm font-medium text-slate-700">Requires</dt><dd className="font-semibold text-slate-900">{t.requiredQualification}</dd></div>}
                  {t.completionEvidence?.declaration && <div className="sm:col-span-2"><dt className="text-sm font-medium text-slate-700">Declaration</dt><dd className="text-slate-900 font-medium">“{t.completionEvidence.declaration}”</dd></div>}
                </dl>
                {t.description && <p className="mt-3 text-slate-800">{t.description}</p>}
                {d.source && (
                  <button className="mt-3 inline-flex min-h-[44px] items-center gap-1.5 text-sm font-semibold text-teal-800 hover:underline focus-visible:outline-teal-700" onClick={() => setSrc({ type: "DOCUMENT", id: d.source!.documentId, span: d.source!.span })}>
                    <FileText className="h-4 w-4" aria-hidden /> Source: {d.source.title}
                  </button>
                )}
                <div className="mt-4"><TaskActions task={{ ...t, actions: d.actions }} full /></div>
              </Card>

              {openConflicts.map((c) => (
                <Card key={c.id} role="alert" aria-live="assertive" className="border-violet-300 bg-violet-50/20 p-4">
                  <h2 className="mb-1 flex items-center gap-2 font-semibold text-violet-950"><GitCompare className="h-5 w-5 text-violet-800" aria-hidden /> {c.title}</h2>
                  <p className="mb-3 text-sm text-violet-950 font-medium">The records disagree. CareRelay does not decide which is right{c.clinicallySignificant ? " — an authorised person must verify" : ""}. Resolve it from the alert.</p>
                  <div className="grid gap-3 md:grid-cols-2">
                    {c.evidence.map((e, i) => (
                      <div key={i} className="rounded-md border border-slate-200 bg-white p-3">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-700">Report {i + 1}</p>
                        <EvidenceList evidence={[e]} />
                      </div>
                    ))}
                  </div>
                </Card>
              ))}

              {d.administrations.length > 0 && (
                <Card className="p-4" role="region" aria-labelledby="admin-records-heading">
                  <h2 id="admin-records-heading" className="mb-2 font-semibold text-slate-900">Administration records</h2>
                  <ul className="space-y-2">
                    {d.administrations.map((a) => (
                      <li key={a.id} className="flex min-h-[44px] flex-wrap items-center gap-2 text-slate-900">
                        <PillIcon className="h-4 w-4 text-slate-600" aria-hidden />
                        <span>{a.recordedByName} recorded at {fmtTime(a.administeredAt, tz)} {a.note && `— “${a.note}”`}</span>
                        {a.status === "DISPUTED" ? (
                          <>
                            <span role="alert" aria-live="assertive" className="sr-only">Disputed second record: needs verification</span>
                            <Pill tone="violet">Second record — needs verification</Pill>
                          </>
                        ) : (
                          <Pill tone="green">Original record</Pill>
                        )}
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              {d.messageReports.length > 0 && (
                <Card className="p-4" role="region" aria-labelledby="linked-messages-heading">
                  <h2 id="linked-messages-heading" className="mb-2 font-semibold text-slate-900">Linked messages (AI interpretation)</h2>
                  <ul className="space-y-2">{d.messageReports.map((r) => (
                    <li key={r.id} className="rounded-md bg-slate-50 p-3">
                      {r.message ? <p className="text-slate-900 font-medium">“{r.message.text}” — {r.message.senderName}, {fmtTime(r.message.sentAt, tz)}</p> : <p className="text-slate-600">Message hidden for your role</p>}
                      <p className="text-sm text-slate-700 font-medium">Read as {r.itemType.replace(/_/g, " ").toLowerCase()}{r.payload.claim ? `: ${String(r.payload.claim).replace("_", " ").toLowerCase()}` : ""} ({Math.round(r.confidence * 100)}% confidence)</p>
                    </li>
                  ))}</ul>
                </Card>
              )}

              {d.alerts.length > 0 && (
                <Card className="p-4" role="region" aria-labelledby="task-alerts-heading">
                  <h2 id="task-alerts-heading" className="mb-2 font-semibold text-slate-900">Alerts about this task</h2>
                  <ul className="space-y-1">{d.alerts.map((a) => <li key={a.id} className="flex min-h-[44px] flex-wrap items-center gap-2"><LevelBadge level={a.level} /><Link className="font-semibold text-teal-900 hover:underline focus-visible:outline-teal-700" href={`/alerts?id=${a.id}`}>{a.title}</Link><span className="text-sm text-slate-700">{a.ruleId} · {a.state.toLowerCase()}</span></li>)}</ul>
                </Card>
              )}

              <Card className="p-4" role="region" aria-labelledby="history-heading">
                <h2 id="history-heading" className="mb-3 font-semibold text-slate-900">History</h2>
                <ol className="relative ml-2 border-l border-slate-200">
                  {d.events.map((e) => (
                    <li key={e.id} className="mb-3 ml-4">
                      <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border border-white bg-teal-700" aria-hidden />
                      <p className="text-[15px] text-slate-900"><strong>{e.type.replace(/_/g, " ").toLowerCase()}</strong>{e.toState && e.fromState !== e.toState ? ` → ${e.toState.replace(/_/g, " ").toLowerCase()}` : ""}{e.payload.targetName ? ` (${String(e.payload.targetName)})` : ""}</p>
                      <p className="text-sm text-slate-700">{e.actorName} · {e.actorType.toLowerCase()} · {fmtDateTime(e.createdAt, tz)}</p>
                      {["reason", "declaration", "note", "claim"].map((k) => (e.payload[k] ? <p key={k} className="text-sm font-medium text-slate-800">{k}: “{String(e.payload[k])}”</p> : null))}
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
