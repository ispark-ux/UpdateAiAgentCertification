import fsp from "fs/promises";
import path from "path";
import {
  PROCESSES_DIR,
  RESULTS_DIR,
  SESSIONS_FILE,
  AGENTS_FILE,
  SETTINGS_FILE,
  EMAIL_LOGS_FILE,
  ensureStorage,
  readJson,
  writeJsonAtomic,
  updateJson,
  resultFile,
  recordingDir,
  recordingFile,
  recordingMetadataFile,
  fileStat,
  withLock,
  assertValidSessionId,
  nowIso,
} from "../storage";

/**
 * JSON-file repository (used when Supabase is not configured).
 * Same interface as supabase-repo.js.
 */
export const mode = "json";

export async function ensureSeed() {
  ensureStorage();
}

export async function ping() {
  ensureStorage();
  return { ok: true };
}

// ---------------------------------------------------------------- processes
function processFile(processId) {
  return path.join(PROCESSES_DIR, `${String(processId).toLowerCase()}.json`);
}

export async function listProcesses() {
  ensureStorage();
  let files = [];
  try {
    files = (await fsp.readdir(PROCESSES_DIR)).filter((f) => f.toLowerCase().endsWith(".json"));
  } catch {
    files = [];
  }
  const out = [];
  for (const file of files) {
    try {
      const data = await readJson(path.join(PROCESSES_DIR, file), null);
      if (data && data.process_id) out.push(data);
    } catch (err) {
      console.error(`[processes] Failed to parse ${file}:`, err.message);
    }
  }
  return out;
}

export async function getProcess(processId) {
  if (!processId) return null;
  const wanted = String(processId).trim().toLowerCase();
  const direct = await readJson(processFile(wanted), null);
  if (direct && direct.process_id) return direct;
  const all = await listProcesses();
  return all.find((p) => String(p.process_id).toLowerCase() === wanted) || null;
}

export async function saveProcess(process) {
  ensureStorage();
  await writeJsonAtomic(processFile(process.process_id), process);
  return process;
}

