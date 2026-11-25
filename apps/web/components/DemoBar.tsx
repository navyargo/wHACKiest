"use client";
import { useState } from "react";
import useSWR, { mutate } from "swr";
import { Clock, FastForward, Play, RefreshCcw, Rocket, UserRound } from "lucide-react";
import { api, errorMessage, fetcher } from "@/lib/client/api";
import { useSession, fmtDateTime } from "@/lib/client/session";
import { Button, Modal, useToast } from "./ui";

interface ScenarioResult { scenario: { id: number; title: string }; done: string[]; next: { label: string; href: string; asUserEmail?: string; asUserName?: string }[] }

async function switchUser(email: string, href?: string) {
  await api("POST", "/api/demo/login", { email }, { revalidate: false });
  window.location.href = href ?? "/";
}

export function DemoBar() {
  const { me, api: path, tz } = useSession();
  const toast = useToast();
  const state = useSWR<{ now: string; scenarios: { id: number; title: string; summary: string }[] }>("/api/demo/state", fetcher, { refreshInterval: 30_000 });
  const accounts = useSWR<{ accounts: { email: string; name: string; role: string }[] }>("/api/demo/accounts", fetcher);
  const [busy, setBusy] = useState<string | null>(null);
  const [launcher, setLauncher] = useState(false);
  const [result, setResult] = useState<ScenarioResult | null>(null);

  async function run(label: string, fn: () => Promise<unknown>, ok?: (r: unknown) => string) {
    setBusy(label);
    try {
      const r = await fn();
      await mutate(() => true);
      if (ok) toast("success", ok(r));
      return r;
    } catch (e) {
      toast("error", errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  const clock = (body: object, label: string) => run(label, () => api("POST", "/api/demo/clock", body), (r) => `Virtual time is now ${fmtDateTime((r as { now: string }).now, tz)}. ${(r as { alertsCreated: number }).alertsCreated} new alert(s).`);

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-slate-700 bg-slate-900 px-4 py-2 text-sm text-white md:px-6" role="region" aria-label="Demo controls">
      <span className="rounded bg-amber-400 px-2 py-0.5 text-xs font-bold text-slate-950">DEMO MODE</span>
      <span className="inline-flex items-center gap-1.5" aria-live="polite"><Clock className="h-4 w-4 text-slate-300" aria-hidden /> Virtual time: <strong className="text-white">{state.data ? fmtDateTime(state.data.now, tz) : "…"}</strong></span>
      {[["+15 min", { addMinutes: 15 }], ["+1 h", { addMinutes: 60 }], ["08:00", { jumpTo: "08:00" }], ["13:00", { jumpTo: "13:00" }], ["20:00", { jumpTo: "20:00" }]].map(([l, b]) => (
        <button key={l as string} disabled={!!busy} onClick={() => clock(b as object, l as string)} className="inline-flex min-h-[36px] items-center gap-1 rounded border border-slate-500 px-2.5 py-1 text-xs font-medium text-slate-100 hover:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-400 disabled:opacity-50">
          <FastForward className="h-3.5 w-3.5" aria-hidden /> {l as string}
        </button>
      ))}
      <button disabled={!!busy} onClick={() => run("sweep", () => api("POST", path("/sweep")), (r) => { const s = r as { created: unknown[]; resolved: unknown[]; escalated: unknown[] }; return `Sweep: ${s.created.length} new, ${s.resolved.length} resolved, ${s.escalated.length} escalated.`; })} className="inline-flex min-h-[36px] items-center gap-1 rounded border border-slate-500 px-2.5 py-1 text-xs font-medium text-slate-100 hover:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-400 disabled:opacity-50">
        <Play className="h-3.5 w-3.5" aria-hidden /> Run sweep now
      </button>
      <button disabled={!!busy} onClick={() => setLauncher(true)} className="inline-flex min-h-[36px] items-center gap-1 rounded bg-teal-800 px-3 py-1 text-xs font-semibold text-white hover:bg-teal-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-300 disabled:opacity-50">
        <Rocket className="h-3.5 w-3.5" aria-hidden /> Scenarios
      </button>
      <button disabled={!!busy} onClick={() => { if (confirm("Reset all demo data to the seeded state?")) void run("reset", async () => { await api("POST", "/api/demo/reset", undefined, { revalidate: false }); window.location.href = "/"; }); }} className="inline-flex min-h-[36px] items-center gap-1 rounded border border-slate-500 px-2.5 py-1 text-xs font-medium text-slate-100 hover:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-400 disabled:opacity-50">
        <RefreshCcw className="h-3.5 w-3.5" aria-hidden /> Reset demo data
      </button>
      <label className="ml-auto inline-flex items-center gap-1.5">
        <UserRound className="h-4 w-4 text-slate-300" aria-hidden /> <span className="sr-only md:not-sr-only text-slate-200">Acting as</span>
        <select aria-label="Acting as user" className="min-h-[36px] rounded bg-slate-800 border border-slate-600 px-2 py-1 text-white text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-400" value={me.user.email} onChange={(e) => switchUser(e.target.value, window.location.pathname + window.location.search)}>
          {(accounts.data?.accounts ?? [{ email: me.user.email, name: me.user.name, role: "" }]).map((a) => (
            <option key={a.email} value={a.email}>{a.name}{a.role ? ` — ${a.role.replace(/_/g, " ").toLowerCase()}` : ""}</option>
          ))}
        </select>
      </label>

      <Modal open={launcher} onOpenChange={(o) => { setLauncher(o); if (!o) setResult(null); }} title={result ? `Scenario ${result.scenario.id}: ${result.scenario.title}` : "Scenario launcher"} description={result ? undefined : "Each scenario sets up data through the real services and agents (via MCP), then points at the next human action. Reset first for a clean run."} wide>
        {!result ? (
          <ol className="grid gap-2 sm:grid-cols-2">
            {state.data?.scenarios.map((s) => (
              <li key={s.id}>
                <button disabled={!!busy} onClick={async () => { const r = await run(`s${s.id}`, () => api("POST", `/api/demo/scenarios/${s.id}`)); if (r) setResult(r as ScenarioResult); }} className="h-full w-full rounded-md border border-slate-200 p-3 text-left hover:border-teal-600 hover:bg-teal-50 disabled:opacity-60">
                  <p className="font-medium text-slate-900">{s.id}. {s.title} {busy === `s${s.id}` && "…"}</p>
                  <p className="text-sm text-slate-600">{s.summary}</p>
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <div className="space-y-4">
            <div>
              <p className="mb-1 font-medium text-slate-900">What happened</p>
              <ul className="list-disc space-y-1 pl-5 text-slate-700">{result.done.map((d, i) => <li key={i}>{d}</li>)}</ul>
            </div>
            <div>
              <p className="mb-1 font-medium text-slate-900">Next action</p>
              <div className="flex flex-col gap-2">
                {result.next.map((n, i) => (
                  <Button key={i} variant={i === 0 ? "primary" : "secondary"} onClick={() => (n.asUserEmail && n.asUserEmail !== me.user.email ? switchUser(n.asUserEmail, n.href) : (window.location.href = n.href))}>
                    {n.label}{n.asUserName && n.asUserEmail !== me.user.email ? ` (as ${n.asUserName.split(" (")[0]})` : ""}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
