import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { createRetryFetch } from "./retry-fetch.js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
}

export const db = createClient(url, key, {
  auth: { persistSession: false },
  global: { fetch: createRetryFetch() },
});
