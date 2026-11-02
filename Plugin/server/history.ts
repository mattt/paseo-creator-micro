/** Most places that the history keeps; older ones are forgotten. */
export const MAX_HISTORY = 50;

/** A place that the keypad opened: an agent in its workspace. */
export interface Place {
  readonly workspaceId: string;
  readonly agentId: string;
}

function samePlace(a: Place | undefined, b: Place): boolean {
  return a !== undefined && a.workspaceId === b.workspaceId && a.agentId === b.agentId;
}

/**
 * The places that the keypad opened, oldest first, for "go back" and "go forward",
 * like a browser's history.
 * The current entry is the place that the keypad opened or went back or forward to last,
 * which the plugin takes to be the place that Paseo shows:
 * Paseo does not tell a plugin which workspace or agent the app shows,
 * so the history has only what the keypad opened.
 */
export class NavigationHistory {
  private readonly entries: Place[] = [];
  /** The index of the current entry, or -1 while the history is empty. */
  private index = -1;

  /**
   * Records that the keypad opened a place. Opening the current place again records nothing.
   * A new place after a step back drops the places ahead of the current one, as a browser does.
   */
  visit(place: Place): void {
    if (samePlace(this.entries[this.index], place)) return;
    this.entries.splice(this.index + 1);
    this.entries.push({ workspaceId: place.workspaceId, agentId: place.agentId });
    if (this.entries.length > MAX_HISTORY) {
      this.entries.splice(0, this.entries.length - MAX_HISTORY);
    }
    this.index = this.entries.length - 1;
  }

  /**
   * Steps back to the latest earlier place that `available` accepts, which becomes current,
   * skipping the places that it refuses. The places after it stay, for "go forward".
   * Returns null, and changes nothing, when no earlier place is available.
   */
  back(available: (place: Place) => boolean): Place | null {
    return this.step(-1, available);
  }

  /**
   * Steps forward to the next later place that `available` accepts, which becomes current,
   * skipping the places that it refuses.
   * Returns null, and changes nothing, when no later place is available.
   */
  forward(available: (place: Place) => boolean): Place | null {
    return this.step(1, available);
  }

  /** Whether `back` would find a place, without stepping. */
  canGoBack(available: (place: Place) => boolean): boolean {
    return this.find(-1, available) !== null;
  }

  /** Whether `forward` would find a place, without stepping. */
  canGoForward(available: (place: Place) => boolean): boolean {
    return this.find(1, available) !== null;
  }

  /** The current place, or null while the history is empty. */
  current(): Place | null {
    return this.entries[this.index] ?? null;
  }

  /** The recorded places, oldest first, including those ahead of the current one. */
  list(): readonly Place[] {
    return this.entries.map((place) => ({ ...place }));
  }

  private step(direction: 1 | -1, available: (place: Place) => boolean): Place | null {
    const index = this.find(direction, available);
    if (index === null) return null;
    this.index = index;
    return this.entries[index] ?? null;
  }

  private find(direction: 1 | -1, available: (place: Place) => boolean): number | null {
    if (this.index < 0) return null;
    for (
      let index = this.index + direction;
      index >= 0 && index < this.entries.length;
      index += direction
    ) {
      const place = this.entries[index];
      if (place && available(place)) return index;
    }
    return null;
  }
}
