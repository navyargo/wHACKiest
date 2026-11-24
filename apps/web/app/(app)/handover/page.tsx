"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import useSWR from "swr";
import { Bot, CheckCheck, ClipboardList, Plus, Send, Volume2 } from "lucide-react";
import { api, errorMessage, fetcher } from "@/lib/client/api";
import { useSession, fmtDateTime } from "@/lib/client/session";
import { Async, Button, Card, EmptyState, Field, Modal, PageHeader, inputCls, useToast, cx } from "@/components/ui";
import { Pill } from "@/components/status";

interface SnapItem { id: string; text: string; at: string | null }
interface Handover { id: string; fromMemberId: string; toMemberId: string; fromName: string; toName: string; shiftStart: string; shiftEnd: string; state: string; sentAt: string | null; acknowledgedAt: string | null; observations: string; version: number; snapshot: Record<string, SnapItem[] | string>; summary: { sentences: { text: string; refs: string[] }[] } | null }
const SECTIONS: [string, string][] = [["activeAlerts", "Open alerts"], ["unresolvedConflicts", "Unresolved conflicts"], ["pendingActivities", "Still pending"], ["upcomingActivities", "Coming up (next 12 h)"], ["medicationEvents", "Medication records"], ["completedActivities", "Completed this shift"], ["observations", "Observations"], ["inventoryShortages", "Supplies running low"], ["upcomingAppointments", "Appointments"], ["recentInstructionChanges", "Recent instruction changes"]];

export default function HandoverPage() {
  return <Suspense><HandoverInner /></Suspense>;
}

