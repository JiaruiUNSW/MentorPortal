import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import type * as Client from "../components/mentor/async-client";
import type * as Api from "../components/mentor/api";
import type { AsyncJob } from "../lib/mentor-data/async-contract";

let client: typeof Client, api: typeof Api, directory: string;
const fetchOriginal = globalThis.fetch;
const payload = { groupId: "synthetic-group", expectedVersion: "before", entries: [{ menteeId: "synthetic-mentee", attended: true, expectedVersion: "before" }] };
const job: AsyncJob = { id: "synthetic-job", operation: "attendance.save", groupId: payload.groupId, status: "queued", requestId: "synthetic-request", createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z", attachments: [], canRetry: false, intent: { operation: "attendance.save", payload } };
const envelope = { schemaVersion: "1.0", requestId: "synthetic-request", ok: true };

before(async () => {
  // These two browser clients have no runtime package imports. Transpile in a private temp folder.
  directory = await mkdtemp(join(tmpdir(), "mentor-async-client-"));
  for (const name of ["api", "async-client"]) {
    const source = await readFile(new URL(`../components/mentor/${name}.ts`, import.meta.url), "utf8");
    const compiled = stripTypeScriptTypes(source, { mode: "transform" }).replace('from "./api"', 'from "./api.mjs"');
    await writeFile(join(directory, `${name}.mjs`), compiled, { mode: 0o600 });
  }
  api = await import(pathToFileURL(join(directory, "api.mjs")).href);
  client = await import(pathToFileURL(join(directory, "async-client.mjs")).href);
});
afterEach(() => { globalThis.fetch = fetchOriginal; });
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

test("async attendance preserves Prefer, CSRF and the same request key through CSRF refresh", async () => {
  const calls: { path: string; init?: RequestInit }[] = [];
  let attempts = 0;
  globalThis.fetch = async (input, init) => {
    calls.push({ path: String(input), init });
    if (String(input) === "/api/auth/session") return Response.json({ user: null, mode: "live", csrfToken: "synthetic-csrf-refreshed" }, { status: 401 });
    if (++attempts === 1) return Response.json({ error: { code: "CSRF_INVALID", message: "Synthetic expired token" } }, { status: 403 });
    return Response.json({ ...envelope, accepted: true, data: { job } }, { status: 202 });
  };
  const result = await client.submitAsync("attendance.save", payload, "synthetic-stable-key");
  assert.equal(result.accepted, true);
  const writes = calls.filter(call => call.path === "/api/mentor");
  assert.equal(writes.length, 2);
  for (const call of writes) {
    assert.equal(new Headers(call.init?.headers).get("Prefer"), "respond-async");
    assert.equal(call.init?.credentials, "same-origin");
    assert.equal(JSON.parse(String(call.init?.body)).idempotencyKey, "synthetic-stable-key");
  }
  assert.equal(new Headers(writes[1].init?.headers).get("X-CSRF-Token"), "synthetic-csrf-refreshed");
});

test("feature-off synchronous response remains a final result and ordinary helper never opts in", async () => {
  const data = { group: { id: "synthetic-group" }, mentees: [] };
  const headers: Headers[] = [];
  globalThis.fetch = async (_input, init) => { headers.push(new Headers(init?.headers)); return Response.json({ ...envelope, data }); };
  assert.deepEqual(await client.submitAsync("attendance.save", payload, "async-key"), { accepted: false, data });
  assert.deepEqual(await api.mentorRequest("attendance.save", payload, "ordinary-key"), data);
  assert.equal(headers[0].get("Prefer"), "respond-async");
  assert.equal(headers[1].has("Prefer"), false);
});

test("acceptance for a different operation or group is not shown as this update", async () => {
  globalThis.fetch = async () => Response.json({ ...envelope, accepted: true, data: { job: { ...job, groupId: "another-group" } } }, { status: 202 });
  await assert.rejects(client.submitAsync("attendance.save", payload, "key"), { code: "RESPONSE_UNCONFIRMED" });
});

test("job restoration consumes every page and keeps polling as read-only HTTP GET", async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push(String(input)); assert.equal(init?.method, "GET"); assert.equal(init?.body, undefined);
    return Response.json({ ...envelope, data: calls.length === 1 ? { items: [job], nextCursor: "opaque/cursor" } : { items: [{ ...job, id: "job-two" }], nextCursor: null } });
  };
  assert.deepEqual((await client.loadAsyncJobs()).map(item => item.id), [job.id, "job-two"]);
  assert.deepEqual(calls, ["/api/mentor/jobs", "/api/mentor/jobs?cursor=opaque%2Fcursor"]);
});

test("broken pagination errors instead of treating partial restoration as complete", async () => {
  globalThis.fetch = async () => Response.json({ ...envelope, data: { items: [job], nextCursor: "repeated" } });
  await assert.rejects(client.loadAsyncJobs(), /fully loaded/);
});

test("safe retry addresses the saved job and never creates a replacement mutation key", async () => {
  let observed: { input: string; init?: RequestInit } | undefined;
  globalThis.fetch = async (input, init) => { observed = { input: String(input), init }; return Response.json({ ...envelope, accepted: true, data: { job } }, { status: 202 }); };
  assert.deepEqual(await client.retryAsyncJob("synthetic-job"), job);
  assert.equal(observed?.input, "/api/mentor/jobs/synthetic-job/retry");
  assert.equal(observed?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(observed?.init?.body)), {});
  assert.equal(new Headers(observed?.init?.headers).get("X-CSRF-Token"), "synthetic-csrf-refreshed");
});
