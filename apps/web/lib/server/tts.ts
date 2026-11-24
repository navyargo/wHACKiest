/** ElevenLabs text-to-speech (LIVE only when ELEVENLABS_API_KEY is set; otherwise callers hide the feature). */
import { storage } from "./storage";

export async function synthesize(text: string): Promise<Uint8Array> {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  if (!key) throw new Error("ElevenLabs is not configured");
  const voice = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2" }),
  });
  if (!res.ok) throw new Error(`ElevenLabs error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Cached per (kind, id, version) so a handover/alert is only synthesised once. */
export async function cachedSpeech(cacheKey: string, text: string): Promise<Uint8Array> {
  const s = storage();
  const k = `audio/${cacheKey}.mp3`;
  const hit = await s.get(k);
  if (hit) return hit;
  const audio = await synthesize(text);
  await s.put(k, audio, "audio/mpeg");
  return audio;
}
