"use client";
import { useState } from "react";
import useSWR from "swr";
import { CalendarX, Trash2, UserPlus } from "lucide-react";
import { api, errorMessage, fetcher } from "@/lib/client/api";
import { useSession, fmtDateTime } from "@/lib/client/session";
import { Async, Button, Card, Field, Modal, PageHeader, inputCls, useToast } from "@/components/ui";
import { Pill, SimulatedBadge } from "@/components/status";

interface Member { id: string; name: string; email: string | null; role: string; roleLabel: string; relationship: string; qualifications: string[]; messageAccessGranted: boolean; permissions: string[]; availability: { id: string; type: string; start: string; end: string; source: string; note: string }[] }
interface Policy { id: string; name: string; version: number; steps: { afterMinutes: number; notifyRoles: string[]; memberIds: string[]; channel: string }[] }
const ROLES = ["PATIENT_OR_REPRESENTATIVE", "CARE_COORDINATOR", "CLINICAL_VERIFIER", "FAMILY_CAREGIVER", "PROFESSIONAL_CAREGIVER", "REMOTE_VIEWER"];

export default function CirclePage() {
  const { api: path, tz, can, patient } = useSession();
  const toast = useToast();
  const swr = useSWR<{ members: Member[]; me: string | null }>(path("/members"), fetcher);
  const policies = useSWR<{ policies: Policy[] }>(path("/escalation-policies"), fetcher);
  const [unavail, setUnavail] = useState<Member | null>(null);
  const [adding, setAdding] = useState(false);
  async function act(fn: () => Promise<unknown>, ok: string) {
    try { await fn(); toast("success", ok); } catch (e) { toast("error", errorMessage(e)); }
  }
  return (
    <>
      <PageHeader title="Care circle & settings" subtitle="Who is involved, what they're allowed to do, and when they're available. Member and role changes go through Approvals." actions={can("manage_members") ? <Button variant="primary" onClick={() => setAdding(true)}><UserPlus className="h-4 w-4" aria-hidden />Add member</Button> : undefined} />
      <section aria-labelledby="members-heading">
        <h2 id="members-heading" className="sr-only">Circle Members</h2>
        <Async {...swr} retry={() => swr.mutate()}>
          {(d) => (
            <ul className="grid gap-3 md:grid-cols-2">
              {d.members.map((m) => (
                <li key={m.id}>
                  <Card className="h-full p-4">
                    <h2 className="text-lg font-semibold text-slate-900">{m.name}{m.id === d.me && <span className="ml-2 text-sm font-semibold text-teal-800">(you)</span>}</h2>
                    <p className="text-sm text-slate-700">{m.relationship}</p>
                    <div className="mt-2 flex flex-wrap gap-1"><Pill tone="teal">{m.roleLabel}</Pill>{m.qualifications.map((q) => <Pill key={q} tone="slate">{q.replace(/_/g, " ").toLowerCase()}</Pill>)}{m.messageAccessGranted && <Pill tone="amber">message access granted</Pill>}</div>
                    <details className="mt-2 text-sm text-slate-700"><summary className="cursor-pointer font-medium hover:underline">Permissions</summary><p className="mt-1">{m.permissions.join(", ")}</p></details>
                    <h3 className="mt-3 text-sm font-semibold text-slate-800">Availability</h3>
                    {m.availability.length === 0 ? <p className="text-sm text-slate-600">Nothing declared.</p> : (
                      <ul className="mt-1 space-y-1 text-sm">
                        {m.availability.slice(0, 6).map((a) => (
                          <li key={a.id} className="flex flex-wrap items-center gap-2">
                            <Pill tone={a.type === "WORKING_HOURS" ? "teal" : "red"}>{a.type === "WORKING_HOURS" ? "on shift" : a.type === "UNAVAILABLE" ? "unavailable" : "busy"}</Pill>
                            <span className="text-slate-800">{fmtDateTime(a.start, tz)} – {fmtDateTime(a.end, tz)} {a.note && `· ${a.note}`}</span>
                            {a.source === "CALENDAR_SIMULATED" && <SimulatedBadge what="calendar" />}
                            {(m.id === d.me || can("manage_tasks")) && a.source === "MANUAL" && (
                              <button
                                aria-label={`Remove availability block for ${m.name}`}
                                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center text-slate-600 hover:text-red-700 focus-visible:outline-teal-700"
                                onClick={() => act(() => api("DELETE", path(`/availability/${a.id}`)), "Removed")}
                              >
                                <Trash2 className="h-4 w-4" aria-hidden />
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {(m.id === d.me || can("manage_tasks")) && m.permissions.includes("record_care") && <Button size="sm" onClick={() => setUnavail(m)}><CalendarX className="h-4 w-4" aria-hidden />{m.id === d.me ? "I'm unavailable…" : "Mark unavailable…"}</Button>}
                      {can("manage_members") && m.id !== d.me && (
                        <>
                          <select aria-label={`Change ${m.name}'s role`} className="min-h-[44px] rounded border border-slate-300 px-2 py-1 text-sm text-slate-900 focus-visible:outline-teal-700" value="" onChange={(e) => e.target.value && act(() => api("POST", path(`/members/${m.id}/role`), { role: e.target.value }), "Role change sent for approval")}>
                            <option value="">Change role…</option>{ROLES.filter((r) => r !== m.role).map((r) => <option key={r} value={r}>{r.replace(/_/g, " ").toLowerCase()}</option>)}
                          </select>
                          {m.role === "REMOTE_VIEWER" && !m.messageAccessGranted && <Button size="sm" onClick={() => act(() => api("POST", path(`/members/${m.id}/grant-messages`)), "Request sent to Approvals")}>Grant message access…</Button>}
                          <Button size="sm" variant="danger" onClick={() => confirm(`Request removing ${m.name}?`) && act(() => api("POST", path(`/members/${m.id}/remove`)), "Removal sent for approval")}>Remove…</Button>
                        </>
                      )}
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </Async>
      </section>
      <section aria-labelledby="escalation-heading" className="mt-8">
        <h2 id="escalation-heading" className="mb-2 text-lg font-semibold text-slate-900">Escalation policy</h2>
        <Async {...policies} retry={() => policies.mutate()}>
          {(d) => (<>{d.policies.map((p) => <PolicyEditor key={p.id} policy={p} canEdit={can("manage_tasks")} />)}</>)}
        </Async>
      </section>
      {unavail && <UnavailableDialog member={unavail} tz={patient.timezone} onClose={() => setUnavail(null)} />}
      {adding && <AddMemberDialog onClose={() => setAdding(false)} />}
    </>
  );
}

function PolicyEditor({ policy, canEdit }: { policy: Policy; canEdit: boolean }) {
  const { api: path } = useSession();
  const toast = useToast();
  const [steps, setSteps] = useState(policy.steps);
  return (
    <Card className="p-4">
      <h3 className="font-semibold text-slate-900">{policy.name}</h3>
      <ol className="mt-2 space-y-2">
        {steps.map((s, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2 text-sm text-slate-800">
            <span className="w-14 font-medium">Step {i}</span>
            <span>after</span>
            <input aria-label={`Step ${i} delay in minutes`} type="number" min={0} disabled={!canEdit || i === 0} className="w-20 min-h-[44px] rounded border border-slate-300 px-2 py-1 text-slate-900 focus-visible:outline-teal-700" value={s.afterMinutes} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, afterMinutes: Number(e.target.value) } : x)))} />
            <span>min →</span>
            <span>{i === 0 ? "alert responders" : `notify ${s.notifyRoles.map((r) => r.replace(/_/g, " ").toLowerCase()).join(", ") || "listed members"}`} via</span>
            <select aria-label={`Step ${i} notification channel`} disabled={!canEdit} className="min-h-[44px] rounded border border-slate-300 px-2 py-1 text-slate-900 focus-visible:outline-teal-700" value={s.channel} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, channel: e.target.value } : x)))}>
              <option value="IN_APP">in-app</option>
              <option value="VOICE_ELEVENLABS">voice (ElevenLabs)</option>
              <option value="SMS_SIMULATED">SMS (simulated)</option>
            </select>
          </li>
        ))}
      </ol>
      {canEdit && <Button className="mt-3" size="sm" variant="primary" onClick={async () => { try { await api("PUT", path(`/escalation-policies/${policy.id}`), { steps, version: policy.version }); toast("success", "Policy saved"); } catch (e) { toast("error", errorMessage(e)); } }}>Save policy</Button>}
    </Card>
  );
}

function UnavailableDialog({ member, tz, onClose }: { member: Member; tz: string; onClose: () => void }) {
  const { api: path, me } = useSession();
  const toast = useToast();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(me.now));
  const [f, setF] = useState({ date: today, from: "09:30", to: "12:30", note: "" });
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`${member.name.split(" ")[0]} unavailable`} description="Tasks assigned during this time will be flagged (GAP-005) so someone else can be found.">
      <form className="grid gap-3 sm:grid-cols-3" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try { await api("POST", path("/availability"), { memberId: member.id, type: "UNAVAILABLE", start: `${f.date}T${f.from}:00+05:30`, end: `${f.date}T${f.to}:00+05:30`, note: f.note }); toast("success", "Saved — affected tasks are flagged"); onClose(); } catch (err) { toast("error", errorMessage(err)); } finally { setBusy(false); }
      }}>
        <Field label="Date" id="unavail-date"><input id="unavail-date" type="date" className={inputCls} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="From (IST)" id="unavail-from"><input id="unavail-from" type="time" className={inputCls} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
        <Field label="To (IST)" id="unavail-to"><input id="unavail-to" type="time" className={inputCls} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
        <div className="sm:col-span-3"><Field label="Note (visible to coordinators)" id="unavail-note"><input id="unavail-note" className={inputCls} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field></div>
        <div className="flex justify-end gap-2 sm:col-span-3"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

