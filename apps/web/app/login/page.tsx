"use client";
import { useState } from "react";
import useSWR from "swr";
import { LogIn } from "lucide-react";
import { fetcher, errorMessage } from "@/lib/client/api";
import { Button, Field, inputCls } from "@/components/ui";
import { SAFETY_NOTICE } from "@/components/Shell";

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message ?? "Sign-in failed");
}

export default function LoginPage() {
  const demo = useSWR<{ accounts: { email: string; name: string; role: string; relationship: string }[] }>("/api/demo/accounts", (u: string) => fetcher(u).catch(() => null), { shouldRetryOnError: false });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function go(kind: string, fn: () => Promise<void>) {
    setBusy(kind);
    setErr(null);
    try {
      await fn();
      window.location.href = "/";
    } catch (e) {
      setErr(errorMessage(e));
      setBusy(null);
    }
  }

  return (
    <main id="main" tabIndex={-1} className="mx-auto flex min-h-screen max-w-4xl flex-col justify-center gap-8 px-4 py-10 md:flex-row md:items-start focus:outline-none">
      <section className="flex-1" aria-labelledby="signin-h">
        <header>
          <h1 id="signin-h" className="text-3xl font-semibold text-teal-900">CareRelay</h1>
          <p className="mt-1 text-slate-800">No missed care. No ambiguous responsibility. No broken handovers.</p>
        </header>
        <form aria-label="Sign in" className="mt-6 space-y-4 rounded-lg border border-slate-200 bg-white p-5" onSubmit={(e) => (e.preventDefault(), go("pw", () => post("/api/auth/login", { email, password })))}>
          <Field label="Email" id="login-email">
            <input id="login-email" className={inputCls} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Password" id="login-password">
            <input id="login-password" className={inputCls} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {err && <p role="alert" aria-live="assertive" className="text-sm font-medium text-red-800">{err}</p>}
          <Button type="submit" variant="primary" loading={busy === "pw"} className="w-full">
            <LogIn className="h-4 w-4" aria-hidden /> Sign in
          </Button>
        </form>
        <footer role="contentinfo" className="mt-4">
          <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">{SAFETY_NOTICE}</p>
        </footer>
      </section>
      {demo.data?.accounts && (
        <section className="flex-1" aria-labelledby="demo-h">
          <h2 id="demo-h" className="text-lg font-semibold text-slate-900">Demo accounts <span className="text-sm font-normal text-slate-600">(Demo Mode · password “carerelay-demo”)</span></h2>
          <p className="mb-3 text-sm text-slate-700">Synthetic household in Bengaluru caring for “Amma”. One click signs in.</p>
          <ul className="space-y-2">
            {demo.data.accounts.map((a) => (
              <li key={a.email}>
                <button
                  disabled={!!busy}
                  onClick={() => go(a.email, () => post("/api/demo/login", { email: a.email }))}
                  className="w-full min-h-[44px] rounded-lg border border-slate-200 bg-white p-3 text-left transition-colors duration-150 hover:border-teal-700 hover:bg-teal-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-700 disabled:opacity-60"
                >
                  <p className="font-semibold text-slate-900">{a.name}{busy === a.email && " …"}</p>
                  <p className="text-sm text-slate-700">{a.relationship} · {a.role.replace(/_/g, " ").toLowerCase()}</p>
                  <p className="text-xs text-slate-600">{a.email}</p>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
