"use client";
import Link from "next/link";
import { use, useMemo, useState } from "react";
import useSWR from "swr";
import { ArrowLeft, Check, Pencil, ShieldCheck, X } from "lucide-react";
import { api, errorMessage, fetcher } from "@/lib/client/api";
import { useSession, fmtDateTime } from "@/lib/client/session";
import { Async, Button, Card, Field, Modal, PageHeader, inputCls, useToast, cx } from "@/components/ui";
import { Pill } from "@/components/status";

interface Item { id: string; itemType: string; payload: Record<string, unknown>; confidence: number; status: string; uncertaintyNote: string | null; sourceSpan: { start: number; end: number }; detectedBy: string; rejectionReason: string | null }
interface DiffEntry { change: string; medication: string; fields: { field: string; old: string; new: string }[] }
interface Detail {
  document: { id: string; title: string; kind: string; versionNumber: number; rawText: string; createdAt: string; uploadedByName: string; versionGroupId: string };
  items: Item[];
  versions: { id: string; versionNumber: number; createdAt: string }[];
  approval: { id: string; state: string; version: number; title: string; reason: string | null; decidedAt: string | null } | null;
  diff: DiffEntry[] | null;
  previous: { id: string; versionNumber: number } | null;
}
const MEDICAL = ["MEDICATION", "CARE_ACTIVITY", "RESTRICTION", "APPOINTMENT"];

function summary(x: Item) {
  const p = x.payload;
  switch (x.itemType) {
    case "MEDICATION": return `${p.name} ${p.strength} — ${p.doseText || "dose as written"} at ${(p.times as string[]).join(", ") || "no time given"}${p.instructions ? ` · ${p.instructions}` : ""}${p.durationDays ? ` · ${p.durationDays} days` : ""}`;
    case "CARE_ACTIVITY": return `${p.title} at ${(p.times as string[]).join(", ") || "no time given"}${p.requiredQualification ? ` · needs ${p.requiredQualification}` : ""}${p.durationDays ? ` · ${p.durationDays} days` : ""}`;
    case "APPOINTMENT": return `${p.title} on ${p.date ?? "?"} at ${p.time ?? "?"}`;
    default: return String(p.text ?? p.title ?? JSON.stringify(p));
  }
}

