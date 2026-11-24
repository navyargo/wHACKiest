"use client";
import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { Bot, Check, X } from "lucide-react";
import { api, errorMessage, fetcher } from "@/lib/client/api";
import { useSession, fmtDateTime } from "@/lib/client/session";
import { Async, Button, Card, EmptyState, PageHeader, inputCls, useToast, cx } from "@/components/ui";
import { Pill } from "@/components/status";

interface Approval { id: string; actionType: string; title: string; payload: Record<string, unknown>; state: string; requiredPermission: string; requestedByType: string; requestedByName: string | null; decidedByName: string | null; reason: string | null; createdAt: string; decidedAt: string | null; version: number; canDecide: boolean; result: Record<string, unknown> | null }

export default function ApprovalsPage() {
  const { api: path, tz } = useSession();
  const toast = useToast();
  const [state, setState] = useState<"PENDING" | "">("PENDING");
  const swr = useSWR<{ approvals: Approval[] }>(path(`/approvals${state ? `?state=${state}` : ""}`), fetcher, { refreshInterval: 20_000 });
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  async function decide(a: Approval, decision: "APPROVED" | "REJECTED") {
    setBusy(a.id + decision);
    try {
      await api("POST", path(`/approvals/${a.id}/decide`), { decision, reason: reasons[a.id] || null, version: a.version });
      toast("success", decision === "APPROVED" ? "Approved and carried out" : "Rejected");
    } catch (e) {
      toast("error", errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      <PageHeader title="Approvals" subtitle="Sensitive actions wait here for a person with the right permission. Agents can request, never approve." />
      <div className="mb-4 flex gap-2">
        <Button size="sm" variant={state === "PENDING" ? "primary" : "secondary"} onClick={() => setState("PENDING")}>Pending</Button>
        <Button size="sm" variant={state === "" ? "primary" : "secondary"} onClick={() => setState("")}>All</Button>
      </div>
      <Async {...swr} retry={() => swr.mutate()} empty={(d) => (d.approvals.length ? null : <EmptyState title="Nothing waiting for approval" />)}>
        {(d) => (
          <ul className="space-y-3">
            {d.approvals.map((a) => (
              <li key={a.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill tone="slate">{a.actionType.replace(/_/g, " ").toLowerCase()}</Pill>
                    <Pill tone={a.state === "PENDING" ? "amber" : a.state === "APPROVED" ? "green" : "slate"}>{a.state.toLowerCase()}</Pill>
                    {a.requestedByType === "AGENT" && <Pill tone="violet" icon={Bot}>Requested by an AI agent</Pill>}
                    <span className="text-sm text-slate-500">needs {a.requiredPermission}</span>
                  </div>
                  <p className="mt-2 font-medium text-slate-900">{a.title}</p>
                  <p className="text-sm text-slate-600">Requested by {a.requestedByName ?? "—"} on {fmtDateTime(a.createdAt, tz)}{a.payload.reason ? ` · “${String(a.payload.reason)}”` : ""}</p>
                  {a.actionType === "ACTIVATE_INSTRUCTIONS" && <Link className="text-sm font-medium text-teal-700 hover:underline" href={`/documents/${String(a.payload.documentId)}`}>Review the document and extracted items →</Link>}
                  {a.actionType === "REASSIGN_TASK" && <Link className="text-sm font-medium text-teal-700 hover:underline" href={`/tasks/${String(a.payload.taskId)}`}>Open the task →</Link>}
                  {a.actionType === "RESOLVE_CLINICAL_CONFLICT" && <p className="mt-1 rounded bg-violet-50 p-2 text-sm text-violet-950">Proposed resolution: “{String(a.payload.resolution)}”</p>}
                  {a.state === "PENDING" ? (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <input aria-label="Reason" className={cx(inputCls, "max-w-sm")} placeholder="Reason (required to reject)" value={reasons[a.id] ?? ""} onChange={(e) => setReasons({ ...reasons, [a.id]: e.target.value })} />
                      <Button variant="primary" loading={busy === a.id + "APPROVED"} disabledReason={a.canDecide ? null : `Requires the ${a.requiredPermission} permission`} onClick={() => decide(a, "APPROVED")}><Check className="h-4 w-4" aria-hidden />Approve</Button>
                      <Button variant="danger" loading={busy === a.id + "REJECTED"} disabledReason={!a.canDecide ? `Requires the ${a.requiredPermission} permission` : !(reasons[a.id] ?? "").trim() ? "Give a reason first" : null} onClick={() => decide(a, "REJECTED")}><X className="h-4 w-4" aria-hidden />Reject</Button>
                    </div>
                  ) : (
                    <p className="mt-2 text-sm text-slate-600">{a.state.toLowerCase()} by {a.decidedByName ?? "—"} on {fmtDateTime(a.decidedAt, tz)}{a.reason ? ` — “${a.reason}”` : ""}</p>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </Async>
    </>
  );
}
