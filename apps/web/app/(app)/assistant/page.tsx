"use client";
import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { Bot, Plug, Send, ShieldAlert, Wrench } from "lucide-react";
import { api, errorMessage, fetcher } from "@/lib/client/api";
import { useSession, fmtTime } from "@/lib/client/session";
import { Button, Card, PageHeader, inputCls, useToast, cx } from "@/components/ui";
import { Pill } from "@/components/status";

interface Answer { answer: string; citations: { type: string; id: string; label: string }[]; refused: boolean; toolCalls: { tool: string; ok: boolean; durationMs: number }[]; provider: string }
interface Call { id: string; at: string; tool: string; outcome: string; durationMs: number; actorName: string; argsSummary: string; resultSummary: string; class?: string; transport?: string }
const SUGGESTIONS = ["What still needs attention for Amma tonight?", "Who is covering the 8 pm medicine?", "Why is this alert red?", "Is any medicine running low?", "Should I give another tablet?"];

export default function AssistantPage() {
  const { api: path, tz, me } = useSession();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [chat, setChat] = useState<{ q: string; a?: Answer; err?: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const calls = useSWR<{ calls: Call[] }>(path("/mcp-activity"), fetcher, { refreshInterval: 2_000 });

  async function ask(question: string) {
    if (!question.trim()) return;
    setBusy(true);
    setChat((c) => [...c, { q: question }]);
    setQ("");
    try {
      const a = await api<Answer>("POST", path("/assistant"), { question }, { revalidate: false });
      setChat((c) => c.map((m, i) => (i === c.length - 1 ? { ...m, a } : m)));
      void calls.mutate();
    } catch (e) {
      setChat((c) => c.map((m, i) => (i === c.length - 1 ? { ...m, err: errorMessage(e) } : m)));
      toast("error", errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Care Assistant & MCP activity" subtitle={`Answers come only from CareRelay data, fetched through MCP tools. ${me.ai.mode === "LIVE" ? me.ai.label : "Offline AI mode — rule-based."}`} />
      <div className="grid gap-5 lg:grid-cols-[1fr_26rem]">
        <Card className="flex min-h-[28rem] flex-col p-4">
          <div className="flex-1 space-y-4" aria-live="polite">
            {chat.length === 0 && (
              <div>
                <p className="mb-2 text-slate-600">Try:</p>
                <div className="flex flex-wrap gap-2">{SUGGESTIONS.map((s) => <Button key={s} size="sm" onClick={() => ask(s)}>{s}</Button>)}</div>
              </div>
            )}
            {chat.map((m, i) => (
              <div key={i} className="space-y-2">
                <p className="ml-auto max-w-[85%] rounded-lg bg-teal-700 px-3 py-2 text-white">{m.q}</p>
                {!m.a && !m.err && <p className="text-slate-500">Calling MCP tools…</p>}
                {m.err && <p className="text-red-700">{m.err}</p>}
                {m.a && (
                  <div className={cx("max-w-[95%] rounded-lg border px-3 py-2", m.a.refused ? "border-red-200 bg-red-50" : "border-slate-200 bg-slate-50")}>
                    {m.a.refused && <p className="mb-1 flex items-center gap-1 text-sm font-medium text-red-800"><ShieldAlert className="h-4 w-4" aria-hidden />Clinical question — refused by the medical-content guard</p>}
                    <p className="whitespace-pre-wrap text-[15px] text-slate-900"><Bot className="mr-1 inline h-4 w-4 text-teal-700" aria-hidden />{m.a.answer}</p>
                    {m.a.citations.length > 0 && (
                      <ol className="mt-2 space-y-0.5 text-sm">
                        {m.a.citations.map((c, j) => (
                          <li key={c.id}>[{j + 1}] <Link className="text-teal-800 hover:underline" href={c.type === "TASK" ? `/tasks/${c.id}` : c.type === "ALERT" ? `/alerts?id=${c.id}` : c.type === "DOCUMENT" ? `/documents/${c.id}` : "/inventory"}>{c.type.toLowerCase()}: {c.label}</Link></li>
                        ))}
                      </ol>
                    )}
                    <div className="mt-2 flex flex-wrap gap-1">
                      {m.a.toolCalls.map((t, j) => <Pill key={j} tone={t.ok ? "teal" : "red"} icon={Wrench}>{t.tool} · {t.durationMs} ms</Pill>)}
                      {m.a.toolCalls.length === 0 && <Pill tone="slate">no tools called</Pill>}
                      <span className="text-xs text-slate-500">{m.a.provider}</span>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          <form className="mt-4 flex gap-2" onSubmit={(e) => (e.preventDefault(), ask(q))}>
            <label htmlFor="q" className="sr-only">Ask about Amma's care</label>
            <input id="q" className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about tasks, coverage, alerts, supplies…" />
            <Button type="submit" variant="primary" loading={busy}><Send className="h-4 w-4" aria-hidden /><span className="sr-only">Ask</span></Button>
          </form>
        </Card>
        <div className="space-y-4">
          <Card className="p-4">
            <h2 className="mb-2 flex items-center gap-2 font-semibold text-slate-900"><Plug className="h-4 w-4" aria-hidden />MCP activity (live)</h2>
            <p className="mb-2 text-xs text-slate-500">Every tool call by any agent or MCP client for this patient — from the append-only audit log.</p>
            <ul className="max-h-[32rem] space-y-2 overflow-y-auto">
              {(calls.data?.calls ?? []).map((c) => (
                <li key={c.id} className="rounded-md border border-slate-200 p-2 text-sm">
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="font-mono text-xs text-slate-500">{fmtTime(c.at, tz)}</span>
                    <strong className="font-mono">{c.tool}</strong>
                    <Pill tone={c.outcome === "allowed" ? "green" : "red"}>{c.outcome}</Pill>
                    {c.class && <Pill tone="slate">{c.class}</Pill>}
                    <span className="text-xs text-slate-500">{c.durationMs} ms</span>
                  </div>
                  <p className="truncate text-xs text-slate-600" title={c.argsSummary}>args: {c.argsSummary}</p>
                  <p className="truncate text-xs text-slate-600" title={c.resultSummary}>result: {c.resultSummary}</p>
                  <p className="text-xs text-slate-500">{c.actorName} · {c.transport}</p>
                </li>
              ))}
              {calls.data && calls.data.calls.length === 0 && <li className="text-sm text-slate-500">No MCP calls yet.</li>}
            </ul>
          </Card>
          <Card className="p-4 text-sm text-slate-700">
            <h2 className="mb-1 font-semibold text-slate-900">Connect Claude Desktop or MCP Inspector</h2>
            <p>stdio: <code className="rounded bg-slate-100 px-1">pnpm mcp:stdio</code> with <code className="rounded bg-slate-100 px-1">CARERELAY_MCP_TOKEN</code> set to a demo token (see README). HTTP: <code className="rounded bg-slate-100 px-1">POST /api/mcp</code> with a Bearer token. The caller gets exactly that user's permissions.</p>
          </Card>
        </div>
      </div>
    </>
  );
}