export default function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { api: path, tz, can } = useSession();
  const toast = useToast();
  const swr = useSWR<Detail>(path(`/documents/${id}`), fetcher);
  const [active, setActive] = useState<string | null>(null);
  const [edit, setEdit] = useState<Item | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  async function act(label: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(label);
    try {
      await fn();
      toast("success", ok);
    } catch (e) {
      toast("error", errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Link href="/documents" className="mb-3 inline-flex min-h-[44px] items-center gap-1 text-sm font-medium text-slate-700 hover:text-slate-900 focus-visible:outline-teal-700">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Documents
      </Link>
      <Async {...swr} retry={() => swr.mutate()}>
        {(d) => {
          const pending = d.items.filter((i) => ["PROPOSED", "AWAITING_VERIFICATION"].includes(i.status));
          const canVerify = can("verify_medical");
          return (
            <>
              <PageHeader title={`${d.document.title} · v${d.document.versionNumber}`} subtitle={`Uploaded by ${d.document.uploadedByName} on ${fmtDateTime(d.document.createdAt, tz)}`} />
              {d.versions.length > 1 && (
                <div className="mb-4 flex flex-wrap items-center gap-2 text-sm font-medium text-slate-700" role="navigation" aria-label="Document versions">
                  <span>Versions:</span>
                  {d.versions.map((v) => (
                    <Link
                      key={v.id}
                      href={`/documents/${v.id}`}
                      className={cx("inline-flex min-h-[44px] items-center rounded border px-3 py-1 font-semibold", v.id === d.document.id ? "border-teal-700 bg-teal-50 text-teal-950" : "border-slate-300 text-slate-800 hover:bg-slate-50")}
                      aria-current={v.id === d.document.id ? "page" : undefined}
                    >
                      v{v.versionNumber}
                    </Link>
                  ))}
                </div>
              )}

              {d.diff && (
                <Card className="mb-5 overflow-x-auto p-4" role="region" aria-labelledby="diff-heading">
                  <h2 id="diff-heading" className="mb-1 text-lg font-semibold text-slate-900">Changes compared with the active instructions (v{d.previous?.versionNumber})</h2>
                  <p className="mb-3 text-sm text-slate-700">Rule CON-002 · field-by-field. CareRelay keeps following the approved instructions until a clinical verifier approves this version. It does not decide which version is right.</p>
                  <table className="w-full text-left text-[15px]" aria-label="Prescription changes diff table">
                    <thead>
                      <tr className="border-b border-slate-300 text-sm font-semibold text-slate-700">
                        <th scope="col" className="py-2 pr-3">Medicine</th>
                        <th scope="col" className="pr-3">Change</th>
                        <th scope="col" className="pr-3">Field</th>
                        <th scope="col" className="pr-3">Active (old)</th>
                        <th scope="col">This version (new)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.diff.flatMap((e) => (e.fields.length ? e.fields : [{ field: "—", old: "", new: "" }]).map((f, i) => (
                        <tr key={`${e.medication}-${i}`} className="border-b border-slate-200">
                          <td className="py-2 pr-3 font-semibold text-slate-900">{i === 0 ? e.medication : ""}</td>
                          <td className="pr-3">{i === 0 && <Pill tone={e.change === "UNCHANGED" ? "slate" : e.change === "ADDED" ? "green" : e.change === "REMOVED" ? "red" : "amber"}>{e.change.toLowerCase()}</Pill>}</td>
                          <td className="pr-3 text-slate-700">{f.field}</td>
                          <td className="pr-3"><span className={cx(e.change !== "UNCHANGED" && f.old && "rounded bg-red-100 px-1 font-medium text-red-950 line-through decoration-red-700")}>{f.old}</span></td>
                          <td><span className={cx(e.change !== "UNCHANGED" && f.new && "rounded bg-emerald-100 px-1 font-medium text-emerald-950")}>{f.new}</span></td>
                        </tr>
                      )))}
                    </tbody>
                  </table>
                </Card>
              )}

              <div className="grid gap-5 lg:grid-cols-2">
                <Card className="p-4" role="region" aria-labelledby="original-text-heading">
                  <h2 id="original-text-heading" className="mb-2 text-lg font-semibold text-slate-900">Original text</h2>
                  <HighlightedText text={d.document.rawText} items={d.items} active={active} onPick={setActive} />
                </Card>
                <div className="space-y-3" role="region" aria-labelledby="proposed-items-heading">
                  <h2 id="proposed-items-heading" className="text-lg font-semibold text-slate-900">Proposed items ({d.items.length})</h2>
                  {d.items.length === 0 && <p className="text-slate-700">No items extracted.</p>}
                  {d.items.map((x) => (
                    <Card key={x.id} className={cx("p-3 transition-shadow", active === x.id && "ring-2 ring-teal-700")} onMouseEnter={() => setActive(x.id)}>
                      <div className="flex flex-wrap items-center gap-2">
                        <Pill tone="slate">{x.itemType.replace(/_/g, " ").toLowerCase()}</Pill>
                        <Pill tone={x.status === "APPROVED" ? "green" : x.status === "REJECTED" ? "slate" : "violet"}>{x.status.replace(/_/g, " ").toLowerCase()}</Pill>
                        <span className="text-xs text-slate-600">{Math.round(x.confidence * 100)}% · {x.detectedBy}</span>
                      </div>
                      <h3 className="mt-2 text-[15px] font-semibold text-slate-900">{summary(x)}</h3>
                      {x.uncertaintyNote && <p className="mt-1 text-sm text-amber-950 font-medium">Why uncertain: {x.uncertaintyNote}</p>}
                      {x.rejectionReason && <p className="mt-1 text-sm text-slate-600">Rejected: {x.rejectionReason}</p>}
                      {["PROPOSED", "AWAITING_VERIFICATION"].includes(x.status) && (
                        <div className="mt-2 flex gap-2">
                          <Button size="sm" disabledReason={MEDICAL.includes(x.itemType) && !canVerify ? "Only a clinical verifier can edit medical instructions" : null} onClick={() => setEdit(x)}><Pencil className="h-4 w-4" aria-hidden />Edit</Button>
                          <Button size="sm" variant="danger" loading={busy === x.id} disabledReason={MEDICAL.includes(x.itemType) && !canVerify ? "Only a clinical verifier can reject medical instructions" : null} onClick={() => { const reason = prompt("Why reject this item?"); if (reason) void act(x.id, () => api("POST", path(`/extracted/${x.id}/reject`), { reason }), "Item rejected"); }}><X className="h-4 w-4" aria-hidden />Reject</Button>
                        </div>
                      )}
                    </Card>
                  ))}
                </div>
              </div>

              {d.approval && (
                <Card className="mt-5 border-teal-300 p-4" role="region" aria-labelledby="approval-heading">
                  <h2 id="approval-heading" className="flex items-center gap-2 text-lg font-semibold text-slate-900">
                    <ShieldCheck className="h-5 w-5 text-teal-800" aria-hidden /> {d.approval.title}
                  </h2>
                  {d.approval.state === "PENDING" ? (
                    <>
                      <p className="mt-1 text-slate-800">{pending.length} item(s) will become active care-plan instructions. Approval records who approved, when, and this document as the source. Nothing is active until then.</p>
                      <div className="mt-3 flex flex-wrap items-end gap-2">
                        <Button variant="primary" loading={busy === "approve"} disabledReason={canVerify ? null : "Requires the verify_medical permission (clinical verifier)"} onClick={() => act("approve", () => api("POST", path(`/approvals/${d.approval!.id}/decide`), { decision: "APPROVED", reason: "Verified against the source document", version: d.approval!.version }), "Approved — instructions are active and tasks were generated")}><Check className="h-4 w-4" aria-hidden />Approve & activate</Button>
                        {canVerify && (
                          <>
                            <Field label="Reason for rejecting this version" id="reject-version-reason" className="max-w-xs">
                              <input id="reject-version-reason" className={inputCls} placeholder="Reason to reject the whole version" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
                            </Field>
                            <Button variant="danger" loading={busy === "reject"} disabledReason={rejectReason.trim() ? null : "Give a reason first"} onClick={() => act("reject", () => api("POST", path(`/approvals/${d.approval!.id}/decide`), { decision: "REJECTED", reason: rejectReason, version: d.approval!.version }), "Version rejected — previous instructions stay active")}>Reject version</Button>
                          </>
                        )}
                      </div>
                    </>
                  ) : (
                    <p className="mt-1 text-slate-800">{d.approval.state.toLowerCase()} {d.approval.decidedAt && `on ${fmtDateTime(d.approval.decidedAt, tz)}`}{d.approval.reason ? ` — “${d.approval.reason}”` : ""}</p>
                  )}
                </Card>
              )}
              {edit && <EditItem item={edit} onClose={() => setEdit(null)} />}
            </>
          );
        }}
      </Async>
    </>
  );
}

