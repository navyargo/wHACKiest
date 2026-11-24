"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import useSWR from "swr";
import { Bot, BellRing, CheckCheck, Cpu, Scale, Volume2 } from "lucide-react";
import { api, errorMessage, fetcher } from "@/lib/client/api";
import { useSession, fmtDateTime } from "@/lib/client/session";
import { Async, Button, Card, Drawer, EmptyState, Field, PageHeader, inputCls, useToast, cx } from "@/components/ui";
import { LevelBadge, Pill, TaskStateBadge } from "@/components/status";
import { EvidenceList, type EvidenceRef } from "@/components/Evidence";
import { TaskActions, type TaskLite } from "@/components/TaskActions";

interface Alert { id: string; ruleId: string; level: string; title: string; explanation: string; state: string; detectedAt: string; escalationStep: number; version: number; affectedTaskId: string | null; resolution: string | null; resolvedAt: string | null; basis: { kind: "RULE" | "AI"; ruleId: string; description: string; confidence?: number; provider?: string }; evidence: EvidenceRef[]; resolutionOptions: { action: string; label: string; targetId?: string }[] }
interface AlertDetail extends Alert { task: { id: string; title: string; state: string } | null; conflict: { id: string; state: string; dedupeKey: string; clinicallySignificant: boolean; resolution: string | null } | null; responderDetails: { memberId: string; name: string; role: string | null }[] }

export default function AlertsPage() {
  return <Suspense><Alerts /></Suspense>;
}

