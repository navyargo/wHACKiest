"use client";
import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { ChevronLeft, ChevronRight, Plus, ShieldAlert, UserX, Clock, GitCompare, ListChecks, Ban } from "lucide-react";
import { api, errorMessage, fetcher } from "@/lib/client/api";
import { useSession, fmtTime } from "@/lib/client/session";
import { Async, Button, Card, EmptyState, Field, Modal, PageHeader, inputCls, useToast, cx } from "@/components/ui";
import { TaskStateBadge, LevelBadge } from "@/components/status";
import { TaskActions, type TaskLite } from "@/components/TaskActions";

interface Status { date: string; now: string; tasksToday: number; uncovered: number; overdue: number; completed: number; openConflicts: number; openAlerts: number; topAlerts: { id: string; title: string; level: string }[]; lowStock: { name: string; label: string }[]; uncoveredTasks: { id: string; title: string; time: string; assigneeName: string | null }[]; nextTasks: { id: string; title: string; time: string; state: string; assigneeName: string | null; covered: boolean }[] }
interface TaskRow extends TaskLite { localTime: string; windowStart: string; windowEnd: string; category: string; priority: string; covered: boolean; acknowledgedAt: string | null; completedByName: string | null; completedAt: string | null }

const GROUPS: [string, number, number][] = [["Early morning & morning", 0, 12], ["Afternoon", 12, 17], ["Evening", 17, 21], ["Night", 21, 24]];

function addDays(date: string, n: number) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export default function TodayPage() {
  const { can } = useSession();
  return can("record_care") || can("manage_tasks") ? <CareBoard /> : <RemoteView />;
}

function CoverageStrip({ s }: { s: Status }) {
  const items = [
    { label: "tasks today", value: s.tasksToday, icon: ListChecks, tone: "text-slate-800" },
    { label: "uncovered", value: s.uncovered, icon: UserX, tone: s.uncovered ? "text-red-700" : "text-slate-800" },
    { label: "overdue", value: s.overdue, icon: Clock, tone: s.overdue ? "text-red-700" : "text-slate-800" },
    { label: "conflicts", value: s.openConflicts, icon: GitCompare, tone: s.openConflicts ? "text-violet-700" : "text-slate-800" },
  ];
  return (
    <Card className="mb-5 grid grid-cols-2 divide-slate-200 sm:grid-cols-4 sm:divide-x" aria-label="Coverage">
      {items.map((i) => (
        <div key={i.label} className="flex items-center gap-3 p-4">
          <i.icon className={cx("h-6 w-6", i.tone)} aria-hidden />
          <div><p className={cx("text-2xl font-semibold", i.tone)}>{i.value}</p><p className="text-sm text-slate-600">{i.label}</p></div>
        </div>
      ))}
    </Card>
  );
}