function HighlightedText({ text, items, active, onPick }: { text: string; items: Item[]; active: string | null; onPick: (id: string) => void }) {
  const parts = useMemo(() => {
    const spans = items.filter((i) => i.sourceSpan.end > i.sourceSpan.start && i.status !== "REJECTED").sort((a, b) => a.sourceSpan.start - b.sourceSpan.start);
    const out: { text: string; id?: string }[] = [];
    let pos = 0;
    for (const s of spans) {
      if (s.sourceSpan.start < pos) continue;
      out.push({ text: text.slice(pos, s.sourceSpan.start) });
      out.push({ text: text.slice(s.sourceSpan.start, s.sourceSpan.end), id: s.id });
      pos = s.sourceSpan.end;
    }
    out.push({ text: text.slice(pos) });
    return out;
  }, [text, items]);
  return (
    <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap font-sans text-[15px] leading-relaxed text-slate-900">
      {parts.map((p, i) => (p.id ? (
        <mark
          key={i}
          role="button"
          tabIndex={0}
          aria-label={`Source span for item: ${p.text}`}
          onFocus={() => onPick(p.id!)}
          onMouseEnter={() => onPick(p.id!)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onPick(p.id!);
            }
          }}
          className={cx(
            "cursor-pointer rounded px-0.5 font-medium text-slate-900 transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-700",
            active === p.id ? "bg-amber-300 ring-2 ring-teal-700" : "bg-amber-100 ring-1 ring-amber-300"
          )}
        >
          {p.text}
        </mark>
      ) : <span key={i}>{p.text}</span>))}
    </pre>
  );
}

function EditItem({ item, onClose }: { item: Item; onClose: () => void }) {
  const { api: path } = useSession();
  const toast = useToast();
  const [json, setJson] = useState(JSON.stringify(item.payload, null, 2));
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Edit ${item.itemType.replace(/_/g, " ").toLowerCase()}`} description="Correct what was misread from the source. Values must match what the document actually says." wide>
      <form className="space-y-3" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await api("PATCH", path(`/extracted/${item.id}`), { payload: JSON.parse(json) });
          toast("success", "Item updated");
          onClose();
        } catch (err) {
          toast("error", err instanceof SyntaxError ? "That isn't valid JSON." : errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}>
        <Field label="Fields (JSON)" id="edit-json-fields" hint={item.itemType === "MEDICATION" ? "times: [\"HH:MM\"], unitsPerAdministration: number as written in the source" : undefined}>
          <textarea id="edit-json-fields" className={cx(inputCls, "font-mono text-sm min-h-[14rem]")} rows={12} value={json} onChange={(e) => setJson(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>Save</Button>
        </div>
      </form>
    </Modal>
  );
}
