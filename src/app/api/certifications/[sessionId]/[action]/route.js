import { after } from "next/server";
import { getSession, updateSession, sanitizeTranscript, getResult, SESSION_STATUS } from "@/lib/server/sessions";
import { getProcess } from "@/lib/server/processes";
import { db, assertPersistentStorage } from "@/lib/server/db";
import { isValidSessionId } from "@/lib/server/storage";
import { nowIso } from "@/lib/server/storage";
import { getGeminiConfig, GeminiNotConfiguredError } from "@/lib/server/gemini";
import { sendInviteForSession, sendResultForSession, recertify } from "@/lib/server/certifications";
import { isEvaluationRunning, markEvaluationStarted, startEvaluationJob } from "@/lib/server/evaluation-job";
import { PART_BYTES } from "@/lib/server/db/supabase-repo";
import { errorResponse, json, httpError, readJsonBody, publicBaseUrl } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Evaluation (video analysis) continues after the response via after(); allow long-running work on serverless hosts.
export const maxDuration = 300;

const KINDS = new Set(["screen", "audio"]);

async function loadSessionOr404(sessionId) {
  if (!isValidSessionId(sessionId)) throw httpError("Invalid session id", 400);
  const session = await getSession(sessionId);
  if (!session) throw httpError(`Certification '${sessionId}' not found`, 404);
  return session;
}

// POST /start  { agent_name }
async function handleStart(sessionId, request) {
  assertPersistentStorage();
  const body = await readJsonBody(request);
  const session = await loadSessionOr404(sessionId);
  if (session.status === SESSION_STATUS.COMPLETED) throw httpError("This certification is already completed.", 409);
  const agentName = String(body.agent_name || session.agent_name || "").trim().slice(0, 120) || "Agent";
  const updated = await updateSession(sessionId, (s) => {
    s.agent_name = agentName;
    s.status = SESSION_STATUS.LIVE;
    s.started_at = nowIso();
    s.ended_at = null;
    s.duration_seconds = null;
    s.ended_reason = null;
    s.transcript = [];
    s.transcript_final = false;
    s.error = null;
    s.attempts = (s.attempts || 0) + 1;
    return s;
  });
  return json({ session: updated });
}

// POST /transcript  { transcript, final? }
async function handleTranscript(sessionId, request) {
  const body = await readJsonBody(request);
  await loadSessionOr404(sessionId);
  const transcript = sanitizeTranscript(body.transcript);
  const updated = await updateSession(sessionId, (s) => {
    if (!body.final && Array.isArray(s.transcript) && s.transcript.length > transcript.length) return s; // never shrink
    s.transcript = transcript;
    if (body.final) s.transcript_final = true;
    return s;
  });
  return json({ ok: true, turns: updated.transcript.length });
}

function parseKind(value) {
  const kind = String(value || "").trim();
  if (!KINDS.has(kind)) throw httpError("kind must be 'screen' or 'audio'", 400);
  return kind;
}

/** Persists recording metadata (session + recordings/<id>/metadata.json) after any upload path. */
async function recordRecording(session, kind, { mime, size, stored, meta = {} }) {
  const duration = Number(meta.duration_seconds);
  const info = {
    file: `${kind}.webm`,
    mime_type: mime || (kind === "audio" ? "audio/webm" : "video/webm"),
    size_bytes: size,
    started_at: typeof meta.started_at === "string" ? meta.started_at : null,
    ended_at: typeof meta.ended_at === "string" ? meta.ended_at : null,
    duration_seconds: Number.isFinite(duration) ? Math.round(duration) : null,
    uploaded_at: nowIso(),
    upload_mode: meta.upload_mode || "single",
    storage: stored.storage,
    bucket: stored.bucket || null,
    path: stored.path,
    parts: stored.parts || null,
  };
  await db.writeRecordingMetadata(session.session_id, { session_id: session.session_id, process_id: session.process_id, agent_name: session.agent_name, started_at: session.started_at, recordings: { [kind]: info } });
  const updated = await updateSession(session.session_id, (s) => {
    s.recording = { ...(s.recording || {}), [kind]: info };
    return s;
  });
  return updated.recording[kind];
}

