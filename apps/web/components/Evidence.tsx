"use client";
import Link from "next/link";
import { useState } from "react";
import { FileText, MessageSquare, ListChecks, Pill as PillIcon, CalendarClock, ClipboardList } from "lucide-react";
import { useSession, fmtDateTime } from "@/lib/client/session";
import { SourceViewer, type SourceRef } from "./SourceViewer";

export interface EvidenceRef {
  sourceType: string;
  sourceId: string;
  excerpt: string;
  recordedBy: string | null;
  timestamp: string;
  span?: { start: number; end: number };
  parentSourceType?: "DOCUMENT" | "MESSAGE";
  parentSourceId?: string;
}

const ICONS: Record<string, typeof FileText> = { DOCUMENT: FileText, MESSAGE: MessageSquare, EXTRACTED_ITEM: MessageSquare, TASK: ListChecks, TASK_EVENT: ListChecks, ADMINISTRATION: PillIcon, MEDICATION: PillIcon, AVAILABILITY: CalendarClock, HANDOVER: ClipboardList };

export function EvidenceList({ evidence }: { evidence: EvidenceRef[] }) {
  const { tz, can } = useSession();
  const [open, setOpen] = useState<SourceRef | null>(null);
  return (
    <>
      <ul className="space-y-2">
        {evidence.map((e, i) => {
          const Icon = ICONS[e.parentSourceType ?? e.sourceType] ?? ListChecks;
          const srcType = e.sourceType === "DOCUMENT" ? "DOCUMENT" : e.parentSourceType;
          const srcId = e.sourceType === "DOCUMENT" ? e.sourceId : e.parentSourceId;
          const allowed = srcType === "DOCUMENT" ? can("view_documents") : srcType === "MESSAGE" ? can("view_messages") : false;
          return (
            <li key={i} className="flex gap-3 rounded-md border border-slate-200 bg-slate-50 p-3">
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-[15px] text-slate-800">{e.excerpt}</p>
                <p className="mt-1 text-xs text-slate-500">
                  {e.recordedBy ? `Recorded by ${e.recordedBy} · ` : ""}
                  {fmtDateTime(e.timestamp, tz)}
                </p>
                <div className="mt-1 flex gap-3 text-sm">
                  {srcType && srcId && allowed && (
                    <button className="font-medium text-teal-700 underline-offset-2 hover:underline" onClick={() => setOpen({ type: srcType, id: srcId, span: e.span })}>
                      Open original {srcType === "DOCUMENT" ? "document" : "message"}
                    </button>
                  )}
                  {(e.sourceType === "TASK" || e.sourceType === "TASK_EVENT") && e.sourceType === "TASK" && (
                    <Link className="font-medium text-teal-700 underline-offset-2 hover:underline" href={`/tasks/${e.sourceId}`}>Open task</Link>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <SourceViewer source={open} onClose={() => setOpen(null)} />
    </>
  );
}
