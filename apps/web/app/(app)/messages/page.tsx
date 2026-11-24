"use client";
import { useState } from "react";
import useSWR from "swr";
import { Check, FileUp, Lock, Send, Sparkles, X } from "lucide-react";
import { api, errorMessage, fetcher } from "@/lib/client/api";
import { useSession, fmtDateTime } from "@/lib/client/session";
import { Async, Button, Card, EmptyState, Field, Modal, PageHeader, inputCls, useToast, cx } from "@/components/ui";
import { Pill, SimulatedBadge } from "@/components/status";

interface Interp { id: string; itemType: string; payload: Record<string, unknown>; confidence: number; status: string; uncertaintyNote: string | null; detectedBy: string }
interface Msg { id: string; channel: string; senderDisplay: string; senderMemberId: string | null; sentAt: string; text: string; authorisedForProcessing: boolean; processedAt: string | null; interpretations: Interp[] }

function describe(x: Interp) {
  const p = x.payload;
  switch (x.itemType) {
    case "COMMITMENT": return p.isHandoff ? `Hand-off: ${p.committedName} is said to be doing this — not yet confirmed by ${p.committedName}` : `Commitment by ${p.committedName || "sender"}`;
    case "COMPLETION_REPORT": return `Report: ${p.claim === "DONE" ? "done" : "NOT done"} (${p.timeOfDay}, ${String(p.category).toLowerCase()})${p.linkedTaskId ? " · linked to a task" : " · no matching task"}`;
    case "SCHEDULE_CHANGE": return `Schedule change: ${String(p.subject)} ${String(p.status).toLowerCase()}${p.date ? ` on ${p.date}` : ""}`;
    case "OBSERVATION": return `Observation (${p.category}): ${p.text}`;
    case "REPLENISHMENT_REQUEST": return `Supply request: ${p.medicationName || p.text}`;
    default: return `${x.itemType.replace(/_/g, " ").toLowerCase()}: ${String(p.text ?? "")}`;
  }
}

