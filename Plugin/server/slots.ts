import { WORKSPACE_KEY_COUNT } from "../shared/keypad";
import type { SlotCandidate } from "./workspaces";

export type Slots = readonly (string | null)[];

export const EMPTY_SLOTS: Slots = Array.from({ length: WORKSPACE_KEY_COUNT }, () => null);

/**
 * Assigns workspaces to the six workspace keys. `candidates` are the eligible workspaces.
 *
 * 1. A pinned workspace takes its key while it is eligible.
 * 2. A workspace keeps the key it had until it is archived or leaves the directory,
 *    or a pin takes the key.
 * 3. Free keys, from the lowest, take the most recently active workspaces without a key.
 *
 * A pin on a workspace that is not eligible leaves its key to automatic assignment.
 */
export function assignSlots(
  previous: Slots,
  candidates: readonly SlotCandidate[],
  pins: Slots,
): Slots {
  const eligible = new Map<string, SlotCandidate>();
  for (const candidate of candidates) eligible.set(candidate.id, candidate);

  const slots: (string | null)[] = Array.from({ length: WORKSPACE_KEY_COUNT }, () => null);
  const used = new Set<string>();

  for (let slot = 0; slot < WORKSPACE_KEY_COUNT; slot += 1) {
    const pinned = pins[slot];
    if (pinned && eligible.has(pinned) && !used.has(pinned)) {
      slots[slot] = pinned;
      used.add(pinned);
    }
  }

  for (let slot = 0; slot < WORKSPACE_KEY_COUNT; slot += 1) {
    if (slots[slot] !== null) continue;
    const kept = previous[slot];
    if (kept && eligible.has(kept) && !used.has(kept)) {
      slots[slot] = kept;
      used.add(kept);
    }
  }

  const waiting = [...eligible.values()]
    .filter((candidate) => !used.has(candidate.id))
    .sort((a, b) => b.activityAt - a.activityAt || a.id.localeCompare(b.id));
  let next = 0;
  for (let slot = 0; slot < WORKSPACE_KEY_COUNT && next < waiting.length; slot += 1) {
    if (slots[slot] !== null) continue;
    const candidate = waiting[next];
    next += 1;
    if (candidate) slots[slot] = candidate.id;
  }
  return slots;
}

/** Whether two slot lists hold the same workspaces on the same keys. */
export function sameSlots(a: Slots, b: Slots): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * The keys of the "pinned" mode: each key shows its pinned workspace while it is eligible,
 * and every other key is empty. A workspace pinned to two keys shows on the first.
 */
export function pinnedSlots(candidates: readonly SlotCandidate[], pins: Slots): Slots {
  const eligible = new Set(candidates.map((candidate) => candidate.id));
  const used = new Set<string>();
  return Array.from({ length: WORKSPACE_KEY_COUNT }, (_, slot) => {
    const pinned = pins[slot];
    if (!pinned || !eligible.has(pinned) || used.has(pinned)) return null;
    used.add(pinned);
    return pinned;
  });
}

/**
 * The keys of the "recentAgents" mode: the six most recently active `candidates` (agents),
 * each on a stable key. An agent keeps its key while it stays among the six;
 * an agent that leaves them frees its key for the next one, from the lowest free key.
 */
export function recentSlots(previous: Slots, candidates: readonly SlotCandidate[]): Slots {
  const recent = [...candidates]
    .sort((a, b) => b.activityAt - a.activityAt || a.id.localeCompare(b.id))
    .slice(0, WORKSPACE_KEY_COUNT);
  return assignSlots(previous, recent, EMPTY_SLOTS);
}