// POST /upload-screen | /upload-audio   (legacy single request, raw webm body - small files only)
async function handleUpload(sessionId, request, kind) {
  assertPersistentStorage();
  const session = await loadSessionOr404(sessionId);
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > RELAY_MAX_BYTES) throw httpError("Recordings must be uploaded in parts - use /upload-url + /upload-part (this client is outdated, reload the page).", 400);
  const buffer = Buffer.from(await request.arrayBuffer());
  if (!buffer.length) throw httpError("Empty upload body", 400);
  const header = (name) => request.headers.get(name) || null;
  const mime = header("content-type") || (kind === "audio" ? "audio/webm" : "video/webm");
  const stored = await db.saveRecording(sessionId, kind, buffer, mime);
  const recording = await recordRecording(session, kind, {
    mime,
    size: buffer.length,
    stored,
    meta: { started_at: header("x-recording-started-at"), ended_at: header("x-recording-ended-at"), duration_seconds: header("x-recording-duration"), upload_mode: "single" },
  });
  return json({ ok: true, recording });
}

// ---------------------------------------------------------------------------
// Upload pipeline (stateless, 413-proof)
//   1. POST /upload-url   { kind, size, part_size?, direct? }
//        clears old parts, returns { part_size, count, parts?: [{ index, url }] }
//        parts[] = signed URLs: the browser PUTs every part straight to Supabase.
//   2. (fallback) POST /upload-part?kind=&index=   raw body <= part_size (max 1 MB
//        by default, hard cap 4 MB < Vercel's 4.5 MB) - written directly as the
//        final part object. No temp files, no assembly, any instance can serve it.
//   3. POST /upload-complete { kind, total_size, meta } - verifies stored bytes.
// ---------------------------------------------------------------------------
const MIN_PART_BYTES = 64 * 1024;
const RELAY_DEFAULT_BYTES = 1024 * 1024;
const RELAY_MAX_BYTES = 4 * 1024 * 1024;
const MAX_RECORDING_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_PARTS = 20000;

async function handleUploadUrl(sessionId, request) {
  assertPersistentStorage();
  const body = await readJsonBody(request);
  await loadSessionOr404(sessionId);
  const kind = parseKind(body.kind);
  const size = Number(body.size);
  if (!Number.isFinite(size) || size <= 0) throw httpError("size is required", 400);
  if (size > MAX_RECORDING_BYTES) throw httpError("Recording is larger than 4 GB.", 400);

  const wantDirect = body.direct !== false;
  const ceiling = wantDirect ? PART_BYTES : RELAY_MAX_BYTES;
  const requested = Number(body.part_size);
  let partSize = Math.round(Math.max(MIN_PART_BYTES, Math.min(ceiling, Number.isFinite(requested) && requested > 0 ? requested : wantDirect ? PART_BYTES : RELAY_DEFAULT_BYTES)));
  if (Math.ceil(size / partSize) > MAX_PARTS) partSize = Math.ceil(size / MAX_PARTS);
  const count = Math.max(1, Math.ceil(size / partSize));

  await db.clearRecordingParts(sessionId, kind);
  let parts = null;
  if (wantDirect) {
    try {
      parts = await db.createRecordingPartUrls(sessionId, kind, count);
    } catch (err) {
      console.warn(`[upload-url] signed URLs unavailable for ${sessionId}/${kind}: ${err.message} - client will relay parts`);
      parts = null;
    }
  }
  return json({
    mode: Array.isArray(parts) && parts.length === count ? "direct" : "relay",
    part_size: partSize,
    count,
    parts: Array.isArray(parts) && parts.length === count ? parts : null,
    relay_part_size: Math.min(partSize, RELAY_MAX_BYTES),
    relay_max_bytes: RELAY_MAX_BYTES,
  });
}

// POST /upload-part?kind=screen&index=0   (raw body = one part)
async function handleUploadPart(sessionId, request) {
  assertPersistentStorage();
  await loadSessionOr404(sessionId);
  const url = new URL(request.url);
  const kind = parseKind(url.searchParams.get("kind"));
  const index = Number(url.searchParams.get("index"));
  if (!Number.isInteger(index) || index < 0 || index >= MAX_PARTS) throw httpError("Invalid part index", 400);
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > RELAY_MAX_BYTES) throw httpError(`Part too large (max ${RELAY_MAX_BYTES} bytes)`, 413);
  const buffer = Buffer.from(await request.arrayBuffer());
  if (!buffer.length) throw httpError("Empty part", 400);
  if (buffer.length > RELAY_MAX_BYTES) throw httpError(`Part too large (max ${RELAY_MAX_BYTES} bytes)`, 413);
  const saved = await db.saveRecordingPart(sessionId, kind, index, buffer);
  return json({ ok: true, ...saved });
}

