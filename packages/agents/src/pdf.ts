import { extractText } from "unpdf";

/** Text-layer PDF extraction (no OCR). Pages separated by form feeds so spans stay meaningful. */
export async function pdfToText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  const r = await extractText(bytes, { mergePages: false });
  return { text: r.text.map((p, i) => `--- Page ${i + 1} ---\n${p}`).join("\n\f\n"), pages: r.totalPages };
}
