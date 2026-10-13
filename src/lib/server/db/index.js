import * as jsonRepo from "./json-repo";
import { createSupabaseRepo, supabaseConfig } from "./supabase-repo";

/**
 * Data access entry point. Picks Supabase when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 * are configured, otherwise falls back to local JSON files. All server modules use `db.*`.
 */
let repoInstance = null;

export function getRepo() {
  if (!repoInstance) {
    const cfg = supabaseConfig();
    repoInstance = cfg.configured ? createSupabaseRepo(cfg) : jsonRepo;
    console.log(`[db] Using ${repoInstance.mode} storage${cfg.configured ? ` (${cfg.url})` : ""}`);
  }
  return repoInstance;
}

export const IS_SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);

export function dbInfo() {
  const cfg = supabaseConfig();
  const persistent = cfg.configured || !IS_SERVERLESS;
  return {
    mode: cfg.configured ? "supabase" : "json",
    supabase_url: cfg.configured ? cfg.url : null,
    bucket: cfg.configured ? cfg.bucket : null,
    serverless: IS_SERVERLESS,
    persistent,
    warning: persistent ? null : "This deployment is serverless (Vercel) and Supabase is not configured. Local JSON files and recordings cannot be stored here - set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the Vercel project's Environment Variables and redeploy.",
  };
}

/** Throws a clear 503 when data cannot be persisted (serverless without Supabase). */
export function assertPersistentStorage() {
  const info = dbInfo();
  if (!info.persistent) {
    const err = new Error(info.warning);
    err.status = 503;
    err.code = "STORAGE_NOT_CONFIGURED";
    throw err;
  }
}

export const db = new Proxy(
  {},
  {
    get(_, prop) {
      return (...args) => {
        const repo = getRepo();
        if (typeof repo[prop] !== "function") throw new Error(`db.${String(prop)} is not implemented for ${repo.mode} storage`);
        return repo[prop](...args);
      };
    },
  }
);