function Alerts() {
  const { api: path } = useSession();
  const params = useSearchParams();
  const router = useRouter();
  const [state, setState] = useState<"open" | "resolved">("open");
  const list = useSWR<{ alerts: Alert[] }>(path(`/alerts?state=${state}`), fetcher, { refreshInterval: 15_000 });
  const openId = params.get("id");
  return (
    <>
      <PageHeader title="Alerts & gaps" subtitle="Coordination risks found by deterministic rules and AI semantic analysis. Levels describe coordination risk, not medical severity." />
      <div className="mb-4 flex gap-2" role="tablist" aria-label="Alert state">
        {(["open", "resolved"] as const).map((s) => (
          <Button key={s} role="tab" aria-selected={state === s} size="sm" variant={state === s ? "primary" : "secondary"} onClick={() => setState(s)}>{s === "open" ? "Open" : "Resolved"}</Button>
        ))}
      </div>
      <Async {...list} retry={() => list.mutate()} empty={(d) => (d.alerts.length ? null : <EmptyState title={state === "open" ? "No open alerts" : "No resolved alerts yet"}>{state === "open" ? "The care sweep checks every minute." : undefined}</EmptyState>)}>
        {(d) => (
          <ul className="space-y-2">
            {d.alerts.map((a) => (
              <li key={a.id}>
                <button onClick={() => router.push(`/alerts?id=${a.id}`)} className="w-full text-left">
                  <Card className={cx("p-4 transition-colors duration-150 hover:border-teal-600", a.level === "URGENT" && "border-l-4 border-l-red-600")}>
                    <div className="flex flex-wrap items-center gap-2">
                      <LevelBadge level={a.level} />
                      <Pill tone={a.basis.kind === "AI" ? "violet" : "slate"} icon={a.basis.kind === "AI" ? Cpu : Scale}>{a.basis.kind === "AI" ? `AI · ${a.ruleId}` : a.ruleId}</Pill>
                      {a.state === "ESCALATED" && <Pill tone="red" icon={BellRing}>Escalated (step {a.escalationStep})</Pill>}
                      {a.state === "ACKNOWLEDGED" && <Pill tone="teal" icon={CheckCheck}>Someone is on it</Pill>}
                    </div>
                    <p className="mt-2 font-medium text-slate-900">{a.title}</p>
                    <p className="mt-1 line-clamp-2 text-slate-600">{a.state === "RESOLVED" ? a.resolution : a.explanation}</p>
                  </Card>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Async>
      <Drawer open={!!openId} onOpenChange={(o) => !o && router.push("/alerts")} title="Alert details">
        {openId && <AlertDetailView id={openId} />}
      </Drawer>
    </>
  );
}

function AlertDetailView({ id }: { id: string }) {
  const { api: path, tz, can, me } = useSession();
  const swr = useSWR<AlertDetail>(path(`/alerts/${id}`), fetcher);
  const task = useSWR<{ task: TaskLite & { title: string }; actions: TaskLite["actions"] }>(swr.data?.affectedTaskId ? path(`/tasks/${swr.data.affectedTaskId}`) : null, fetcher);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<{ message: string; proposals: { approvalRequestId: string }[]; toolCalls: { tool: string; ok: boolean; durationMs: number }[] } | null>(null);
  const [resolving, setResolving] = useState(false);

  async function act(label: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(label);
    try {
      const r = await fn();
      toast("success", ok);
      return r;
    } catch (e) {
      toast("error", errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Async {...swr} retry={() => swr.mutate()}>
      {(a) => (
        <div className="space-y-6">
          <section>
            <div className="flex flex-wrap gap-2"><LevelBadge level={a.level} />{a.state !== "OPEN" && <Pill tone={a.state === "RESOLVED" ? "green" : "amber"}>{a.state.toLowerCase()}</Pill>}</div>
            <h3 className="mt-2 text-xl font-semibold text-slate-900">{a.title}</h3>
            <p className="mt-1 text-sm text-slate-500">Detected {fmtDateTime(a.detectedAt, tz)}{a.escalationStep ? ` · escalation step ${a.escalationStep}` : ""}</p>
          </section>
          <section aria-labelledby="what"><h4 id="what" className="mb-1 font-semibold text-slate-900">What was detected</h4><p className="text-slate-700">{a.explanation}</p>{a.resolution && <p className="mt-2 rounded-md bg-emerald-50 p-2 text-emerald-900">{a.resolution}</p>}</section>
          <section aria-labelledby="why">
            <h4 id="why" className="mb-1 font-semibold text-slate-900">Why</h4>
            {a.basis.kind === "RULE" ? (
              <p className="text-slate-700"><strong>Rule {a.basis.ruleId}</strong>: {a.basis.description}</p>
            ) : (
              <p className="text-slate-700"><strong>AI semantic analysis</strong> ({Math.round((a.basis.confidence ?? 0) * 100)}% confidence, {a.basis.provider}). {a.basis.description} The AI only proposes; the alert itself is raised by deterministic code at ≥ 70% confidence.</p>
            )}
          </section>
          <section aria-labelledby="ev"><h4 id="ev" className="mb-2 font-semibold text-slate-900">Evidence</h4><EvidenceList evidence={a.evidence} /></section>
          {a.task && (
            <section aria-labelledby="resp">
              <h4 id="resp" className="mb-1 font-semibold text-slate-900">Affected responsibility</h4>
              <div className="flex flex-wrap items-center gap-2"><Link href={`/tasks/${a.task.id}`} className="font-medium text-teal-800 underline-offset-2 hover:underline">{a.task.title}</Link><TaskStateBadge state={a.task.state} /></div>
            </section>
          )}
          <section aria-labelledby="who">
            <h4 id="who" className="mb-1 font-semibold text-slate-900">Who needs to respond</h4>
            <ul className="flex flex-wrap gap-2">{a.responderDetails.map((r) => <li key={r.memberId}><Pill tone="slate">{r.name}{r.role ? ` · ${r.role.replace(/_/g, " ").toLowerCase()}` : ""}</Pill></li>)}</ul>
          </section>
          {a.state !== "RESOLVED" && (
            <section aria-labelledby="opts" className="rounded-lg border border-slate-200 p-4">
              <h4 id="opts" className="mb-3 font-semibold text-slate-900">Resolution options</h4>
              <div className="space-y-3">
                {task.data && a.resolutionOptions.some((o) => ["ASSIGN", "REASSIGN", "CLAIM", "ACKNOWLEDGE_TASK", "COMPLETE_TASK"].includes(o.action)) && (
                  <TaskActions task={{ ...task.data.task, actions: task.data.actions }} />
                )}
                <div className="flex flex-wrap gap-2">
                  {a.resolutionOptions.map((o) => {
                    switch (o.action) {
                      case "NUDGE_ASSIGNEE":
                        return <Button key={o.action} size="sm" loading={busy === o.action} onClick={() => act(o.action, () => api("POST", path(`/tasks/${o.targetId}/nudge`)), "Reminder sent")}><BellRing className="h-4 w-4" aria-hidden />{o.label}</Button>;
                      case "COVERAGE_AGENT":
                        return <Button key={o.action} size="sm" loading={busy === o.action} disabledReason={can("manage_tasks") ? null : "Only coordinators can run the Coverage Agent"} onClick={async () => { const r = await act(o.action, () => api("POST", path(`/alerts/${a.id}/coverage-agent`)), "Coverage Agent finished"); if (r) setCoverage(r as typeof coverage); }}><Bot className="h-4 w-4" aria-hidden />{o.label}</Button>;
                      case "RESOLVE_CONFLICT":
                        return <Button key={o.action} size="sm" variant="primary" disabledReason={can("resolve_conflicts") ? null : "Requires the resolve_conflicts permission"} onClick={() => setResolving(true)}>{o.label}</Button>;
                      case "CONFIRM_ITEM":
                        return <Button key={o.action} size="sm" variant="primary" loading={busy === o.action} onClick={() => act(o.action, () => api("POST", path(`/extracted/${o.targetId}/confirm`)), "Confirmed")}>{o.label}</Button>;
                      case "REJECT_ITEM":
                        return <Button key={o.action} size="sm" loading={busy === o.action} onClick={() => { const reason = prompt("Why is this not a hand-off?"); if (reason) void act(o.action, () => api("POST", path(`/extracted/${o.targetId}/reject`), { reason }), "Dismissed"); }}>{o.label}</Button>;
                      case "OPEN_TASK": return <Link key={o.action} className="inline-flex items-center rounded-md border border-slate-300 px-2.5 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50" href={`/tasks/${o.targetId}`}>{o.label}</Link>;
                      case "OPEN_DOCUMENT": return <Link key={o.action} className="inline-flex items-center rounded-md border border-slate-300 px-2.5 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50" href={`/documents/${o.targetId}`}>{o.label}</Link>;
                      case "OPEN_APPROVAL": return <Link key={o.action} className="inline-flex items-center rounded-md border border-slate-300 px-2.5 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50" href="/approvals">{o.label}</Link>;
                      case "CREATE_HANDOVER": case "OPEN_HANDOVER": return <Link key={o.action} className="inline-flex items-center rounded-md border border-slate-300 px-2.5 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50" href={o.targetId && o.action === "OPEN_HANDOVER" ? `/handover?id=${o.targetId}` : "/handover"}>{o.label}</Link>;
                      case "CREATE_REPLENISHMENT": case "VERIFY_STOCK": return <Link key={o.action} className="inline-flex items-center rounded-md border border-slate-300 px-2.5 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50" href="/inventory">{o.label}</Link>;
                      default: return null;
                    }
                  })}
                  <Button size="sm" variant="ghost" loading={busy === "ack"} disabledReason={a.state === "ACKNOWLEDGED" ? "Already acknowledged" : null} onClick={() => act("ack", () => api("POST", path(`/alerts/${a.id}/acknowledge`), { version: a.version }), "Acknowledged — escalation paused")}><CheckCheck className="h-4 w-4" aria-hidden />I'm looking into it</Button>
                  {me.voiceEnabled && <Button size="sm" variant="ghost" onClick={() => new Audio(path(`/alerts/${a.id}/audio`)).play()}><Volume2 className="h-4 w-4" aria-hidden />Play voice alert</Button>}
                </div>
                {coverage && (
                  <div className="rounded-md border border-teal-200 bg-teal-50 p-3 text-sm text-teal-950">
                    <p className="font-medium">Coverage Agent: {coverage.message}</p>
                    <p className="mt-1">MCP calls: {coverage.toolCalls.map((t) => `${t.tool} (${t.ok ? "ok" : "denied"}, ${t.durationMs} ms)`).join(" → ")}</p>
                    {coverage.proposals.length > 0 && <p className="mt-1">Proposal created — <Link className="font-medium underline" href="/approvals">approve it in Approvals</Link>; the candidate must then accept.</p>}
                  </div>
                )}
                {resolving && a.conflict && <ResolveConflict conflict={a.conflict} onDone={() => setResolving(false)} />}
              </div>
            </section>
          )}
        </div>
      )}
    </Async>
  );
}

function ResolveConflict({ conflict, onDone }: { conflict: { id: string; dedupeKey: string; clinicallySignificant: boolean }; onDone: () => void }) {
  const { api: path } = useSession();
  const toast = useToast();
  const [resolution, setResolution] = useState("");
  const [resolveTo, setResolveTo] = useState("COMPLETED");
  const [busy, setBusy] = useState(false);
  const appointment = conflict.dedupeKey.startsWith("CON-003");
  return (
    <form className="space-y-3 rounded-md border border-violet-200 bg-violet-50 p-3" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      try {
        const r = await api<{ status: string }>("POST", path(`/conflicts/${conflict.id}/resolve`), { resolution, resolveTo: appointment ? (resolveTo === "CANCELLED" ? "CANCELLED" : undefined) : resolveTo });
        toast("success", r.status === "resolved" ? "Conflict resolved" : "Sent for approval by an authorised clinical verifier");
        onDone();
      } catch (err) {
        toast("error", errorMessage(err));
      } finally {
        setBusy(false);
      }
    }}>
      {conflict.clinicallySignificant && <p className="text-sm text-violet-950">This conflict is clinically significant: your resolution becomes an approval request for someone with verify_medical. CareRelay does not decide which record is right.</p>}
      <Field label="What was verified, and with whom?"><textarea className={inputCls} rows={2} required value={resolution} onChange={(e) => setResolution(e.target.value)} /></Field>
      <Field label={appointment ? "Confirmed appointment status" : "Set the task to"}>
        <select className={inputCls} value={resolveTo} onChange={(e) => setResolveTo(e.target.value)}>
          {appointment ? (<><option value="ON">Still on — keep it</option><option value="CANCELLED">Cancelled</option></>) : (<><option value="COMPLETED">Completed (it happened)</option><option value="ACKNOWLEDGED">Not done yet — back to its owner</option><option value="UNASSIGNED">Not done — needs a new owner</option></>)}
        </select>
      </Field>
      <div className="flex justify-end gap-2"><Button type="button" size="sm" onClick={onDone}>Cancel</Button><Button type="submit" size="sm" variant="primary" loading={busy}>Submit resolution</Button></div>
    </form>
  );
}
