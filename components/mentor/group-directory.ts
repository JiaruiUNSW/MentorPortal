import type { GroupDto, OperationPayloads, OperationResults } from "@/lib/contracts";

type LoadGroupPage = (payload: OperationPayloads["groups.list"]) => Promise<OperationResults["groups.list"]>;

/** Publish only a complete authorized directory; bootstrap intentionally contains current groups only. */
export async function loadAllGroups(loadPage: LoadGroupPage): Promise<GroupDto[]> {
  const groups = new Map<string, GroupDto>();
  const cursors = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    if (cursor !== undefined) {
      if (!cursor || cursors.has(cursor)) throw new Error("The group list could not be completed. Please try again.");
      cursors.add(cursor);
    }
    const page = await loadPage({ period: "all", limit: 50, ...(cursor === undefined ? {} : { cursor }) });
    for (const group of page.items) groups.set(group.id, group);
    if (page.nextCursor === null) return [...groups.values()];
    cursor = page.nextCursor;
  }
}

/** Coalesce overlapping reads within one signed-in portal instance, without caching across accounts. */
export function createGroupDirectoryLoader(loadPage: LoadGroupPage): () => Promise<GroupDto[]> {
  let inFlight: Promise<GroupDto[]> | null = null;
  return () => {
    inFlight ??= loadAllGroups(loadPage).finally(() => { inFlight = null; });
    return inFlight;
  };
}

export type GroupSelection = { round: string; groupId: string };

/** Derive valid controls after asynchronous updates instead of copying props into state in an effect. */
export function resolveGroupSelection(groups: GroupDto[], selection: GroupSelection, preferredGroupId?: string) {
  const rounds = [...new Set(groups.map(group => group.roundId))];
  const remembered = groups.find(group => group.id === selection.groupId);
  const preferred = groups.find(group => group.id === preferredGroupId);
  const round = rounds.includes(selection.round)
    ? selection.round
    : remembered?.roundId ?? preferred?.roundId ?? rounds[0] ?? "";
  const visible = groups.filter(group => group.roundId === round);
  const group = visible.find(item => item.id === selection.groupId)
    ?? visible.find(item => item.id === preferredGroupId)
    ?? visible[0];
  return { rounds, round, visible, group };
}
