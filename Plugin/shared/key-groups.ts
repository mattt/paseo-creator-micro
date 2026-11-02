import { ACTION_KEYS, isActionKey, type ActionInput, type ActionKey } from "./keypad";

/**
 * Keys under one keycap, such as a double-wide keycap over keys 11 and 12.
 * Each group acts as one key; see `server/input-map.ts`.
 */
export type KeyGroups = readonly (readonly ActionKey[])[];

function byKey(a: ActionKey, b: ActionKey): number {
  return ACTION_KEYS.indexOf(a) - ACTION_KEYS.indexOf(b);
}

/** Whether no key is in more than one group. */
export function groupsAreDisjoint(groups: KeyGroups): boolean {
  const seen = new Set<ActionKey>();
  for (const group of groups) {
    for (const key of group) {
      if (seen.has(key)) return false;
      seen.add(key);
    }
  }
  return true;
}

/** The inputs that act as one with an input, in key order: its group, else the input alone. */
export function groupOf(groups: KeyGroups, input: ActionInput): readonly ActionInput[] {
  if (!isActionKey(input)) return [input];
  const group = groups.find((members) => members.includes(input));
  return group ? [...group].sort(byKey) : [input];
}

/** The input whose binding a group uses: its first key. An input without a group leads itself. */
export function groupLeader(groups: KeyGroups, input: ActionInput): ActionInput {
  return groupOf(groups, input)[0] ?? input;
}

/** Puts two keys, and the groups they are in, under one keycap. */
export function joinKeys(groups: KeyGroups, a: ActionKey, b: ActionKey): ActionKey[][] {
  const merged = new Set<ActionKey>([a, b]);
  for (const group of groups) {
    if (group.includes(a) || group.includes(b)) for (const key of group) merged.add(key);
  }
  const rest = groups.filter((group) => !group.some((key) => merged.has(key)));
  return [...rest.map((group) => [...group]), [...merged].sort(byKey)];
}
