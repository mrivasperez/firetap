import { COMPRESSION_THRESHOLD, USE_NATIVE_COMPRESSION } from "./constants";
import { defaultLogger, type Logger } from "./logger";
import { base64ToUint8Array, uint8ArrayToBase64 } from "./base64";

/**
 * Compress data using native browser CompressionStream API (gzip)
 * Falls back to uncompressed if API not available
 */
export async function compressData(
  data: Uint8Array,
  logger: Logger = defaultLogger
): Promise<{ compressed: Uint8Array; isCompressed: boolean }> {
  // Only compress if browser supports it and data is large enough
  if (!USE_NATIVE_COMPRESSION || data.length < COMPRESSION_THRESHOLD) {
    return { compressed: data, isCompressed: false };
  }

  try {
    // Create a proper ArrayBuffer copy to avoid SharedArrayBuffer type issues
    const arrayBuffer = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength
    ) as ArrayBuffer;
    const stream = new Blob([arrayBuffer]).stream();
    const compressedStream = stream.pipeThrough(new CompressionStream("gzip"));
    const compressedBlob = await new Response(compressedStream).blob();
    const compressed = new Uint8Array(await compressedBlob.arrayBuffer());

    // Only use compression if it actually reduces size
    if (compressed.length < data.length) {
      return { compressed, isCompressed: true };
    }
    return { compressed: data, isCompressed: false };
  } catch (error) {
    logger.warn("Compression failed, sending uncompressed:", error);
    return { compressed: data, isCompressed: false };
  }
}

/**
 * Decompress data using native browser DecompressionStream API (gzip)
 */
export async function decompressData(
  data: Uint8Array,
  logger: Logger = defaultLogger
): Promise<Uint8Array> {
  if (!USE_NATIVE_COMPRESSION) {
    return data;
  }

  try {
    const arrayBuffer = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength
    ) as ArrayBuffer;
    const stream = new Blob([arrayBuffer]).stream();
    const decompressedStream = stream.pipeThrough(
      new DecompressionStream("gzip")
    );
    const decompressedBlob = await new Response(decompressedStream).blob();
    return new Uint8Array(await decompressedBlob.arrayBuffer());
  } catch (error) {
    logger.warn("Decompression failed, treating as uncompressed:", error);
    return data;
  }
}

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
