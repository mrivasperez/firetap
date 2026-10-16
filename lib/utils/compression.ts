import { USE_NATIVE_COMPRESSION } from "./constants";
import { base64ToUint8Array, uint8ArrayToBase64 } from "./base64";

export async function compressText(text: string): Promise<string | null> {
  if (!USE_NATIVE_COMPRESSION) return null;
  const input = new TextEncoder().encode(text);
  const stream = new Blob([input]).stream().pipeThrough(new CompressionStream("gzip"));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  const encoded = uint8ArrayToBase64(compressed);
  return encoded.length < text.length ? encoded : null;
}

export async function decompressText(encoded: string): Promise<string> {
  const bytes = base64ToUint8Array(encoded);
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}