function HandoverInner() {
  const { api: path, tz, patient, can } = useSession();
  const params = useSearchParams();
  const router = useRouter();
  const list = useSWR<{ handovers: Handover[] }>(path("/handovers"), fetcher, { refreshInterval: 20_000 });
  const [creating, setCreating] = useState(false);
  const id = params.get("id");
  const mine = (h: Handover) => h.fromMemberId === patient.memberId || h.toMemberId === patient.memberId;
  return (
    <>
      <PageHeader title="Handover" subtitle="Structured shift handovers built from recorded data. Reading a handover never accepts or completes the tasks in it." actions={can("record_care") ? <Button variant="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden />New handover</Button> : undefined} />
      <div className="grid gap-5 lg:grid-cols-[18rem_1fr]">
        <Async {...list} retry={() => list.mutate()} empty={(d) => (d.handovers.length ? null : <EmptyState title="No handovers yet" />)}>
          {(d) => (
            <ul className="space-y-2" aria-label="Handovers">
              {d.handovers.map((h) => (
                <li key={h.id}>
                  <button onClick={() => router.push(`/handover?id=${h.id}`)} className={cx("w-full rounded-lg border bg-white p-3 text-left text-sm transition-colors duration-150 hover:border-teal-600", id === h.id ? "border-teal-600" : "border-slate-200", h.state === "SENT" && h.toMemberId === patient.memberId && "border-l-4 border-l-amber-500")}>
                    <p className="font-medium text-slate-900">{h.fromName.split(" ")[0]} → {h.toName.split(" ")[0]}</p>
                    <p className="text-slate-600">Shift ending {fmtDateTime(h.shiftEnd, tz)}</p>
                    <Pill tone={h.state === "ACKNOWLEDGED" ? "green" : h.state === "SENT" ? "amber" : "slate"}>{h.state === "ACKNOWLEDGED" ? "read by recipient" : h.state === "SENT" ? "sent — not yet read" : "draft"}</Pill>
                    {mine(h) && <span className="ml-2 text-xs text-teal-700">involves you</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Async>
        <div>{id ? <HandoverDetail id={id} /> : <EmptyState title="Choose a handover" icon={<ClipboardList className="h-8 w-8" aria-hidden />}>or start a new one at the end of your shift.</EmptyState>}</div>
      </div>
      {creating && <NewHandover onClose={() => setCreating(false)} onCreated={(hid) => { setCreating(false); router.push(`/handover?id=${hid}`); }} />}
    </>
  );
}

function NewHandover({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { api: path, patient } = useSession();
  const toast = useToast();
  const members = useSWR<{ members: { id: string; name: string; permissions: string[] }[] }>(path("/members"), fetcher);
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const options = members.data?.members.filter((m) => m.id !== patient.memberId && m.permissions.includes("record_care")) ?? [];
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="New handover" description="The Handover Agent calls draft_handover over MCP, then writes a short summary in which every sentence cites a recorded item.">
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const r = await api<{ handoverId: string; dropped: string[]; needsManualReview: boolean }>("POST", path("/handovers"), { toMemberId: to });
          toast(r.needsManualReview ? "info" : "success", r.needsManualReview ? "Draft created; the AI summary needs manual review." : `Draft ready${r.dropped.length ? ` (${r.dropped.length} unsupported sentence(s) removed)` : ""}.`);
          onCreated(r.handoverId);
        } catch (err) {
          toast("error", errorMessage(err));
          setBusy(false);
        }
      }}>
        <Field label="Hand over to"><select className={inputCls} required value={to} onChange={(e) => setTo(e.target.value)}><option value="">Choose…</option>{options.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={busy}><Bot className="h-4 w-4" aria-hidden />Draft with Handover Agent</Button></div>
      </form>
    </Modal>
  );
}

function HandoverDetail({ id }: { id: string }) {
  const { api: path, tz, patient, me } = useSession();
  const toast = useToast();
  const swr = useSWR<Handover>(path(`/handovers/${id}`), fetcher);
  const [obs, setObs] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [listen, setListen] = useState(false);
  useEffect(() => setObs(swr.data?.observations ?? ""), [swr.data?.id, swr.data?.observations]);

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
    <Async {...swr} retry={() => swr.mutate()}>
      {(h) => {
        const isFrom = h.fromMemberId === patient.memberId;
        const isTo = h.toMemberId === patient.memberId;
        const all = SECTIONS.flatMap(([k]) => (Array.isArray(h.snapshot[k]) ? (h.snapshot[k] as SnapItem[]) : []));
        const label = (ref: string) => all.find((i) => i.id === ref)?.text ?? ref;
        return (
          <Card className="space-y-5 p-5">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">{h.fromName} → {h.toName}</h2>
              <p className="text-sm text-slate-600">Shift {fmtDateTime(h.shiftStart, tz)} – {fmtDateTime(h.shiftEnd, tz)} · {h.state === "DRAFT" ? "draft" : h.state === "SENT" ? `sent ${fmtDateTime(h.sentAt, tz)}, not yet read` : `read by ${h.toName.split(" ")[0]} at ${fmtDateTime(h.acknowledgedAt, tz)}`}</p>
            </div>
            {h.summary && h.summary.sentences.length > 0 && (
              <section className="rounded-md border border-teal-200 bg-teal-50 p-4">
                <h3 className="mb-2 flex items-center gap-2 font-semibold text-teal-950"><Bot className="h-4 w-4" aria-hidden />Summary (Handover Agent — every sentence cites recorded items)</h3>
                <ul className="space-y-2">
                  {h.summary.sentences.map((s, i) => (
                    <li key={i} className="text-[15px] text-slate-900">{s.text} {s.refs.map((r) => <span key={r} title={label(r)} className="ml-1 rounded bg-white px-1 text-xs text-teal-800 ring-1 ring-teal-200">{r.split(":")[0]}</span>)}</li>
                  ))}
                </ul>
              </section>
            )}
            {me.voiceEnabled && h.state !== "DRAFT" && (
              <div>
                {listen ? <audio controls autoPlay src={path(`/handovers/${h.id}/audio`)} className="w-full" /> : <Button onClick={() => setListen(true)}><Volume2 className="h-4 w-4" aria-hidden />Listen to handover (ElevenLabs)</Button>}
              </div>
            )}
            <div className="grid gap-4 md:grid-cols-2">
              {SECTIONS.map(([k, title]) => {
                const items = (h.snapshot[k] as SnapItem[]) ?? [];
                return (
                  <section key={k} aria-label={title}>
                    <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-500">{title} ({items.length})</h3>
                    {items.length === 0 ? <p className="text-sm text-slate-400">None</p> : <ul className="list-disc space-y-1 pl-5 text-[15px] text-slate-800">{items.map((i) => <li key={i.id}>{i.text}</li>)}</ul>}
                  </section>
                );
              })}
            </div>
            <section>
              <Field label="Caregiver observations">
                <textarea className={inputCls} rows={3} value={obs} disabled={!(isFrom && h.state === "DRAFT")} onChange={(e) => setObs(e.target.value)} placeholder="Anything the next person should know" />
              </Field>
            </section>
            <div className="flex flex-wrap gap-2">
              {isFrom && h.state === "DRAFT" && (
                <>
                  <Button loading={busy === "save"} onClick={() => act("save", () => api("PATCH", path(`/handovers/${h.id}`), { observations: obs, version: h.version }), "Observations saved")}>Save observations</Button>
                  <Button variant="primary" loading={busy === "send"} onClick={() => act("send", async () => { if (obs !== h.observations) await api("PATCH", path(`/handovers/${h.id}`), { observations: obs, version: h.version }, { revalidate: false }); const fresh = await fetch(path(`/handovers/${h.id}`)).then((r) => r.json()); await api("POST", path(`/handovers/${h.id}/send`), { version: fresh.version }); }, `Sent to ${h.toName}`)}><Send className="h-4 w-4" aria-hidden />Send handover</Button>
                </>
              )}
              {isTo && h.state === "SENT" && (
                <div className="w-full rounded-md border border-amber-200 bg-amber-50 p-3">
                  <p className="mb-2 text-sm text-amber-950">Confirming you read this does <strong>not</strong> accept or complete any task. Pending tasks still need to be accepted one by one.</p>
                  <Button variant="primary" loading={busy === "ack"} onClick={() => act("ack", () => api("POST", path(`/handovers/${h.id}/acknowledge`), { version: h.version }), "Read receipt recorded")}><CheckCheck className="h-4 w-4" aria-hidden />I have read this handover</Button>
                </div>
              )}
            </div>
          </Card>
        );
      }}
    </Async>
  );
}
