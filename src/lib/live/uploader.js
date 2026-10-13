import { api, ApiError } from "@/lib/api";

/**
 * 413-proof recording upload.
 *
 * A recording is NEVER sent as one request. It is cut into parts:
 *
 *  1. DIRECT (Supabase): the server hands out one signed URL per part and the
 *     browser PUTs every part straight to Supabase Storage (3 in parallel).
 *     Nothing goes through Vercel, so Vercel's 4.5 MB request limit never applies.
 *     If storage itself answers 413 (bucket file-size limit), the whole upload is
 *     re-planned with half the part size (5 MB → 2.5 MB → … → 64 KB).
 *
 *  2. RELAY (fallback, or local mode): each part (1 MB, never more than 4 MB) is
 *     POSTed to /upload-part, which writes it directly as the final part object.
 *     A 413 from any proxy re-plans with half the part size (down to 64 KB).
 *     Stateless - works on Vercel where every request may hit another instance.
 *
 *  3. /upload-complete verifies the stored byte count equals the recording size.
 *
 * Network / 5xx / 429 errors are retried with exponential back-off.
 */

const MIN_PART = 64 * 1024;
const MAX_RETRIES = 5;
const CONCURRENCY = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt) => Math.min(8000, 700 * 2 ** attempt) + Math.floor(Math.random() * 300);
const retryable = (status) => status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
const isTooLarge = (err) => err && (err.status === 413 || /payload too large|exceeded the maximum allowed size|entity too large/i.test(err.message || ""));

class TooLargeError extends Error {
  constructor(message) {
    super(message);
    this.status = 413;
  }
}

function putToStorage(url, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("x-upsert", "true");
    xhr.timeout = 5 * 60 * 1000;
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      const text = (xhr.responseText || "").slice(0, 200);
      reject(new ApiError(`storage responded ${xhr.status}${text ? `: ${text}` : ""}`, /exceeded the maximum allowed size|payload too large/i.test(text) ? 413 : xhr.status, null));
    };
    xhr.onerror = () => reject(new ApiError("network error (storage)", 0, null));
    xhr.ontimeout = () => reject(new ApiError("timed out (storage)", 0, null));
    xhr.onabort = () => reject(new ApiError("aborted", 0, null));
    xhr.send(blob);
  });
}

/** Runs `send(index, slice, onBytes)` for every part with limited concurrency + retries. */
async function sendParts({ blob, partSize, count, send, report, log, label }) {
  const loaded = new Array(count).fill(0);
  const emit = () => report(loaded.reduce((s, v) => s + v, 0) / blob.size);
  let next = 0;
  let fatal = null;
  const worker = async () => {
    while (next < count && !fatal) {
      const idx = next++;
      const slice = blob.slice(idx * partSize, Math.min(blob.size, (idx + 1) * partSize));
      for (let attempt = 0; ; attempt += 1) {
        try {
          loaded[idx] = 0;
          await send(idx, slice, (n) => {
            loaded[idx] = n;
            emit();
          });
          loaded[idx] = slice.size;
          emit();
          break;
        } catch (err) {
          if (isTooLarge(err)) {
            fatal = new TooLargeError(`${label} part ${idx + 1}/${count} rejected as too large (${Math.round(partSize / 1024)} KB)`);
            return;
          }
          if (retryable(err.status || 0) && attempt < MAX_RETRIES) {
            if (log) log("warn", `${label} part ${idx + 1}/${count} failed (${err.message}) - retry ${attempt + 1}/${MAX_RETRIES}`);
            await sleep(backoff(attempt));
            continue;
          }
          fatal = err;
          fatal.message = `${label} part ${idx + 1}/${count}: ${err.message}`;
          return;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, count) }, worker));
  if (fatal) throw fatal;
}

function metaPayload(meta) {
  return {
    started_at: meta.startedAt || null,
    ended_at: meta.endedAt || null,
    duration_seconds: Number.isFinite(Number(meta.durationSeconds)) ? Math.round(Number(meta.durationSeconds)) : null,
    reason: meta.reason || null,
  };
}

/**
 * Uploads one recording ("screen" | "audio"). Resolves with the stored recording info.
 * onProgress(fraction 0..1, mode "direct" | "relay") is optional.
 */
export async function uploadRecordingResilient({ sessionId, kind, blob, meta = {}, onProgress, log }) {
  if (!blob || blob.size === 0) throw new Error(`No ${kind} recording data to upload.`);
  const mime = blob.type || (kind === "audio" ? "audio/webm" : "video/webm");
  let mode = "direct";
  const report = (f) => onProgress && onProgress(Math.max(0, Math.min(1, f)), mode);
  const complete = async (m) => (await api.completeUpload(sessionId, { kind, mode: m, total_size: blob.size, mime_type: mime, meta: metaPayload(meta) })).recording;

  // ---------------------------------------------------------------- 1. direct to storage
  let partSize = null;
  for (let round = 0; round < 8; round += 1) {
    let plan;
    try {
      plan = await api.getUploadPlan(sessionId, { kind, mime_type: mime, size: blob.size, part_size: partSize, direct: true });
    } catch (err) {
      if (err.status === 503) throw err; // storage not configured (e.g. Vercel without Supabase) - nothing else can work
      if (log) log("warn", `Upload plan failed (${err.message}) - trying relay upload`);
      break;
    }
    if (plan.mode !== "direct" || !plan.parts?.length) break;
    mode = "direct";
    try {
      report(0);
      await sendParts({ blob, partSize: plan.part_size, count: plan.count, label: kind, log, report, send: (i, slice, onBytes) => putToStorage(plan.parts[i].url, slice, onBytes) });
      const rec = await complete("direct");
      if (log) log("info", `${kind} recording uploaded directly to storage (${plan.count} × ${Math.round(plan.part_size / 1024)} KB)`);
      return rec;
    } catch (err) {
      if (err instanceof TooLargeError && plan.part_size > MIN_PART) {
        partSize = Math.max(MIN_PART, Math.floor(plan.part_size / 2));
        if (log) log("warn", `${err.message} - re-uploading with ${Math.round(partSize / 1024)} KB parts`);
        continue;
      }
      if (log) log("warn", `Direct storage upload failed (${err.message}) - switching to relay upload`);
      break;
    }
  }

  // ---------------------------------------------------------------- 2. relay through /upload-part
  mode = "relay";
  partSize = null;
  for (let round = 0; round < 8; round += 1) {
    const plan = await api.getUploadPlan(sessionId, { kind, mime_type: mime, size: blob.size, part_size: partSize, direct: false });
    const size = plan.relay_part_size || plan.part_size;
    const count = Math.max(1, Math.ceil(blob.size / size));
    try {
      report(0);
      await sendParts({ blob, partSize: size, count, label: kind, log, report, send: (i, slice) => api.uploadPart(sessionId, { kind, index: i }, slice) });
      const rec = await complete("relay");
      if (log) log("info", `${kind} recording uploaded via server relay (${count} × ${Math.round(size / 1024)} KB)`);
      return rec;
    } catch (err) {
      if (err instanceof TooLargeError && size > MIN_PART) {
        partSize = Math.max(MIN_PART, Math.floor(size / 2));
        if (log) log("warn", `${err.message} - retrying relay with ${Math.round(partSize / 1024)} KB parts`);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`${kind} upload failed: every request size down to ${MIN_PART / 1024} KB was rejected.`);
}