function CareBoard() {
  const { api: path, can, tz } = useSession();
  const [date, setDate] = useState<string | null>(null);
  const status = useSWR<Status>(path("/status"), fetcher, { refreshInterval: 20_000 });
  const tasks = useSWR<{ date: string; now: string; tasks: TaskRow[] }>(path(`/tasks${date ? `?date=${date}` : ""}`), fetcher, { refreshInterval: 20_000 });
  const patient = useSWR<{ restrictions: { id: string; text: string }[]; allergies: string[]; mobilityNotes: string }>(path(""), fetcher);
  const [create, setCreate] = useState(false);
  const shown = tasks.data?.date ?? date;

  return (
    <>
      <PageHeader
        title="Today"
        subtitle="Every task shows who owns it and whether they accepted it."
        actions={can("manage_tasks") ? <Button variant="primary" onClick={() => setCreate(true)}><Plus className="h-4 w-4" aria-hidden /> New task</Button> : undefined}
      />
      <Async {...status} retry={() => status.mutate()} rows={1}>{(s) => <CoverageStrip s={s} />}</Async>
      {patient.data && (patient.data.restrictions.length > 0 || patient.data.allergies.length > 0) && (
        <Card className="mb-5 flex gap-3 border-violet-200 bg-violet-50 p-4">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-violet-700" aria-hidden />
          <div className="text-[15px] text-violet-950">
            <p className="font-medium">Approved restrictions & allergies</p>
            <ul className="mt-1 list-disc pl-5">
              {patient.data.allergies.map((a) => <li key={a}>Allergy: {a}</li>)}
              {patient.data.restrictions.map((r) => <li key={r.id}>{r.text}</li>)}
            </ul>
          </div>
        </Card>
      )}
      <div className="mb-3 flex items-center gap-2">
        <Button size="sm" aria-label="Previous day" onClick={() => shown && setDate(addDays(shown, -1))}><ChevronLeft className="h-4 w-4" aria-hidden /></Button>
        <p className="font-medium text-slate-800">{shown ? new Date(`${shown}T12:00:00Z`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" }) : "…"}</p>
        <Button size="sm" aria-label="Next day" onClick={() => shown && setDate(addDays(shown, 1))}><ChevronRight className="h-4 w-4" aria-hidden /></Button>
        {date && <Button size="sm" variant="ghost" onClick={() => setDate(null)}>Back to today</Button>}
      </div>
      <Async {...tasks} retry={() => tasks.mutate()} rows={5} empty={(d) => (d.tasks.length ? null : <EmptyState title="No tasks on this day">Approved care-plan items generate tasks automatically.</EmptyState>)}>
        {(d) => (
          <div className="space-y-6">
            {GROUPS.map(([label, from, to]) => {
              const rows = d.tasks.filter((t) => {
                const h = Number(t.localTime.slice(0, 2));
                return h >= from && h < to;
              });
              if (!rows.length) return null;
              return (
                <section key={label} aria-label={label}>
                  <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">{label}</h2>
                  <ul className="space-y-2">
                    {rows.map((t) => (
                      <li key={t.id}>
                        <Card className={cx("p-4", !t.covered && !["COMPLETED", "CANCELLED"].includes(t.state) && new Date(t.windowStart) < new Date(new Date(d.now).getTime() + 3 * 3600_000) && "border-l-4 border-l-red-500")}>
                          <div className="flex flex-wrap items-start gap-3">
                            <div className="w-14 shrink-0 text-lg font-semibold text-slate-900">{t.localTime}</div>
                            <div className="min-w-0 flex-1">
                              <Link href={`/tasks/${t.id}`} className="font-medium text-slate-900 underline-offset-2 hover:underline">{t.title}</Link>
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600">
                                <TaskStateBadge state={t.state} />
                                <span>{t.state === "COMPLETED" ? `Done by ${t.completedByName ?? "—"} at ${fmtTime(t.completedAt, tz)}` : t.assigneeName ? `${t.assigneeName}${t.acknowledgedAt ? " · accepted" : " · not yet accepted"}` : "No owner"}</span>
                                <span>· window {fmtTime(t.windowStart, tz)}–{fmtTime(t.windowEnd, tz)}</span>
                                {t.requiredQualification && <span>· needs {t.requiredQualification.replace(/_/g, " ").toLowerCase()}</span>}
                              </div>
                            </div>
                            <TaskActions task={t} />
                          </div>
                        </Card>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </Async>
      {create && <CreateTaskDialog onClose={() => setCreate(false)} />}
    </>
  );
}

function CreateTaskDialog({ onClose }: { onClose: () => void }) {
  const { api: path } = useSession();
  const toast = useToast();
  const [f, setF] = useState({ title: "", category: "ERRAND", priority: "NORMAL", date: new Date().toISOString().slice(0, 10), time: "10:00", requiredQualification: "" });
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="New one-off task" description="Medication instructions can't be created here — they come from verified documents.">
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const offset = "+05:30";
          await api("POST", path("/tasks"), { title: f.title, category: f.category, priority: f.priority, scheduledAt: `${f.date}T${f.time}:00${offset}`, windowMinutesBefore: 30, windowMinutesAfter: 60, requiredQualification: f.requiredQualification || null });
          toast("success", "Task created — it needs an owner");
          onClose();
        } catch (err) {
          toast("error", errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}>
        <div className="sm:col-span-2"><Field label="Title"><input className={inputCls} required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field></div>
        <Field label="Category"><select className={inputCls} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{["ERRAND", "APPOINTMENT", "MEAL", "HYGIENE", "MONITORING", "PHYSIO", "OTHER"].map((c) => <option key={c}>{c}</option>)}</select></Field>
        <Field label="Priority"><select className={inputCls} value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{["LOW", "NORMAL", "HIGH", "CRITICAL"].map((c) => <option key={c}>{c}</option>)}</select></Field>
        <Field label="Date"><input type="date" className={inputCls} required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Time (IST)"><input type="time" className={inputCls} required value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></Field>
        <div className="sm:col-span-2"><Field label="Required qualification (optional)"><input className={inputCls} placeholder="e.g. WOUND_CARE_TRAINED" value={f.requiredQualification} onChange={(e) => setF({ ...f, requiredQualification: e.target.value.toUpperCase() })} /></Field></div>
        <div className="flex justify-end gap-2 sm:col-span-2"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Create</Button></div>
      </form>
    </Modal>
  );
}

/** Remote family view: consolidated status only — no raw messages, documents or actions. */
function RemoteView() {
  const { api: path, patient } = useSession();
  const status = useSWR<Status>(path("/status"), fetcher, { refreshInterval: 30_000 });
  return (
    <>
      <PageHeader title={`How ${patient.displayName} is doing today`} subtitle="Consolidated status for family members who aren't caring hands-on. Private messages and documents are not shown." />
      <Async {...status} retry={() => status.mutate()}>
        {(s) => (
          <div className="space-y-5">
            <CoverageStrip s={s} />
            <Card className="p-4">
              <h2 className="mb-2 font-semibold text-slate-900">Coming up</h2>
              {s.nextTasks.length === 0 ? <p className="text-slate-600">Nothing else scheduled today.</p> : (
                <ul className="divide-y divide-slate-100">
                  {s.nextTasks.map((t) => (
                    <li key={t.id} className="flex flex-wrap items-center gap-2 py-2">
                      <span className="w-12 font-semibold">{t.time}</span><span className="flex-1">{t.title}</span>
                      <TaskStateBadge state={t.state} /><span className="text-sm text-slate-600">{t.assigneeName ?? "No owner yet"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card className="p-4">
              <h2 className="mb-2 font-semibold text-slate-900">Needs attention</h2>
              {s.topAlerts.length === 0 ? <p className="text-slate-600">No open coordination alerts.</p> : (
                <ul className="space-y-2">{s.topAlerts.map((a) => <li key={a.id} className="flex flex-wrap items-center gap-2"><LevelBadge level={a.level} /><Link className="text-teal-800 underline-offset-2 hover:underline" href={`/alerts?id=${a.id}`}>{a.title}</Link></li>)}</ul>
              )}
            </Card>
            {s.lowStock.length > 0 && (
              <Card className="p-4"><h2 className="mb-2 font-semibold text-slate-900">Supplies</h2><ul>{s.lowStock.map((l) => <li key={l.name}>{l.name}: {l.label}</li>)}</ul></Card>
            )}
            <p className="flex items-center gap-2 text-sm text-slate-600"><Ban className="h-4 w-4" aria-hidden /> You can view status only. Ask {patient.displayName}'s representative if you need message access.</p>
          </div>
        )}
      </Async>
    </>
  );
}