// POST /upload-complete  { kind, total_size, mime_type, meta }
async function handleUploadComplete(sessionId, request) {
  const body = await readJsonBody(request);
  const session = await loadSessionOr404(sessionId);
  const kind = parseKind(body.kind);
  const mime = String(body.mime_type || (kind === "audio" ? "audio/webm" : "video/webm")).slice(0, 100);
  const meta = body.meta && typeof body.meta === "object" ? body.meta : {};
  const totalSize = Number(body.total_size);
  const info = await db.getRecordingObjectInfo(sessionId, kind);
  if (!info) throw httpError("The uploaded recording was not found in storage. Please retry the upload.", 400);
  if (Number.isFinite(totalSize) && totalSize > 0 && info.size_bytes !== totalSize) {
    throw httpError(`Uploaded recording is incomplete (${info.size_bytes} of ${totalSize} bytes stored). Please retry the upload.`, 400);
  }
  const recording = await recordRecording(session, kind, { mime, size: info.size_bytes, stored: { storage: info.storage, bucket: info.bucket, path: info.path, parts: info.parts }, meta: { ...meta, upload_mode: body.mode || "parts" } });
  return json({ ok: true, recording });
}

// POST /end
async function handleEnd(sessionId, request) {
  const body = await readJsonBody(request);
  const session = await loadSessionOr404(sessionId);
  if (session.status === SESSION_STATUS.COMPLETED) throw httpError("This certification is already completed.", 409);
  const endedAt = typeof body.ended_at === "string" ? body.ended_at : nowIso();
  const transcript = Array.isArray(body.transcript) ? sanitizeTranscript(body.transcript) : null;

  const updated = await updateSession(sessionId, (s) => {
    if (typeof body.started_at === "string") s.started_at = body.started_at;
    if (!s.started_at) s.started_at = s.created_at;
    s.ended_at = endedAt;
    const computed = Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(s.started_at).getTime()) / 1000));
    const provided = Number(body.duration_seconds);
    s.duration_seconds = Number.isFinite(provided) && provided >= 0 ? Math.round(provided) : computed;
    s.ended_reason = String(body.ended_reason || "agent_ended").slice(0, 80);
    if (transcript && (!Array.isArray(s.transcript) || transcript.length >= s.transcript.length)) {
      s.transcript = transcript;
      s.transcript_final = true;
    }
    if (Array.isArray(body.client_log)) s.client_log = body.client_log.slice(-200);
    if (body.screen_upload_error) {
      s.recording = { ...(s.recording || {}), screen: null, screen_error: String(body.screen_upload_error).slice(0, 500) };
    }
    s.status = SESSION_STATUS.ENDED;
    return s;
  });
  await db.writeRecordingMetadata(sessionId, {
    session_id: sessionId,
    process_id: updated.process_id,
    agent_name: updated.agent_name,
    started_at: updated.started_at,
    ended_at: updated.ended_at,
    duration_seconds: updated.duration_seconds,
    ended_reason: updated.ended_reason,
  });
  return json({ ok: true, session: updated });
}

// POST /evaluate  { force? }  -> starts the background pipeline, returns 202; poll GET /api/certifications/{id}
async function handleEvaluate(sessionId, request) {
  const body = await readJsonBody(request);
  const session = await loadSessionOr404(sessionId);
  if (!session.process_id) throw httpError("Session has no process.", 409);
  if (session.status === SESSION_STATUS.COMPLETED && !body.force) {
    const existing = await getResult(sessionId);
    if (existing) return json({ result: existing, session, cached: true });
  }
  if (!session.ended_at && !body.force) throw httpError("End the certification before evaluating.", 409);
  if (!getGeminiConfig().configured) throw new GeminiNotConfiguredError();
  if (!(await getProcess(session.process_id))) throw httpError(`Process '${session.process_id}' not found`, 404);

  if (isEvaluationRunning(session) && !body.force) {
    return json({ queued: true, already_running: true, session }, { status: 202 });
  }

  await markEvaluationStarted(sessionId);
  const baseUrl = publicBaseUrl(request);
  const kickoff = () => startEvaluationJob(sessionId, baseUrl);
  try {
    after(kickoff); // continue after the response is flushed
  } catch {
    kickoff();
  }
  return json({ queued: true, session: await getSession(sessionId) }, { status: 202 });
}

// POST /resend-invite | /resend-result
async function handleResend(sessionId, request, kind) {
  await loadSessionOr404(sessionId);
  const base = publicBaseUrl(request);
  const status = kind === "invite" ? await sendInviteForSession(sessionId, base) : await sendResultForSession(sessionId, base);
  if (status.status === "failed") throw httpError(status.error || status.team?.error || "Email failed", 502);
  if (status.status === "skipped") throw httpError(status.reason || status.team?.reason || "Email skipped - check Email settings and recipients.", 400);
  return json({ ok: true, email: status, session: await getSession(sessionId) });
}

