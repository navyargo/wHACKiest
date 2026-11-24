"use client";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import useSWR from "swr";
import { fetcher } from "./api";

export interface Me {
  user: { id: string; name: string; email: string };
  patients: { id: string; displayName: string; age: number; timezone: string; role: string; memberId: string; permissions: string[] }[];
  demoMode: boolean;
  now: string;
  ai: { mode: "LIVE" | "MOCK"; label: string; provider: string };
  voiceEnabled: boolean;
  storage: string;
}

interface SessionValue {
  me: Me;
  patient: Me["patients"][number];
  pid: string;
  can: (p: string) => boolean;
  setPatientId: (id: string) => void;
  api: (path: string) => string;
  tz: string;
}

const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ me, children }: { me: Me; children: ReactNode }) {
  const [pid, setPid] = useState<string>(() => me.patients[0]?.id ?? "");
  useEffect(() => {
    const saved = localStorage.getItem("cr_patient");
    if (saved && me.patients.some((p) => p.id === saved)) setPid(saved);
  }, [me.patients]);
  const value = useMemo<SessionValue | null>(() => {
    const patient = me.patients.find((p) => p.id === pid) ?? me.patients[0];
    if (!patient) return null;
    return {
      me,
      patient,
      pid: patient.id,
      can: (p) => patient.permissions.includes(p),
      setPatientId: (id) => {
        localStorage.setItem("cr_patient", id);
        setPid(id);
      },
      api: (path) => `/api/patients/${patient.id}${path}`,
      tz: patient.timezone,
    };
  }, [me, pid]);
  if (!value) return <div className="p-8 text-slate-700">You are not a member of any care circle yet.</div>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession outside SessionProvider");
  return v;
}

export function useMe() {
  return useSWR<Me>("/api/me", fetcher, { refreshInterval: 30_000 });
}

export function fmtTime(iso: string | Date | null | undefined, tz: string) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-IN", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}
export function fmtDateTime(iso: string | Date | null | undefined, tz: string) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-IN", { timeZone: tz, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}