export async function deleteProcess(processId) {
  try {
    await fsp.unlink(processFile(processId));
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

// ---------------------------------------------------------------- agents
export async function listAgents({ process_id } = {}) {
  const agents = (await readJson(AGENTS_FILE, [])) || [];
  const list = Array.isArray(agents) ? agents : [];
  return (process_id ? list.filter((a) => a.process_id === process_id) : list).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export async function getAgent(agentId) {
  const agents = await listAgents();
  return agents.find((a) => a.id === agentId) || null;
}

export async function saveAgent(agent) {
  await updateJson(AGENTS_FILE, [], (agents) => {
    const list = Array.isArray(agents) ? agents : [];
    const idx = list.findIndex((a) => a.id === agent.id);
    if (idx === -1) list.push(agent);
    else list[idx] = agent;
    return list;
  });
  return agent;
}

export async function deleteAgent(agentId) {
  let removed = false;
  await updateJson(AGENTS_FILE, [], (agents) => {
    const list = Array.isArray(agents) ? agents : [];
    const next = list.filter((a) => a.id !== agentId);
    removed = next.length !== list.length;
    return next;
  });
  return removed;
}

// ---------------------------------------------------------------- sessions
export async function listSessions({ limit = 200 } = {}) {
  ensureStorage();
  const sessions = (await readJson(SESSIONS_FILE, [])) || [];
  return [...(Array.isArray(sessions) ? sessions : [])].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit);
}

export async function listSessionsLite({ limit = 5000 } = {}) {
  const sessions = await listSessions({ limit });
  return sessions.map(({ transcript, client_log, ...rest }) => rest);
}

export async function listResults({ limit = 5000 } = {}) {
  let files = [];
  try {
    files = (await fsp.readdir(RESULTS_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files.slice(-limit)) {
    const r = await readJson(path.join(RESULTS_DIR, f), null).catch(() => null);
    if (!r || !r.session_id) continue;
    const sa = r.screen_analysis;
    out.push({
      session_id: r.session_id,
      process_id: r.process_id,
      agent_name: r.agent_name,
      agent_email: r.agent_email,
      total_marks: r.total_marks,
      maximum_marks: r.maximum_marks,
      applicable_marks: r.applicable_marks,
      percentage: r.percentage,
      passed: r.passed,
      ztp_failed: r.ztp_failed,
      counts: r.counts,
      groups: r.groups,
      parameters: r.parameters,
      evidence_sources: r.evidence_sources,
      evaluated_at: r.evaluated_at,
      screen_analysis: sa && sa.analyzed ? { analyzed: true, verification: sa.verification || [], cross_check: sa.cross_check || null, portal_verdict: sa.portal_verdict || null, crm_verdict: sa.crm_verdict || null } : null,
    });
  }
  return out;
}

export async function getSession(sessionId) {
  assertValidSessionId(sessionId);
  const sessions = (await readJson(SESSIONS_FILE, [])) || [];
  return (Array.isArray(sessions) ? sessions : []).find((s) => s.session_id === sessionId) || null;
}

export async function createSession(session) {
  ensureStorage();
  await updateJson(SESSIONS_FILE, [], (sessions) => {
    const list = Array.isArray(sessions) ? sessions : [];
    list.push(session);
    return list;
  });
  return session;
}

export async function updateSession(sessionId, updater) {
  assertValidSessionId(sessionId);
  let updated = null;
  await updateJson(SESSIONS_FILE, [], (sessions) => {
    const list = Array.isArray(sessions) ? sessions : [];
    const idx = list.findIndex((s) => s.session_id === sessionId);
    if (idx === -1) {
      const err = new Error(`Session ${sessionId} not found`);
      err.status = 404;
      throw err;
    }
    list[idx] = updater(list[idx]) || list[idx];
    updated = list[idx];
    return list;
  });
  return updated;
}

// ---------------------------------------------------------------- results
export async function getResult(sessionId) {
  return readJson(resultFile(sessionId), null);
}

export async function saveResult(result) {
  await writeJsonAtomic(resultFile(result.session_id), result);
  return result;
}

// ---------------------------------------------------------------- settings
export async function getSetting(key) {
  const all = (await readJson(SETTINGS_FILE, {})) || {};
  return all[key] || null;
}

export async function saveSetting(key, value) {
  await updateJson(SETTINGS_FILE, {}, (all) => ({ ...(all || {}), [key]: value }));
  return value;
}

// ---------------------------------------------------------------- email logs
export async function logEmail(entry) {
  const item = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, created_at: nowIso(), ...entry };
  await updateJson(EMAIL_LOGS_FILE, [], (logs) => [...(Array.isArray(logs) ? logs : []).slice(-999), item]);
  return item;
}

export async function listEmailLogs(limit = 100) {
  const logs = (await readJson(EMAIL_LOGS_FILE, [])) || [];
  return (Array.isArray(logs) ? logs : []).slice(-limit).reverse();
}

// ---------------------------------------------------------------- recordings
// Same part-based layout as Supabase: recordings/<SESSION_ID>/<kind>/part-00000.bin ...
// Every upload request carries ONE small part, written straight to its final
// place - no temp files, no server-side assembly (stateless, multi-instance safe).
const PART_RE = /^part-\d{5}\.bin$/;
const partName = (i) => `part-${String(i).padStart(5, "0")}.bin`;
const KIND_RE = /^(screen|audio)$/;

function partsDir(sessionId, kind) {
  if (!KIND_RE.test(kind)) throw Object.assign(new Error("Invalid recording kind"), { status: 400 });
  return path.join(recordingDir(sessionId), kind);
}

/** Local mode has no object storage URLs - parts go through /upload-part. */
export async function createRecordingPartUrls() {
  return null;
}

export async function clearRecordingParts(sessionId, kind) {
  await fsp.rm(partsDir(sessionId, kind), { recursive: true, force: true });
  await fsp.rm(recordingFile(sessionId, kind), { force: true });
}

export async function saveRecordingPart(sessionId, kind, index, buffer) {
  const dir = partsDir(sessionId, kind);
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, partName(index));
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, buffer);
  await fsp.rename(tmp, target);
  return { index, size: buffer.length };
}

export async function listRecordingParts(sessionId, kind) {
  let names = [];
  try {
    names = (await fsp.readdir(partsDir(sessionId, kind))).filter((n) => PART_RE.test(n)).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const st = await fileStat(path.join(partsDir(sessionId, kind), name));
    if (st) out.push({ name, path: `${sessionId}/${kind}/${name}`, size: st.size });
  }
  return out;
}

export async function getRecordingParts(sessionId, kind) {
  const parts = await listRecordingParts(sessionId, kind);
  if (parts.length) {
    let offset = 0;
    return parts.map((p) => {
      const o = { ...p, offset };
      offset += p.size;
      return o;
    });
  }
  const legacy = await fileStat(recordingFile(sessionId, kind));
  return legacy ? [{ name: `${kind}.webm`, path: `${sessionId}/${kind}.webm`, size: legacy.size, offset: 0 }] : [];
}

/** Reads one stored object by its key ("<SESSION>/<kind>/part-00000.bin" or legacy "<SESSION>/<kind>.webm"). */
export async function readRecordingPart(key) {
  const m = /^([A-Z0-9-]+)\/(screen|audio)(?:\/(part-\d{5}\.bin)|\.webm)$/.exec(String(key || ""));
  if (!m) throw Object.assign(new Error("Invalid recording key"), { status: 400 });
  const file = m[3] ? path.join(partsDir(m[1], m[2]), m[3]) : recordingFile(m[1], m[2]);
  return fsp.readFile(file);
}

export async function getRecordingObjectInfo(sessionId, kind) {
  const parts = await getRecordingParts(sessionId, kind);
  if (!parts.length) return null;
  return { size_bytes: parts.reduce((s, p) => s + p.size, 0), parts: parts.length, storage: "local", bucket: null, path: `recordings/${sessionId}/${kind}/` };
}

/** Server-side save of a whole buffer (legacy endpoint) - stored as parts too. */
export async function saveRecording(sessionId, kind, buffer) {
  await clearRecordingParts(sessionId, kind);
  const size = 4 * 1024 * 1024;
  const count = Math.max(1, Math.ceil(buffer.length / size));
  for (let i = 0; i < count; i += 1) await saveRecordingPart(sessionId, kind, i, buffer.subarray(i * size, Math.min(buffer.length, (i + 1) * size)));
  return { storage: "local", path: `recordings/${sessionId}/${kind}/`, parts: count, size_bytes: buffer.length };
}

export async function getRecordingBuffer(sessionId, kind) {
  const parts = await getRecordingParts(sessionId, kind);
  if (!parts.length) return null;
  const bufs = [];
  for (const p of parts) bufs.push(await readRecordingPart(p.path));
  return Buffer.concat(bufs);
}

export async function getRecordingAccess(sessionId, kind) {
  const parts = await getRecordingParts(sessionId, kind);
  if (!parts.length) return null;
  return { type: "parts", parts, size: parts.reduce((s, p) => s + p.size, 0) };
}

export async function writeRecordingMetadata(sessionId, patch) {
  const metaFile = recordingMetadataFile(sessionId);
  return withLock(metaFile, async () => {
    const meta = (await readJson(metaFile, null)) || { session_id: sessionId, recordings: {} };
    const { recordings, ...rest } = patch || {};
    Object.assign(meta, rest);
    meta.recordings = { ...(meta.recordings || {}), ...(recordings || {}) };
    meta.updated_at = nowIso();
    await writeJsonAtomic(metaFile, meta);
    return meta;
  });
}