// POST /recertify  { send_email?, force? }
async function handleRecertify(sessionId, request) {
  const body = await readJsonBody(request);
  await loadSessionOr404(sessionId);
  const out = await recertify({ sessionId, sendEmail: body.send_email !== false, baseUrl: publicBaseUrl(request), force: Boolean(body.force), durationMinutes: body.duration_minutes });
  return json({ session: out.session, certification_url: out.url, email: out.email, reused: out.reused, attempt_no: out.attempt_no, max_attempts: out.max_attempts }, { status: 201 });
}

// GET /result
async function handleResult(sessionId) {
  const session = await loadSessionOr404(sessionId);
  const result = await getResult(sessionId);
  if (!result) throw httpError(session.status === SESSION_STATUS.ERROR ? session.error || "Evaluation failed." : "Result not available yet.", 404, "RESULT_NOT_READY");
  return json({ result, session });
}

// GET /recording?type=screen|audio  -> signed URL redirect (Supabase) or file stream with Range (local)
async function handleRecording(sessionId, request) {
  await loadSessionOr404(sessionId);
  const url = new URL(request.url);
  const kind = url.searchParams.get("type") === "audio" ? "audio" : "screen";
  const access = await db.getRecordingAccess(sessionId, kind);
  if (!access) throw httpError(`No ${kind} recording found for this session.`, 404);
  return streamParts(access, kind, request.headers.get("range"));
}

const MAX_RANGE_BYTES = 3 * 1024 * 1024; // every response stays below serverless body limits (Vercel 4.5 MB)

/** Streams a recording stored as parts, with HTTP Range support (video seeking). */
function streamParts(access, kind, range) {
  const mime = kind === "audio" ? "audio/webm" : "video/webm";
  const size = access.size;
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (!range && size > MAX_RANGE_BYTES) {
    end = MAX_RANGE_BYTES - 1; // large file without Range: serve the first window as 206 - players then request the rest
    status = 206;
  } else if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match && match[1] === "" && match[2]) {
      start = Math.max(0, size - parseInt(match[2], 10));
    } else {
      start = match && match[1] ? parseInt(match[1], 10) : 0;
      end = match && match[2] ? parseInt(match[2], 10) : size - 1;
    }
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end) || end >= size) end = size - 1;
    if (start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    end = Math.min(end, start + MAX_RANGE_BYTES - 1); // a shorter 206 is valid; the player requests the rest
    status = 206;
  }
  const wanted = access.parts.filter((p) => p.offset + p.size > start && p.offset <= end);
  let i = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      if (i >= wanted.length) {
        controller.close();
        return;
      }
      const p = wanted[i++];
      try {
        const buf = await db.readRecordingPart(p.path);
        const from = Math.max(0, start - p.offset);
        const to = Math.min(p.size, end - p.offset + 1);
        controller.enqueue(new Uint8Array(buf.subarray(from, to)));
      } catch (err) {
        controller.error(err);
      }
    },
  });
  const headers = { "Content-Type": mime, "Content-Length": String(end - start + 1), "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  return new Response(stream, { status, headers });
}

export async function POST(request, context) {
  try {
    const { sessionId, action } = await context.params;
    switch (action) {
      case "start":
        return await handleStart(sessionId, request);
      case "transcript":
        return await handleTranscript(sessionId, request);
      case "upload-screen":
        return await handleUpload(sessionId, request, "screen");
      case "upload-audio":
        return await handleUpload(sessionId, request, "audio");
      case "upload-url":
        return await handleUploadUrl(sessionId, request);
      case "upload-part":
        return await handleUploadPart(sessionId, request);
      case "upload-complete":
        return await handleUploadComplete(sessionId, request);
      case "end":
        return await handleEnd(sessionId, request);
      case "evaluate":
        return await handleEvaluate(sessionId, request);
      case "recertify":
        return await handleRecertify(sessionId, request);
      case "resend-invite":
        return await handleResend(sessionId, request, "invite");
      case "resend-result":
        return await handleResend(sessionId, request, "result");
      default:
        throw httpError(`Unknown action '${action}'`, 404);
    }
  } catch (err) {
    return errorResponse(err);
  }
}

export async function GET(request, context) {
  try {
    const { sessionId, action } = await context.params;
    switch (action) {
      case "result":
        return await handleResult(sessionId);
      case "recording":
        return await handleRecording(sessionId, request);
      default:
        throw httpError(`Unknown action '${action}'`, 404);
    }
  } catch (err) {
    return errorResponse(err);
  }
}
