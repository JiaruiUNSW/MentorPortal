import assert from "node:assert/strict";
import { test } from "node:test";
import type { GroupDto, OperationPayloads, OperationResults } from "../lib/contracts";
import type * as Directory from "../components/mentor/group-directory";

const { createGroupDirectoryLoader, loadAllGroups, resolveGroupSelection } = await import(
  new URL("../components/mentor/group-directory.ts", import.meta.url).href
) as typeof Directory;

type GroupPage = OperationResults["groups.list"];

function group(id: string, roundId = "Recent round"): GroupDto {
  return {
    id, roundId, title: `Synthetic ${id}`, version: "1", startDate: "2026-09-20",
    type: "Diploma", mode: "In person", groupStatus: 1, reportEnabled: true,
    mplName: "Synthetic coordinator", mplCommunicationEmail: "", menteeCount: 0, attendedCount: 0,
    week1Reports: 0, meetupReports: 0, completionReports: 0,
    firstAttendanceUpdatedAt: null, attendanceUpdatedAt: null, week1ReportedAt: null,
    firstMeetupReportedAt: null, secondMeetupReportedAt: null, completedAt: null,
  };
}

test("complete authorized directory includes a historical group beyond the first page", async () => {
  const recent = Array.from({ length: 50 }, (_, index) => group(`recent_${index}`));
  const historical = { ...group("historical", "Past round"), startDate: "2020-02-01", groupStatus: 2 };
  const calls: OperationPayloads["groups.list"][] = [];
  const directory = await loadAllGroups(async payload => {
    calls.push(payload);
    return payload.cursor ? { items: [historical], nextCursor: null } : { items: recent, nextCursor: "opaque-page-two" };
  });
  assert.equal(directory.length, 51);
  assert.equal(directory.at(-1)?.id, historical.id);
  assert.deepEqual(calls, [
    { period: "all", limit: 50 },
    { period: "all", limit: 50, cursor: "opaque-page-two" },
  ]);
});

test("no partial directory is returned while a later page is still loading", async () => {
  let finish: (page: GroupPage) => void = () => { throw new Error("Page two was not requested"); };
  const pending = new Promise<GroupPage>(resolve => { finish = resolve; });
  let settled = false;
  const result = loadAllGroups(async payload => payload.cursor ? pending : { items: [group("first")], nextCursor: "second" });
  void result.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  finish({ items: [group("older", "Past round")], nextCursor: null });
  assert.deepEqual((await result).map(item => item.id), ["first", "older"]);
});

test("overlapping callers share one in-flight directory and explicit later refresh can retry", async () => {
  let finish: (page: GroupPage) => void = () => { throw new Error("No request was started"); };
  let calls = 0;
  const pending = new Promise<GroupPage>(resolve => { finish = resolve; });
  const load = createGroupDirectoryLoader(async () => { calls++; return calls === 1 ? pending : { items: [group("refreshed")], nextCursor: null }; });
  const first = load();
  const second = load();
  assert.equal(first, second);
  assert.equal(calls, 1);
  finish({ items: [group("initial")], nextCursor: null });
  await first;
  assert.deepEqual((await load()).map(item => item.id), ["refreshed"]);
  assert.equal(calls, 2);
});

test("a failed later page rejects the whole directory and does not poison retries", async () => {
  const failure = new Error("Synthetic page unavailable");
  let fail = true;
  const load = createGroupDirectoryLoader(async payload => {
    if (!payload.cursor) return { items: [group("first")], nextCursor: "second" };
    if (fail) throw failure;
    return { items: [group("historical", "Past round")], nextCursor: null };
  });
  await assert.rejects(load(), error => error === failure);
  fail = false;
  assert.deepEqual((await load()).map(item => item.id), ["first", "historical"]);
});

test("a repeated continuation cursor fails instead of looping or returning an incomplete list", async () => {
  let calls = 0;
  await assert.rejects(loadAllGroups(async () => {
    calls++;
    return { items: [group("same")], nextCursor: "repeated" };
  }), /could not be completed/);
  assert.equal(calls, 2);
});

test("selection becomes valid when historical groups arrive after an empty initial render", () => {
  const selection = { round: "", groupId: "" };
  assert.equal(resolveGroupSelection([], selection).group, undefined);
  const historical = group("older", "Past round");
  const resolved = resolveGroupSelection([historical], selection);
  assert.equal(resolved.round, "Past round");
  assert.equal(resolved.group?.id, "older");
  assert.deepEqual(resolved.rounds, ["Past round"]);
});

test("an explicit historical round and group survive reordered async data and a current-group preference", () => {
  const oldA = group("old_a", "Past round");
  const oldB = group("old_b", "Past round");
  const recent = group("recent");
  const resolved = resolveGroupSelection([recent, oldB, oldA], { round: "Past round", groupId: "old_a" }, recent.id);
  assert.equal(resolved.round, "Past round");
  assert.equal(resolved.group?.id, "old_a");
  assert.deepEqual(resolved.visible.map(item => item.id), ["old_b", "old_a"]);
});

test("removed group or round selections fall back only to currently authorized groups", () => {
  const recent = group("recent");
  const old = group("old", "Past round");
  const withinRound = resolveGroupSelection([recent, old], { round: "Past round", groupId: "removed" }, recent.id);
  assert.equal(withinRound.group?.id, "old");
  const removedRound = resolveGroupSelection([recent], { round: "Removed round", groupId: "removed" }, recent.id);
  assert.equal(removedRound.round, "Recent round");
  assert.equal(removedRound.group?.id, "recent");
  const empty = resolveGroupSelection([], { round: "Past round", groupId: "old" });
  assert.equal(empty.round, "");
  assert.equal(empty.group, undefined);
});

test("bootstrap's current-group preference selects the initial round without excluding older rounds", () => {
  const historical = group("historical", "Past round");
  const current = group("current", "Recent round");
  const resolved = resolveGroupSelection([historical, current], { round: "", groupId: "" }, current.id);
  assert.equal(resolved.round, "Recent round");
  assert.equal(resolved.group?.id, "current");
  assert.deepEqual(resolved.rounds, ["Past round", "Recent round"]);
});
