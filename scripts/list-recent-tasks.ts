#!/usr/bin/env tsx
import "dotenv/config";
import { db } from "../src/db/client.js";

const { data, error } = await db
  .from("tasks")
  .select("id, status, source, updated_at, repo_full_name")
  .order("id", { ascending: false })
  .limit(8);

if (error) throw error;
console.log(JSON.stringify(data, null, 2));