export default function MessagesPage() {
  const { api: path, tz, patient, can } = useSession();
  const toast = useToast();
  const swr = useSWR<{ messages: Msg[] }>(path("/messages"), fetcher, { refreshInterval: 20_000 });
  const [text, setText] = useState("");
  const [channel, setChannel] = useState("WHATSAPP_SIMULATED");
  const [authorise, setAuthorise] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  async function act(label: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(label);
    try {
      await fn();
      toast("success", ok);
      return true;
    } catch (e) {
      toast("error", errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader title="Messages" subtitle={<span className="flex flex-wrap items-center gap-2"><SimulatedBadge what="WhatsApp / SMS inbox" /> Only messages explicitly authorised for processing are read by AI. Interpretations need confirmation.</span>} actions={can("record_care") ? <Button onClick={() => setImporting(true)}><FileUp className="h-4 w-4" aria-hidden />Import WhatsApp export</Button> : undefined} />
      {can("record_care") && (
        <Card className="mb-5 p-4">
          <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await act("post", () => api("POST", path("/messages"), { text, channel, authorise, extract: authorise }), authorise ? "Posted and interpreted by the Intake Agent" : "Posted (not authorised for AI processing)")) setText(""); }}>
            <Field label={`Post to the ${patient.displayName} family group (simulated)`}><textarea className={inputCls} rows={2} required value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Ravi will take Amma to the clinic tomorrow morning" /></Field>
            <div className="flex flex-wrap items-center gap-3">
              <select aria-label="Channel" className={cx(inputCls, "w-auto")} value={channel} onChange={(e) => setChannel(e.target.value)}><option value="WHATSAPP_SIMULATED">WhatsApp (simulated)</option><option value="SMS_SIMULATED">SMS (simulated)</option><option value="IN_APP">In-app</option></select>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={authorise} onChange={(e) => setAuthorise(e.target.checked)} /> Authorise CareRelay to process this message</label>
              <Button type="submit" variant="primary" loading={busy === "post"} className="ml-auto"><Send className="h-4 w-4" aria-hidden />Post</Button>
            </div>
          </form>
        </Card>
      )}
      <Async {...swr} retry={() => swr.mutate()} empty={(d) => (d.messages.length ? null : <EmptyState title="No messages yet" />)}>
        {(d) => (
          <ul className="space-y-3">
            {d.messages.map((m) => (
              <li key={m.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
                    <strong className="text-slate-900">{m.senderDisplay}</strong>
                    <span>{fmtDateTime(m.sentAt, tz)}</span>
                    <Pill tone="amber">{m.channel.replace("_SIMULATED", "").toLowerCase()} · simulated</Pill>
                    {!m.authorisedForProcessing && <Pill tone="slate" icon={Lock}>Not authorised for processing</Pill>}
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-[15px] text-slate-900">{m.text}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {!m.authorisedForProcessing && can("record_care") && <Button size="sm" loading={busy === `auth-${m.id}`} onClick={() => act(`auth-${m.id}`, () => api("POST", path(`/messages/${m.id}/authorise`)), "Authorised")}>Authorise processing</Button>}
                    {m.authorisedForProcessing && m.interpretations.length === 0 && <Button size="sm" loading={busy === `ex-${m.id}`} onClick={() => act(`ex-${m.id}`, () => api("POST", path(`/messages/${m.id}/extract`)), "Interpreted by the Intake Agent via MCP")}><Sparkles className="h-4 w-4" aria-hidden />Interpret</Button>}
                  </div>
                  {m.interpretations.length > 0 && (
                    <ul className="mt-3 space-y-2 border-t border-slate-100 pt-3">
                      {m.interpretations.map((x) => (
                        <li key={x.id} className="flex flex-wrap items-center gap-2 text-sm">
                          <Sparkles className="h-4 w-4 text-violet-600" aria-hidden />
                          <span className="flex-1 text-slate-800">{describe(x)} <span className="text-slate-500">· {Math.round(x.confidence * 100)}% · {x.detectedBy}</span>{x.uncertaintyNote && <span className="block text-amber-800">Why uncertain: {x.uncertaintyNote}</span>}</span>
                          <Pill tone={x.status === "APPROVED" ? "green" : "violet"}>{x.status === "APPROVED" ? "confirmed" : "awaiting confirmation"}</Pill>
                          {x.status !== "APPROVED" && (
                            <>
                              <Button size="sm" loading={busy === `c-${x.id}`} onClick={() => act(`c-${x.id}`, () => api("POST", path(`/extracted/${x.id}/confirm`)), "Confirmed")}><Check className="h-4 w-4" aria-hidden />Confirm</Button>
                              <Button size="sm" variant="ghost" onClick={() => { const r = prompt("Why is this interpretation wrong?"); if (r) void act(`r-${x.id}`, () => api("POST", path(`/extracted/${x.id}/reject`), { reason: r }), "Dismissed"); }}><X className="h-4 w-4" aria-hidden />Dismiss</Button>
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </Async>
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
    </>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const { api: path } = useSession();
  const toast = useToast();
  const [fileText, setFileText] = useState("");
  const [authorise, setAuthorise] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Import a WhatsApp chat export" description="In WhatsApp: chat → More → Export chat → Without media. The .txt is parsed locally on the server; nothing is sent to WhatsApp.">
      <form className="space-y-3" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const r = await api<{ imported: number; unmatchedSenders: string[] }>("POST", path("/messages/import"), { fileText, authorise });
          toast("success", `Imported ${r.imported} messages${r.unmatchedSenders.length ? ` (unknown senders: ${r.unmatchedSenders.join(", ")})` : ""}`);
          onClose();
        } catch (err) {
          toast("error", errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}>
        <input type="file" accept=".txt,text/plain" aria-label="Chat export file" onChange={async (e) => setFileText((await e.target.files?.[0]?.text()) ?? "")} className="block text-sm" />
        <Field label="…or paste the export"><textarea className={inputCls} rows={6} value={fileText} onChange={(e) => setFileText(e.target.value)} placeholder="12/03/2025, 09:15 - Priya: Good morning" /></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={authorise} onChange={(e) => setAuthorise(e.target.checked)} /> Everyone in this chat agreed that CareRelay may process these messages</label>
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={busy} disabled={!fileText.trim()}>Import</Button></div>
      </form>
    </Modal>
  );
}