function AddMemberDialog({ onClose }: { onClose: () => void }) {
  const { api: path } = useSession();
  const toast = useToast();
  const [f, setF] = useState({ name: "", email: "", role: "FAMILY_CAREGIVER", relationship: "", qualifications: "" });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Add a member" description="Creates an approval request. The member is added once someone with manage_members approves it.">
      <form className="grid gap-3" onSubmit={async (e) => { e.preventDefault(); try { await api("POST", path("/members"), { ...f, qualifications: f.qualifications.split(",").map((q) => q.trim().toUpperCase()).filter(Boolean) }); toast("success", "Sent to Approvals"); onClose(); } catch (err) { toast("error", errorMessage(err)); } }}>
        <Field label="Name" id="add-member-name"><input id="add-member-name" className={inputCls} required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Email" id="add-member-email"><input id="add-member-email" type="email" className={inputCls} required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Role" id="add-member-role"><select id="add-member-role" className={inputCls} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{ROLES.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ").toLowerCase()}</option>)}</select></Field>
        <Field label="Relationship" id="add-member-rel"><input id="add-member-rel" className={inputCls} value={f.relationship} onChange={(e) => setF({ ...f, relationship: e.target.value })} /></Field>
        <Field label="Qualifications (comma-separated)" id="add-member-qual"><input id="add-member-qual" className={inputCls} value={f.qualifications} onChange={(e) => setF({ ...f, qualifications: e.target.value })} placeholder="WOUND_CARE_TRAINED" /></Field>
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary">Request</Button></div>
      </form>
    </Modal>
  );
}
