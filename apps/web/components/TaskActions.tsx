"use client";
import { useState } from "react";
import useSWR from "swr";
import { Check, Hand, Play, UserPlus, XCircle, Pill as PillIcon, MessageSquareWarning, Ban, ShieldAlert } from "lucide-react";
import { api, ApiError, errorMessage, fetcher } from "@/lib/client/api";
import { useSession, fmtTime } from "@/lib/client/session";
import { Button, Modal, Field, inputCls, Async, useToast, cx } from "./ui";

export interface ActionInfo { event: string; allowed: boolean; reason?: string; needsDeclaration?: boolean }
export interface TaskLite { id: string; title: string; state: string; version: number; assigneeMemberId: string | null; assigneeName?: string | null; nonRepeatable: boolean; requiredQualification: string | null; actions: ActionInfo[] }

type DialogKind = null | "assign" | "complete" | "admin" | "decline" | "report" | "cancel";

export function TaskActions({ task, full = false }: { task: TaskLite; full?: boolean }) {
  const { api: path } = useSession();
  const toast = useToast();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const a = (e: string) => task.actions.find((x) => x.event === e);

  async function transition(event: string, extra: Record<string, unknown> = {}, success?: string) {
    setBusy(event);
    try {
      await api("POST", path(`/tasks/${task.id}/transition`), { event, version: task.version, ...extra });
      toast("success", success ?? "Saved");
      setDialog(null);
      return true;
    } catch (e) {
      toast("error", e instanceof ApiError && e.code === "STALE_VERSION" ? "Someone else just updated this task. Showing the latest version." : errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  const show = (e: string) => {
    const x = a(e);
    return x && (x.allowed || full) ? x : null;
  };
  const btn = (e: string, label: string, Icon: typeof Check, onClick: () => void, variant: "primary" | "secondary" | "danger" = "secondary") => {
    const x = show(e);
    if (!x) return null;
    return (
      <Button key={e} size="sm" variant={x.allowed ? variant : "secondary"} disabledReason={x.allowed ? null : x.reason} loading={busy === e} onClick={onClick}>
        <Icon className="h-4 w-4" aria-hidden /> {label}
      </Button>
    );
  };
  const assignEvent = task.assigneeMemberId ? "REASSIGN" : "ASSIGN";

  return (
    <div className="flex flex-wrap gap-2">
      {btn("ACKNOWLEDGE", "Accept", Check, () => transition("ACKNOWLEDGE", {}, "Accepted — you now own this task"), "primary")}
      {btn("CLAIM", "I'll do it", Hand, () => transition("CLAIM", {}, "You now own this task"), "primary")}
      {btn("START", "Start", Play, () => transition("START", { declaration: a("START")?.needsDeclaration ? "Started" : undefined }, "Marked in progress"))}
      {task.nonRepeatable
        ? btn("RECORD_ADMINISTRATION", "Record given", PillIcon, () => setDialog("admin"), "primary")
        : btn("COMPLETE", "Mark done", Check, () => setDialog("complete"), "primary")}
      {btn("DECLINE", "Can't do it", XCircle, () => setDialog("decline"))}
      {btn(assignEvent, task.assigneeMemberId ? "Reassign" : "Assign", UserPlus, () => setDialog("assign"))}
      {full && btn("REPORT_STATUS", "Report status", MessageSquareWarning, () => setDialog("report"))}
      {full && btn("CANCEL", "Cancel task", Ban, () => setDialog("cancel"), "danger")}

      {dialog === "assign" && <AssignDialog task={task} event={assignEvent} onClose={() => setDialog(null)} onPick={(memberId, reason) => transition(assignEvent, { targetMemberId: memberId, reason }, "Assigned. It isn't covered until they accept.")} busy={!!busy} />}
      {dialog === "complete" && (
        <TextDialog title={`Mark done: ${task.title}`} label={a("COMPLETE")?.needsDeclaration ? "Declaration (required): what did you do, and when?" : "Note (optional)"} required={!!a("COMPLETE")?.needsDeclaration} onClose={() => setDialog(null)} busy={!!busy}
          onSubmit={(text) => transition("COMPLETE", a("COMPLETE")?.needsDeclaration ? { declaration: text } : { note: text || null }, "Recorded as completed")} />
      )}
      {dialog === "decline" && <TextDialog title="Can't do it" label="Reason (the task goes back to uncovered and coordinators are alerted)" required onClose={() => setDialog(null)} busy={!!busy} onSubmit={(text) => transition("DECLINE", { reason: text }, "Released — coordinators will be alerted")} />}
      {dialog === "cancel" && <TextDialog title="Cancel task" label="Reason (required)" required onClose={() => setDialog(null)} busy={!!busy} onSubmit={(text) => transition("CANCEL", { reason: text }, "Task cancelled")} />}
      {dialog === "report" && <ReportDialog task={task} onClose={() => setDialog(null)} />}
      {dialog === "admin" && <AdministrationDialog task={task} needsDeclaration={!!a("RECORD_ADMINISTRATION")?.needsDeclaration} onClose={() => setDialog(null)} />}
    </div>
  );
}

function TextDialog({ title, label, required, onClose, onSubmit, busy }: { title: string; label: string; required?: boolean; onClose: () => void; onSubmit: (t: string) => void; busy: boolean }) {
  const [text, setText] = useState("");
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={title}>
      <form onSubmit={(e) => (e.preventDefault(), onSubmit(text.trim()))} className="space-y-4">
        <Field id="text-dialog-input" label={label}>
          <textarea id="text-dialog-input" className={inputCls} rows={3} value={text} onChange={(e) => setText(e.target.value)} required={required} autoFocus />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Back</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={required && !text.trim()}>Confirm</Button>
        </div>
      </form>
    </Modal>
  );
}

interface Candidate { memberId: string; name: string; role: string; qualifications: string[]; eligible: boolean; reasons: string[] }
function AssignDialog({ task, event, onClose, onPick, busy }: { task: TaskLite; event: string; onClose: () => void; onPick: (id: string, reason: string) => void; busy: boolean }) {
  const { api: path } = useSession();
  const swr = useSWR<{ candidates: Candidate[] }>(path(`/candidates?taskId=${task.id}`), fetcher);
  const [reason, setReason] = useState("");
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`${event === "REASSIGN" ? "Reassign" : "Assign"}: ${task.title}`} description="Ranked by qualification, busy/free and current load. The person must accept before the task counts as covered.">
      {event === "REASSIGN" && (
        <Field id="assign-reason" label="Reason for the transfer">
          <input id="assign-reason" className={cx(inputCls, "mb-3")} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Meena is unavailable this morning" />
        </Field>
      )}
      <Async {...swr} retry={() => swr.mutate()} empty={(d) => (d.candidates.length ? null : <p>No caregivers in this circle.</p>)}>
        {(d) => (
          <ul className="space-y-2">
            {d.candidates.map((c) => {
              const unqualified = c.reasons.some((r) => r.startsWith("Lacks"));
              const current = c.memberId === task.assigneeMemberId;
              return (
                <li key={c.memberId} className="flex items-center justify-between gap-3 rounded-md border border-slate-200 p-3">
                  <div>
                    <p className="font-medium text-slate-900">{c.name} <span className="text-sm font-normal text-slate-500">· {c.role}</span></p>
                    <p className="text-sm text-slate-600">{c.reasons.join(" · ")}</p>
                  </div>
                  <Button size="sm" variant={c.eligible ? "primary" : "secondary"} loading={busy} disabledReason={unqualified ? `Needs ${task.requiredQualification}` : current ? "Already the assignee" : event === "REASSIGN" && !reason.trim() ? "Give a reason first" : null} onClick={() => onPick(c.memberId, reason.trim() || "Assigned by coordinator")}>
                    Choose
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Async>
    </Modal>
  );
}

function ReportDialog({ task, onClose }: { task: TaskLite; onClose: () => void }) {
  const { api: path } = useSession();
  const toast = useToast();
  const [claim, setClaim] = useState<"DONE" | "NOT_DONE">("NOT_DONE");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Report what you know" description="Your report is added to the record. If it contradicts another record, CareRelay flags it for a human to verify.">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api("POST", path(`/tasks/${task.id}/reports`), { claim, note });
            toast("success", "Report recorded");
            onClose();
          } catch (err) {
            toast("error", errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset className="flex gap-4">
          <legend className="mb-1 text-sm font-medium text-slate-800">Status</legend>
          {(["NOT_DONE", "DONE"] as const).map((c) => (
            <label key={c} className="flex items-center gap-2 text-sm text-slate-800">
              <input type="radio" name="claim" value={c} checked={claim === c} onChange={() => setClaim(c)} className="h-4 w-4 text-teal-600 focus:ring-teal-500" /> {c === "DONE" ? "It was done" : "It has not been done"}
            </label>
          ))}
        </fieldset>
        <Field id="report-note" label="What did you see or hear?"><textarea id="report-note" className={inputCls} rows={3} required value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Back</Button><Button type="submit" variant="primary" loading={busy}>Record report</Button></div>
      </form>
    </Modal>
  );
}

/** Records an administration. A second record for the same occurrence shows the existing one and never advises on dosing. */
function AdministrationDialog({ task, needsDeclaration, onClose }: { task: TaskLite; needsDeclaration: boolean; onClose: () => void }) {
  const { api: path, tz } = useSession();
  const toast = useToast();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [existing, setExisting] = useState<{ recordedBy: string; administeredAt: string; note: string } | null>(null);

  async function submit(confirmDuplicate = false) {
    setBusy(true);
    try {
      const r = await api<{ status: string }>("POST", path(`/tasks/${task.id}/administrations`), { note: note.trim() || undefined, confirmDuplicate: confirmDuplicate || undefined, version: confirmDuplicate ? undefined : task.version });
      toast(r.status === "flagged" ? "info" : "success", r.status === "flagged" ? "Both records are kept and flagged for verification by an authorised person." : "Recorded");
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === "DUPLICATE_ADMINISTRATION") setExisting((e.details as { existing: { recordedBy: string; administeredAt: string; note: string } }).existing);
      else toast("error", errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (existing) {
    return (
      <Modal open onOpenChange={(o) => !o && onClose()} title="This dose is already recorded">
        <div role="alert" aria-live="assertive" className="mb-4 rounded-md border border-red-200 bg-red-50 p-4">
          <div className="flex gap-2 text-red-900">
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
            <div>
              <p className="font-semibold">{existing.recordedBy} recorded this occurrence at {fmtTime(existing.administeredAt, tz)}.</p>
              {existing.note && <p className="mt-1">Their note: “{existing.note}”</p>}
              <p className="mt-2">CareRelay can't advise whether another dose should be given. This needs a decision from an authorised person (doctor / care lead).</p>
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button onClick={onClose}>I haven't given it — don't record</Button>
          <Button variant="danger" loading={busy} onClick={() => submit(true)}>I already gave it too — flag for verification</Button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Record given: ${task.title}`} description="Records that this occurrence was given, at the current time.">
      <form onSubmit={(e) => (e.preventDefault(), submit())} className="space-y-4">
        <Field id="admin-note" label={needsDeclaration ? "Declaration (required — you are not the assignee)" : "Note (optional)"}>
          <textarea id="admin-note" className={inputCls} rows={2} value={note} onChange={(e) => setNote(e.target.value)} required={needsDeclaration} />
        </Field>
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Back</Button><Button type="submit" variant="primary" loading={busy}>Record</Button></div>
      </form>
    </Modal>
  );
}
