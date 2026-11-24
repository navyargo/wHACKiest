"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import useSWR from "swr";
import { FileText, Upload } from "lucide-react";
import { api, errorMessage, fetcher } from "@/lib/client/api";
import { useSession, fmtDateTime } from "@/lib/client/session";
import { Async, Button, Card, EmptyState, Field, Modal, PageHeader, inputCls, useToast } from "@/components/ui";
import { Pill } from "@/components/status";

interface Doc { id: string; kind: string; title: string; documentDate: string; versionGroupId: string; versionNumber: number; isLatestVersion: boolean; createdAt: string; itemCounts: Record<string, number> }

export default function DocumentsPage() {
  const { api: path, can, tz } = useSession();
  const swr = useSWR<{ documents: Doc[] }>(path("/documents"), fetcher);
  const [upload, setUpload] = useState(false);
  return (
    <>
      <PageHeader title="Documents" subtitle="Uploaded prescriptions, discharge papers and instructions. Extracted items stay proposed until a clinical verifier approves them." actions={can("upload_documents") ? <Button variant="primary" onClick={() => setUpload(true)}><Upload className="h-4 w-4" aria-hidden /> Upload</Button> : undefined} />
      <Async {...swr} retry={() => swr.mutate()} empty={(d) => (d.documents.length ? null : <EmptyState title="No documents yet" />)}>
        {(d) => (
          <ul className="space-y-2">
            {d.documents.map((doc) => (
              <li key={doc.id}>
                <Link href={`/documents/${doc.id}`}>
                  <Card className="flex flex-wrap items-center gap-3 p-4 transition-colors duration-150 hover:border-teal-600">
                    <FileText className="h-5 w-5 text-slate-500" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-slate-900">{doc.title} <span className="text-sm font-normal text-slate-500">v{doc.versionNumber}</span></p>
                      <p className="text-sm text-slate-600">{doc.kind.replace(/_/g, " ").toLowerCase()} · dated {fmtDateTime(doc.documentDate, tz).split(",")[0]} · uploaded {fmtDateTime(doc.createdAt, tz)}</p>
                    </div>
                    {!doc.isLatestVersion && <Pill tone="slate">Superseded (kept for history)</Pill>}
                    {(doc.itemCounts.PROPOSED ?? 0) + (doc.itemCounts.AWAITING_VERIFICATION ?? 0) > 0 && <Pill tone="violet">{(doc.itemCounts.PROPOSED ?? 0) + (doc.itemCounts.AWAITING_VERIFICATION ?? 0)} awaiting verification</Pill>}
                    {(doc.itemCounts.APPROVED ?? 0) > 0 && <Pill tone="green">{doc.itemCounts.APPROVED} approved</Pill>}
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Async>
      {upload && <UploadDialog docs={swr.data?.documents ?? []} onClose={() => setUpload(false)} />}
    </>
  );
}

function UploadDialog({ docs, onClose }: { docs: Doc[]; onClose: () => void }) {
  const { api: path } = useSession();
  const toast = useToast();
  const router = useRouter();
  const [f, setF] = useState({ kind: "PRESCRIPTION", title: "", documentDate: new Date().toISOString().slice(0, 10), text: "", versionGroupId: "" });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const groups = docs.filter((d) => d.isLatestVersion);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Upload a document" description="PDFs with a text layer are read automatically. For photos or scans, type or paste the text (image OCR isn't available in this MVP)." wide>
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          let fileBase64: string | undefined;
          if (file) {
            const buf = new Uint8Array(await file.arrayBuffer());
            let bin = "";
            for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
            fileBase64 = btoa(bin);
          }
          const r = await api<{ document: { id: string }; intake: { status: string; items: unknown[]; toolCalls: { tool: string }[] } }>("POST", path("/documents"), { kind: f.kind, title: f.title, documentDate: f.documentDate, text: f.text || undefined, fileBase64, fileName: file?.name, mimeType: file?.type || undefined, versionGroupId: f.versionGroupId || null });
          toast(r.intake.status === "STORED" ? "success" : "error", r.intake.status === "STORED" ? `Intake Agent (via MCP: ${r.intake.toolCalls.map((t) => t.tool).join(", ")}) proposed ${r.intake.items.length} item(s).` : "Extraction needs manual review.");
          router.push(`/documents/${r.document.id}`);
        } catch (err) {
          toast("error", errorMessage(err));
          setBusy(false);
        }
      }}>
        <Field label="Kind"><select className={inputCls} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{["PRESCRIPTION", "DISCHARGE_SUMMARY", "APPOINTMENT", "INSTRUCTION", "OTHER"].map((k) => <option key={k} value={k}>{k.replace(/_/g, " ").toLowerCase()}</option>)}</select></Field>
        <Field label="Document date"><input type="date" className={inputCls} required value={f.documentDate} onChange={(e) => setF({ ...f, documentDate: e.target.value })} /></Field>
        <div className="sm:col-span-2"><Field label="Title"><input className={inputCls} required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field></div>
        <div className="sm:col-span-2"><Field label="New version of (optional)" hint="Choose this to compare against the active instructions from that document (CON-002)."><select className={inputCls} value={f.versionGroupId} onChange={(e) => { const g = groups.find((d) => d.versionGroupId === e.target.value); setF({ ...f, versionGroupId: e.target.value, title: g?.title ?? f.title, kind: g?.kind ?? f.kind }); }}><option value="">— new document —</option>{groups.map((d) => <option key={d.versionGroupId} value={d.versionGroupId}>{d.title} (currently v{d.versionNumber})</option>)}</select></Field></div>
        <div className="sm:col-span-2"><Field label="File (PDF or .txt, optional)"><input type="file" accept="application/pdf,text/plain,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block text-sm" /></Field></div>
        <div className="sm:col-span-2"><Field label="Text (paste or type)"><textarea className={inputCls} rows={8} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} required={!file} /></Field></div>
        <div className="flex justify-end gap-2 sm:col-span-2"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Upload & extract</Button></div>
      </form>
    </Modal>
  );
}
