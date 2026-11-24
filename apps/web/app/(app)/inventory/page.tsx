"use client";
import { useState } from "react";
import useSWR from "swr";
import { AlertTriangle, ClipboardCheck, PackagePlus } from "lucide-react";
import { api, errorMessage, fetcher } from "@/lib/client/api";
import { useSession, fmtDateTime } from "@/lib/client/session";
import { Async, Button, Card, EmptyState, Field, Modal, PageHeader, inputCls, useToast } from "@/components/ui";
import { Pill } from "@/components/status";

interface Repl { id: string; state: string; assigneeMemberId: string | null; assigneeName: string | null; dueBy: string; version: number; confirmedQuantity: number | null }
interface Item { id: string; name: string; form: string; unitsPerAdministration: number; currentStock: number; stockVerifiedAt: string | null; stockVerifiedByName: string | null; reorderThresholdDays: number; version: number; scheduledPerDay: number; recordedSinceVerification: number; projection: { remainingUnits: number; daysRemaining: number | null; isEstimate: boolean; estimateReasons: string[]; label: string }; low: boolean; replenishments: Repl[] }

export default function InventoryPage() {
  const { api: path, tz, can, patient } = useSession();
  const toast = useToast();
  const swr = useSWR<{ items: Item[] }>(path("/inventory"), fetcher, { refreshInterval: 30_000 });
  const [count, setCount] = useState<Item | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  async function act(label: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(label);
    try { await fn(); toast("success", ok); } catch (e) { toast("error", errorMessage(e)); } finally { setBusy(null); }
  }
  const due = () => new Date(Date.now() + 2 * 86_400_000).toISOString();
  return (
    <>
      <PageHeader title="Inventory" subtitle="Projections use the last verified count minus recorded administrations. CareRelay never suggests changing how much is taken. Pharmacy ordering is not integrated — record refills here." />
      <Async {...swr} retry={() => swr.mutate()} empty={(d) => (d.items.length ? null : <EmptyState title="No medications tracked yet">They appear once a prescription is approved.</EmptyState>)}>
        {(d) => (
          <ul className="space-y-3">
            {d.items.map((m) => {
              const open = m.replenishments.filter((r) => !["COMPLETED", "CANCELLED"].includes(r.state));
              return (
                <li key={m.id}>
                  <Card className={m.low ? "border-l-4 border-l-amber-500 p-4" : "p-4"}>
                    <div className="flex flex-wrap items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-lg font-semibold text-slate-900">{m.name}</p>
                        <p className="text-sm text-slate-600">Last count: {m.currentStock} {m.form}(s){m.stockVerifiedAt ? ` on ${fmtDateTime(m.stockVerifiedAt, tz)} by ${m.stockVerifiedByName ?? "—"}` : " (never verified)"} · {m.recordedSinceVerification} given since · {m.scheduledPerDay}×/day scheduled · {m.unitsPerAdministration} per administration (from approved instruction)</p>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <span className="text-[15px] font-medium">Projected supply: {m.projection.daysRemaining === null ? "no scheduled use" : `${m.projection.daysRemaining.toFixed(1)} days`}</span>
                          {m.projection.isEstimate && <Pill tone="amber" icon={AlertTriangle}>Estimate — needs verification</Pill>}
                          {m.low && <Pill tone="red">Below {m.reorderThresholdDays}-day threshold</Pill>}
                        </div>
                        {m.projection.isEstimate && <p className="mt-1 text-sm text-amber-900">{m.projection.estimateReasons.join("; ")}</p>}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" disabledReason={can("record_care") ? null : "Requires record_care"} onClick={() => setCount(m)}><ClipboardCheck className="h-4 w-4" aria-hidden />Count & verify</Button>
                        <Button size="sm" variant="primary" loading={busy === `own-${m.id}`} disabledReason={!can("record_care") ? "Requires record_care" : open.length ? "A refill is already open" : null} onClick={() => act(`own-${m.id}`, () => api("POST", path(`/inventory/${m.id}/replenishments`), { dueBy: due() }), "You own this refill")}><PackagePlus className="h-4 w-4" aria-hidden />Take ownership of refill</Button>
                      </div>
                    </div>
                    {m.replenishments.length > 0 && (
                      <ul className="mt-3 space-y-2 border-t border-slate-100 pt-3">
                        {m.replenishments.slice(0, 4).map((r) => (
                          <li key={r.id} className="flex flex-wrap items-center gap-2 text-sm">
                            <span>Refill owned by <strong>{r.assigneeName ?? "nobody"}</strong>, due {fmtDateTime(r.dueBy, tz)}</span>
                            <Pill tone={r.state === "COMPLETED" ? "green" : r.state === "ACKNOWLEDGED" ? "teal" : r.state === "CANCELLED" ? "slate" : "amber"}>{r.state.replace(/_/g, " ").toLowerCase()}{r.confirmedQuantity ? ` · ${r.confirmedQuantity} received` : ""}</Pill>
                            {r.state === "AWAITING_ACKNOWLEDGEMENT" && r.assigneeMemberId === patient.memberId && <Button size="sm" onClick={() => act(r.id, () => api("POST", path(`/replenishments/${r.id}/transition`), { event: "ACKNOWLEDGE", version: r.version }), "Accepted")}>Accept</Button>}
                            {r.state === "ACKNOWLEDGED" && r.assigneeMemberId === patient.memberId && <Button size="sm" variant="primary" onClick={() => { const q = Number(prompt("How many did you receive?")); if (q > 0) void act(r.id, () => api("POST", path(`/replenishments/${r.id}/transition`), { event: "COMPLETE", version: r.version, confirmedQuantity: q }), "Refill recorded"); }}>Record received</Button>}
                            {["AWAITING_ACKNOWLEDGEMENT", "ACKNOWLEDGED"].includes(r.state) && (r.assigneeMemberId === patient.memberId || can("manage_tasks")) && <Button size="sm" variant="ghost" onClick={() => act(r.id, () => api("POST", path(`/replenishments/${r.id}/transition`), { event: "CANCEL", version: r.version }), "Cancelled")}>Cancel</Button>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </Async>
      {count && <CountDialog item={count} onClose={() => setCount(null)} />}
    </>
  );
}

function CountDialog({ item, onClose }: { item: Item; onClose: () => void }) {
  const { api: path } = useSession();
  const toast = useToast();
  const [n, setN] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Count ${item.name}`} description="Record what you physically counted. This becomes the verified stock.">
      <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await api("POST", path(`/inventory/${item.id}/verify-stock`), { count: Number(n), version: item.version }); toast("success", "Stock verified"); onClose(); } catch (err) { toast("error", errorMessage(err)); } finally { setBusy(false); } }}>
        <Field label={`Number of ${item.form}s counted`}><input type="number" min={0} step="0.5" required className={inputCls} value={n} onChange={(e) => setN(e.target.value)} /></Field>
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Save count</Button></div>
      </form>
    </Modal>
  );
}
