"use client";
import { useEffect, useState, type ReactNode } from "react";
import { useMe, SessionProvider } from "@/lib/client/session";
import { Shell, SAFETY_NOTICE } from "@/components/Shell";
import { ToastProvider, Skeleton, ErrorState, Modal, Button } from "@/components/ui";

function Onboarding({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(!localStorage.getItem(`cr_onboarded_${userId}`)), [userId]);
  const close = () => {
    localStorage.setItem(`cr_onboarded_${userId}`, "1");
    setOpen(false);
  };
  return (
    <Modal open={open} onOpenChange={(o) => !o && close()} title="Before you start">
      <div className="space-y-3 text-slate-700">
        <p className="rounded-md border border-red-200 bg-red-50 p-3 font-medium text-red-900">{SAFETY_NOTICE}</p>
        <p>CareRelay tracks who owns each care task, whether they accepted it, and whether it was done. It records, compares and flags — it never diagnoses, prescribes, or advises on doses. Medical decisions go to an authorised person.</p>
        <p>Being assigned a task is not the same as accepting it. Tasks only count as covered once the person accepts.</p>
        <div className="flex justify-end"><Button variant="primary" onClick={close}>I understand</Button></div>
      </div>
    </Modal>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.error && !me.data) return <div className="p-6"><ErrorState error={me.error} onRetry={() => me.mutate()} /></div>;
  if (!me.data) return <div className="p-6"><Skeleton rows={5} /></div>;
  return (
    <ToastProvider>
      <SessionProvider me={me.data}>
        <Shell>{children}</Shell>
        <Onboarding userId={me.data.user.id} />
      </SessionProvider>
    </ToastProvider>
  );
}
