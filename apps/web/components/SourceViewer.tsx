"use client";
import useSWR from "swr";
import { fetcher } from "@/lib/client/api";
import { useSession, fmtDateTime } from "@/lib/client/session";
import { Async, Modal } from "./ui";

export interface SourceRef { type: "DOCUMENT" | "MESSAGE"; id: string; span?: { start: number; end: number } | null }

/** Opens the original document/message with the matched text highlighted. Permission-checked server-side. */
export function SourceViewer({ source, onClose }: { source: SourceRef | null; onClose: () => void }) {
  const { api, tz } = useSession();
  const q = source?.span && source.span.end > source.span.start ? `?start=${source.span.start}&end=${source.span.end}` : "";
  const swr = useSWR<{ title: string; text: string; at: string; span: { start: number; end: number } | null }>(source ? api(`/sources/${source.type.toLowerCase()}/${source.id}${q}`) : null, fetcher);
  return (
    <Modal open={!!source} onOpenChange={(o) => !o && onClose()} title={swr.data?.title ?? "Source"} wide>
      <Async {...swr} retry={() => swr.mutate()}>
        {(d) => {
          const s = d.span && d.span.end > d.span.start ? d.span : null;
          return (
            <div>
              <p className="mb-2 text-sm text-slate-600">Recorded {fmtDateTime(d.at, tz)}{s ? " · highlighted text is what the item was read from" : ""}</p>
              <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 p-4 font-sans text-[15px] leading-relaxed text-slate-800">
                {s ? (
                  <>
                    {d.text.slice(0, s.start)}
                    <mark className="rounded bg-amber-200 px-0.5 text-slate-900" ref={(el) => el?.scrollIntoView({ block: "center" })}>{d.text.slice(s.start, s.end)}</mark>
                    {d.text.slice(s.end)}
                  </>
                ) : (
                  d.text
                )}
              </pre>
            </div>
          );
        }}
      </Async>
    </Modal>
  );
}
