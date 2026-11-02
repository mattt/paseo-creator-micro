import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { JOYSTICK_DIRECTIONS, type ActionInput } from "../shared/keypad";
import type { KeypadStatus } from "../shared/rpc";
import { DEFAULT_SETTINGS, type KeypadSettings } from "../shared/settings";
import {
  planTrigger,
  meterKeys,
  planTopKey,
  step,
  type ActionEnvironment,
  type ActionPlan,
  type ActionResult,
  type PlannedAction,
  type ThinkingChoices,
  type ThinkingNote,
} from "./actions";
import { ActionableWalk, actionState } from "./actionable";
import { agentName, isEligible, isKeypadTarget, type AgentInfo } from "./agents";
import { BridgeClient, BridgeUncertainError, describeError } from "./bridge-client";
import {
  DEFAULT_SOCKET_SUBPATH,
  MAX_SCROLL_LINES,
  onInputLayer,
  type BridgeInput,
  type BridgeKeypadState,
} from "./bridge-protocol";
import { PaseoCli } from "./cli";
import {
  bindingFor,
  describeInput,
  gestureGroup,
  HeldInputs,
  InputMapper,
  triggerFor,
  type ResolvedInput,
  type Gesture,
} from "./input-map";
import { NavigationHistory } from "./history";
import { computeLights, type KeyOverlay, type LightFrame } from "./lights";
import { PaseoSession, type PaseoApi } from "./paseo-session";
import { planRadialSlot, radialMenuCommand, radialTarget, slotBlocker } from "./radial-menu";
import { assignSlots, EMPTY_SLOTS, pinnedSlots, recentSlots, sameSlots, type Slots } from "./slots";
import { TapTracker, topKeys, type TopKeyInfo } from "./top-keys";
import {
  agentsByWorkspace,
  isWorkspaceEligible,
  slotCandidates,
  type WorkspaceInfo,
} from "./workspaces";

/** The bridge socket for a settings value: empty for the default, `~/` for the home directory. */
export function resolveSocketPath(configured: string, home = homedir()): string {
  const value = configured.trim();
  if (value === "") return join(home, DEFAULT_SOCKET_SUBPATH);
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return isAbsolute(value) ? value : join(home, value);
}

function isJoystickDirection(input: ActionInput): boolean {
  return (JOYSTICK_DIRECTIONS as readonly ActionInput[]).includes(input);
}

/** Builds a `paseo://` link that focuses an agent in the Paseo app. */
export function agentLink(serverId: string, agentId: string): string {
  return `paseo://h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(agentId)}`;
}

/** Most keypad actions that may wait to run; inputs beyond it are dropped. */
export const MAX_QUEUED_ACTIONS = 8;

/** How long the thinking meter stays on the workspace keys after the last thinking change. */
export const THINKING_METER_MS = 1500;

/** How long the workspace keys flash the failure light when a thinking change fails. */
export const FAILURE_FLASH_MS = 600;

/** The reason an action stopped before it finished. */
export class ActionCancelled extends Error {
  override readonly name = "ActionCancelled";
}

interface QueuedAction {
  readonly planned: PlannedAction;
  readonly abort: AbortController;
}

export interface ControllerOptions {
  log: (message: string) => void;
  /** Overrides for tests. */
  bridge?: BridgeClient;
  cli?: PaseoCli;
  renderDelayMs?: number;
  /** How long the thinking meter shows; `THINKING_METER_MS` by default. */
  meterMs?: number;
  /** How long the failure flash shows; `FAILURE_FLASH_MS` by default. */
  failureMs?: number;
  home?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Keeps the keypad in step with Paseo.
 *
 * It follows the agents and workspaces through the plugin's Paseo API, assigns
 * workspaces to the workspace keys, sends their lights to the keypad app, and runs
 * the action of each keypad input. It changes nothing in Paseo except in answer to an input.
 *
 * It does nothing with inputs until it has valid settings: it connects to the
 * keypad app only after the first valid settings arrive, and it turns actions
 * off while the stored settings are invalid or cannot be read.
 *
 * Each input's binding and target are fixed when it arrives. Its work then runs
 * in turn, after a check that the target still applies. All input work is cancelled
 * when settings fail, input becomes unavailable, or the controller stops.
 */
export class KeypadController {
  private readonly log: (message: string) => void;
  private readonly bridge: BridgeClient;
  private readonly cli: PaseoCli;
  private readonly mapper = new InputMapper();
  private readonly held = new HeldInputs();
  private readonly renderDelayMs: number;
  private readonly meterMs: number;
  private readonly failureMs: number;
  private readonly home: string | undefined;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** The last valid settings; the defaults stand in only until the first ones arrive. */
  private settings: KeypadSettings = DEFAULT_SETTINGS;
  private settingsState: KeypadStatus["settings"] = { status: "loading", error: null };
  private started = false;
  private session: PaseoSession | null = null;
  private agents: ReadonlyMap<string, AgentInfo> = new Map();
  private workspaces: ReadonlyMap<string, WorkspaceInfo> = new Map();
  /** Eligible agents, and the same agents by workspace; rebuilt when agents change. */
  private eligibleAgents: readonly AgentInfo[] = [];
  private workspaceAgents: ReadonlyMap<string, readonly AgentInfo[]> = new Map();
  /** The workspaces on the top keys in the "workspaces" and "pinned" modes. */
  private slots: Slots = EMPTY_SLOTS;
  /** The agents on the top keys in the "recentAgents" mode. */
  private agentSlots: Slots = EMPTY_SLOTS;
  /** The selected workspace. */
  private selected: string | null = null;
  /**
   * The agent that a tap on a recent agent's key selected, in the selected workspace;
   * a change of the selected workspace forgets it.
   */
  private selectedAgent: string | null = null;
  /** Taps on the recent agents' keys, to tell a double tap. */
  private readonly taps = new TapTracker();
  /**
   * The workspace ID that the app's `hello` returned while nothing was selected,
   * until the plugin knows its workspaces and restores it or drops it; else null.
   */
  private restoring: string | null = null;
  /** Whether the workspace directory has loaded once, so that a missing workspace is really gone. */
  private workspacesLoaded = false;
  /**
   * The selection that the app stores for this connection, from its `hello` or the last
   * `setSelection`; undefined while disconnected, so that nothing is sent then.
   */
  private sentSelection: string | null | undefined = undefined;
  /** The agent that the keypad opened last, for "next agent that needs action". */
  private openedAgent: string | null = null;
  /** The agents that "next agent that needs action" opened in its current round. */
  private readonly walk = new ActionableWalk();
  /**
   * Whether the keypad's Cmd+D shortcuts left dictation on. It records only what the keypad sent,
   * and a lost connection does not change Paseo's dictation, so it is kept across reconnects.
   */
  private dictationOn = false;
  /** The places that the keypad opened, for "go back" and "go forward". */
  private readonly history = new NavigationHistory();
  private readonly permissionSeen = new Map<string, number>();
  /** The keypad's last thinking change of each agent, while its snapshot may lag. */
  private readonly thinkingNotes = new Map<string, ThinkingNote>();
  private permissionSequence = 0;
  /** The thinking meter or the failure flash while either shows on the workspace keys, else null. */
  private overlay: KeyOverlay | null = null;
  private overlayTimer: NodeJS.Timeout | null = null;
  private frame: LightFrame | null = null;
  private sentKeys: string | null = null;
  /** The keys that the last `setKeyLights` gave a light, so that a key that loses its light is cleared. */
  private sentKeySet: ReadonlySet<number> = new Set();
  private sentZones: string | null = null;
  /** The last radial menu command sent on this connection, so that only changes go out. */
  private sentRadialMenu: string | null = null;
  private renderTimer: NodeJS.Timeout | null = null;
  private rendering = false;
  private renderAgain = false;
  private readonly queued: QueuedAction[] = [];
  /** Each accepted talk start reserves one waiting slot for its release. */
  private readonly talkReleases = new Set<Gesture>();
  private active: QueuedAction | null = null;
  private draining: Promise<void> | null = null;
  private lastInput: KeypadStatus["lastInput"] = null;
  private lastAction: KeypadStatus["lastAction"] = null;
  private stopped = false;
  private readonly unsubscribe: (() => void)[] = [];

  constructor(options: ControllerOptions) {
    this.log = options.log;
    this.home = options.home;
    this.renderDelayMs = options.renderDelayMs ?? 50;
    this.meterMs = options.meterMs ?? THINKING_METER_MS;
    this.failureMs = options.failureMs ?? FAILURE_FLASH_MS;
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()));
    this.bridge =
      options.bridge ??
      new BridgeClient({
        socketPath: resolveSocketPath(this.settings.connection.socketPath, this.home),
        log: (message) => this.log(message),
      });
    this.cli =
      options.cli ?? new PaseoCli({ configuredPath: () => this.settings.connection.cliPath });
  }

  start(): void {
    this.unsubscribe.push(
      this.bridge.on("hello", (message) => {
        this.sentKeys = null;
        this.sentKeySet = new Set();
        this.sentZones = null;
        this.sentRadialMenu = null;
        const stored = message.selectedWorkspaceId || null;
        this.sentSelection = stored;
        // A selection that the plugin already has wins; render sends it to the app.
        this.restoring = this.selected === null ? stored : null;
        this.restoreSelection();
        this.scheduleRender();
      }),
      this.bridge.on("state", (state) => {
        if (state !== "connected") this.connectionLost();
      }),
      this.bridge.on("drain", () => {
        if (!this.renderAgain) return;
        this.renderAgain = false;
        this.scheduleRender();
      }),
      this.bridge.on("keypad", (keypad) => this.keypadChanged(keypad)),
      this.bridge.on("input", (input) => this.receiveInput(input)),
    );
    this.started = true;
    if (this.settingsState.status === "ready") this.bridge.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = null;
    if (this.overlayTimer) clearTimeout(this.overlayTimer);
    this.overlayTimer = null;
    this.overlay = null;
    for (const off of this.unsubscribe.splice(0)) off();
    this.cancelWaiting("the plugin stopped");
    this.active?.abort.abort(new ActionCancelled("The plugin stopped"));
    await this.idle();
    if (this.bridge.state === "connected") {
      await this.bridge.request({ type: "clearLights" }, { timeoutMs: 500 }).catch(() => undefined);
    }
    await Promise.all([this.bridge.stop(), this.session?.stop()]);
    this.session = null;
  }

  /**
   * Gives the controller the plugin's Paseo API.
   * The server entry receives it only through handlers and hooks, so the first one to run supplies it.
   */
  attachPaseo(paseo: PaseoApi): void {
    if (this.stopped || this.session?.paseo === paseo) return;
    const previous = this.session;
    this.session = new PaseoSession(paseo, {
      onAgents: (agents) => this.agentsChanged(agents),
      onWorkspaces: (workspaces) => this.workspacesChanged(workspaces),
      log: (message) => this.log(message),
      now: this.now,
    });
    void previous?.stop();
    this.log("Following Paseo agents and workspaces");
    this.session.start();
  }

  get paseoAttached(): boolean {
    return this.session !== null;
  }

  /** Uses valid settings and turns actions on. */
  applySettings(settings: KeypadSettings): void {
    if (this.stopped) return;
    this.settings = settings;
    if (this.settingsState.status === "error") this.log("The settings are valid again");
    this.settingsState = { status: "ready", error: null };
    this.bridge.setSocketPath(resolveSocketPath(settings.connection.socketPath, this.home));
    if (this.started && this.bridge.state === "stopped") this.bridge.start();
    this.reassign();
    this.scheduleRender();
  }

  /**
   * Turns actions off because the settings are invalid or cannot be read.
   * The lights keep the last valid settings; nothing falls back to the defaults.
   */
  settingsFailed(error: string): void {
    if (this.stopped) return;
    if (this.settingsState.error !== error) {
      this.log(`Keypad actions are off until the settings are fixed. ${error}`);
    }
    this.settingsState = { status: "error", error };
    this.cancelInput("the settings are not valid");
  }

  /** Retries the bridge now. */
  reconnect(): boolean {
    this.bridge.retryNow();
    return this.bridge.state !== "stopped";
  }

  /** Records a permission request as soon as a hook reports it, for oldest-first ordering. */
  notePermissionRequest(agentId: string, requestId: string): void {
    const key = `${agentId}\u0000${requestId}`;
    if (!this.permissionSeen.has(key)) this.permissionSeen.set(key, this.nextPermissionOrder());
  }

  /** Drops an agent that a hook reports archived, before the directory catches up. */
  forgetAgent(agentId: string): void {
    this.session?.forget(agentId);
  }

  /** Drops a workspace that a hook reports archived, before the directory catches up. */
  forgetWorkspace(workspaceId: string): void {
    this.session?.forgetWorkspace(workspaceId);
  }

  status(): KeypadStatus {
    const frame = this.frame ?? this.computeFrame();
    const keypad = this.bridge.keypad;
    const { includeSubagents } = this.settings.agents;
    const targets = this.eligibleAgents.filter((agent) => isKeypadTarget(agent, includeSubagents));
    const next = this.nextActionableAgent();
    const radialAgent = radialTarget(this.environment);
    return {
      settings: this.settingsState,
      paseoAttached: this.session !== null,
      bridge: {
        state: this.bridge.state,
        socketPath: this.bridge.socketPath,
        appVersion: this.bridge.appVersion,
        error: this.bridge.state === "connected" ? null : this.bridge.lastError,
      },
      keypad: keypad && {
        connected: keypad.connected,
        transport: keypad.transport ?? null,
        firmware: keypad.firmware ?? null,
        layer: keypad.layer ?? null,
        inputLayers: keypad.inputLayers ?? null,
        battery: keypad.battery ?? null,
        charging: keypad.charging ?? null,
        lightsVisible: keypad.lightsVisible ?? null,
      },
      topKeyMode: this.settings.topKeys.mode,
      keys: this.topKeys().map((info) => {
        const light = frame.keys[info.key];
        return {
          ...info,
          light: light
            ? { color: light.color, effect: light.effect, brightness: light.brightness }
            : { color: "#000000", effect: "off" as const, brightness: 0 },
        };
      }),
      ambient: {
        color: frame.ambient.color,
        effect: frame.ambient.effect,
        brightness: frame.ambient.brightness,
      },
      nextAgent: next && {
        id: next.id,
        name: agentName(next),
        state: actionState(next) ?? "done",
      },
      actionKeys: frame.actionKeys.map(({ key, source, state }) => {
        const light = frame.keys.find((entry) => entry.key === key);
        return {
          key,
          source,
          state,
          light: light
            ? { color: light.color, effect: light.effect, brightness: light.brightness }
            : { color: "#000000", effect: "off" as const, brightness: 0 },
        };
      }),
      radialMenu: {
        enabled: this.settings.radialMenu.enabled,
        target: radialAgent && agentName(radialAgent),
        blockers: this.settings.radialMenu.slots.map((slot) =>
          slotBlocker(slot, this.environment, radialAgent),
        ),
      },
      selectedWorkspaceId: this.selected,
      attentionCount: targets.filter(
        (agent) => agent.requiresAttention || agent.pendingPermissions.length > 0,
      ).length,
      pendingPermissionCount: targets.reduce(
        (count, agent) => count + agent.pendingPermissions.length,
        0,
      ),
      lastInput: this.lastInput,
      lastAction: this.lastAction,
    };
  }

  /** Resolves when no action is waiting or running. */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  /** Now in milliseconds, with a fraction that orders requests seen in the same millisecond. */
  private nextPermissionOrder(): number {
    this.permissionSequence += 1;
    return this.now() + (this.permissionSequence % 1000) / 1000;
  }

  private agentsChanged(agents: ReadonlyMap<string, AgentInfo>): void {
    this.agents = new Map(agents);
    this.eligibleAgents = [...this.agents.values()].filter(isEligible);
    this.workspaceAgents = agentsByWorkspace(this.eligibleAgents);
    if (
      this.selectedAgent !== null &&
      !this.eligibleAgents.some((agent) => agent.id === this.selectedAgent)
    ) {
      this.selectedAgent = null;
    }
    const pending = new Set<string>();
    for (const agent of this.agents.values()) {
      for (const request of agent.pendingPermissions) {
        const key = `${agent.id}\u0000${request.id}`;
        pending.add(key);
        if (!this.permissionSeen.has(key)) this.permissionSeen.set(key, this.nextPermissionOrder());
      }
    }
    for (const key of this.permissionSeen.keys())
      if (!pending.has(key)) this.permissionSeen.delete(key);
    // A note ends once the snapshot shows the change, or a change from elsewhere.
    for (const [agentId, note] of this.thinkingNotes) {
      const agent = this.agents.get(agentId);
      if (!agent || !note.earlier.includes(agent.thinkingOptionId)) {
        this.thinkingNotes.delete(agentId);
      }
    }
    this.reassign();
    this.scheduleRender();
  }

  private workspacesChanged(workspaces: ReadonlyMap<string, WorkspaceInfo>): void {
    this.workspaces = new Map(workspaces);
    this.workspacesLoaded = true;
    const selected = this.selected === null ? undefined : this.workspaces.get(this.selected);
    if (selected === undefined || !isWorkspaceEligible(selected)) {
      this.selected = null;
      this.selectedAgent = null;
    }
    this.restoreSelection();
    this.reassign();
    this.scheduleRender();
  }

  /**
   * Selects the workspace that the app kept across a plugin reload, once the workspaces have
   * loaded, if it still exists and nothing else was selected meanwhile; otherwise drops it,
   * and the next render tells the app.
   */
  private restoreSelection(): void {
    const id = this.restoring;
    if (id === null || !this.workspacesLoaded) return;
    this.restoring = null;
    const workspace = this.workspaces.get(id);
    if (this.selected !== null || workspace === undefined || !isWorkspaceEligible(workspace)) {
      return;
    }
    this.selected = id;
    this.log(`Restored the selected workspace, ${workspace.name}`);
    this.scheduleRender();
  }

  /** Assigns the top keys for the settings' top-key mode. */
  private reassign(): void {
    const { mode } = this.settings.topKeys;
    const candidates = slotCandidates(this.workspaces.values(), this.workspaceAgents);
    const slots =
      mode === "workspaces"
        ? assignSlots(this.slots, candidates, this.settings.pins)
        : mode === "pinned"
          ? pinnedSlots(candidates, this.settings.pins)
          : EMPTY_SLOTS;
    if (!sameSlots(slots, this.slots)) this.slots = slots;
    const agentSlots =
      mode === "recentAgents"
        ? recentSlots(this.agentSlots, this.recentAgentCandidates())
        : EMPTY_SLOTS;
    if (!sameSlots(agentSlots, this.agentSlots)) this.agentSlots = agentSlots;
  }

  /**
   * The agents that the "recentAgents" mode may put on a key: the eligible agents
   * that keypad actions may target, in an eligible workspace, with their latest activity.
   */
  private recentAgentCandidates() {
    const { includeSubagents } = this.settings.agents;
    return this.eligibleAgents
      .filter((agent) => {
        if (!isKeypadTarget(agent, includeSubagents) || agent.workspaceId === null) return false;
        const workspace = this.workspaces.get(agent.workspaceId);
        return workspace !== undefined && isWorkspaceEligible(workspace);
      })
      .map((agent) => ({ id: agent.id, activityAt: agent.activityAt }));
  }

  /** The top keys as the settings' top-key mode shows them. */
  private topKeys(): TopKeyInfo[] {
    return topKeys(this.environment, this.workspaceAgents);
  }

  /**
   * The agent that "open next agent that needs action" would open now, by the same walk,
   * without recording it; null when no agent needs action.
   */
  private nextActionableAgent(): AgentInfo | null {
    const { includeSubagents } = this.settings.agents;
    const targets = this.eligibleAgents.filter((agent) => isKeypadTarget(agent, includeSubagents));
    return this.walk.peek(targets, this.openedAgent, (agentId, requestId) =>
      this.permissionSeenAt(agentId, requestId),
    );
  }

  private permissionSeenAt(agentId: string, requestId: string): number {
    return this.permissionSeen.get(`${agentId}\u0000${requestId}`) ?? Number.POSITIVE_INFINITY;
  }

  private computeFrame(): LightFrame {
    return computeLights(
      this.slots,
      this.workspaces,
      this.eligibleAgents,
      this.workspaceAgents,
      this.selected,
      this.settings.lights,
      {
        overlay: this.overlay,
        includeSubagents: this.settings.agents.includeSubagents,
        nextAgent: this.nextActionableAgent(),
        topKeys: this.topKeys(),
      },
    );
  }

  /** Shows the thinking meter until `meterMs` after the last change, then the workspaces again. */
  private showMeter(position: number, count: number): void {
    const lit = meterKeys(position, count);
    this.showOverlay(lit === 0 ? null : { kind: "meter", lit }, this.meterMs);
  }

  /**
   * Shows an overlay on the workspace keys for `ms`, replacing the one that shows,
   * then the workspaces again. Null shows the workspaces at once.
   */
  private showOverlay(overlay: KeyOverlay | null, ms: number): void {
    if (this.stopped) return;
    if (this.overlayTimer) clearTimeout(this.overlayTimer);
    this.overlayTimer = null;
    this.overlay = overlay;
    if (overlay !== null) {
      this.overlayTimer = setTimeout(() => {
        this.overlayTimer = null;
        this.overlay = null;
        this.scheduleRender();
      }, ms);
      this.overlayTimer.unref();
    }
    this.scheduleRender();
  }

  private keypadChanged(keypad: BridgeKeypadState): void {
    if (!onInputLayer(keypad)) {
      this.cancelInput("the keypad is disconnected or outside its input layers");
    }
    if (keypad.connected) this.scheduleRender();
  }

  private scheduleRender(): void {
    if (this.stopped || this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      void this.render();
    }, this.renderDelayMs);
    this.renderTimer.unref();
  }

  /**
   * Sends the newest lights. At most one frame is in flight; changes in the meantime,
   * or while the socket's buffer is full, are coalesced into the next frame.
   */
  private async render(): Promise<void> {
    if (this.rendering) {
      this.renderAgain = true;
      return;
    }
    const frame = this.computeFrame();
    this.frame = frame;
    // Until the plugin has its Paseo connection it knows no workspaces; leave the keys alone.
    if (this.session === null || this.bridge.state !== "connected") return;
    if (!this.bridge.writable) {
      this.renderAgain = true;
      return;
    }
    const keySet = new Set(frame.keys.map((light) => light.key));
    if ([...this.sentKeySet].some((key) => !keySet.has(key))) {
      // The app keeps every key light until a clear, and a key without a light of its own
      // shows the key backlight, so a key whose light source became "none" needs a clear
      // and every light again.
      // A failed clear leaves the record, so that the next render tries again.
      this.sentKeys = null;
      this.sentZones = null;
      this.rendering = true;
      try {
        await this.bridge.request({ type: "clearLights" });
        this.sentKeySet = new Set();
        this.renderAgain = true;
      } catch (error) {
        this.log(`Could not clear the keypad lights: ${describeError(error)}`);
      } finally {
        this.rendering = false;
      }
      if (this.renderAgain) {
        this.renderAgain = false;
        this.scheduleRender();
      }
      return;
    }
    const keys = JSON.stringify(frame.keys);
    const zones = JSON.stringify([frame.keysZone, frame.ambient]);
    const work: Promise<void>[] = [];
    const radialMenu = radialMenuCommand(this.environment);
    const radialLine = JSON.stringify(radialMenu);
    if (radialLine !== this.sentRadialMenu) {
      // A failure, such as from an app without the radial menu, is not retried
      // until the menu changes or the app connects again.
      this.sentRadialMenu = radialLine;
      work.push(
        this.bridge
          .request(radialMenu)
          .catch((error: unknown) =>
            this.log(`Could not set the radial menu: ${describeError(error)}`),
          ),
      );
    }
    if (keys !== this.sentKeys) {
      this.sentKeys = keys;
      this.sentKeySet = keySet;
      work.push(this.bridge.request({ type: "setKeyLights", lights: [...frame.keys] }));
    }
    if (zones !== this.sentZones) {
      this.sentZones = zones;
      work.push(
        this.bridge.request({ type: "setZones", keys: frame.keysZone, ambient: frame.ambient }),
      );
    }
    if (
      this.restoring === null &&
      this.sentSelection !== undefined &&
      this.selected !== this.sentSelection
    ) {
      // A failure, such as from an app without the command, is not retried
      // until the selection changes or the app connects again.
      this.sentSelection = this.selected;
      work.push(
        this.bridge
          .request({ type: "setSelection", workspaceId: this.selected })
          .catch((error: unknown) =>
            this.log(`Could not store the selection in the keypad app: ${describeError(error)}`),
          ),
      );
    }
    if (work.length === 0) return;
    this.rendering = true;
    try {
      await Promise.all(work);
    } catch (error) {
      this.sentKeys = null;
      this.sentZones = null;
      this.log(`Could not update the keypad lights: ${describeError(error)}`);
    } finally {
      this.rendering = false;
    }
    if (this.renderAgain) {
      this.renderAgain = false;
      this.scheduleRender();
    }
  }

  /** Cancels work and input state that belonged to the old connection. */
  private connectionLost(): void {
    this.renderAgain = false;
    this.sentSelection = undefined;
    this.restoring = null;
    this.cancelInput("the keypad app disconnected");
  }

  private cancelInput(reason: string): void {
    this.held.reset();
    this.mapper.reset();
    this.taps.reset();
    this.cancelWaiting(reason);
    this.active?.abort.abort(new ActionCancelled(reason));
  }

  private receiveInput(input: BridgeInput): void {
    const keypad = this.bridge.keypad;
    if (!onInputLayer(keypad)) return;
    const resolved = this.mapper.resolve(input);
    if (resolved === null || this.stopped) return;
    this.lastInput = { description: describeInput(input), at: new Date(this.now()).toISOString() };
    if (this.settingsState.status !== "ready") {
      this.lastAction = {
        action: "none",
        ok: false,
        message: `Keypad actions are off: ${this.settingsState.error ?? "the settings are loading"}`,
        at: new Date(this.now()).toISOString(),
      };
      return;
    }
    this.accept(this.plan(resolved));
    // Inputs can move in the history, which the navigation keys and the radial menu show.
    this.scheduleRender();
  }

  /** Fixes what an input does, with the bindings, slots, and requests as they are now. */
  private plan(resolved: ResolvedInput): ActionPlan {
    const env = this.environment;
    if (resolved.kind === "workspaceKey") {
      if (resolved.phase !== "press") return { kind: "none" };
      return planTopKey(resolved.slot, env, this.opensAgent(resolved.slot));
    }
    if (resolved.kind === "radialSlot") return planRadialSlot(resolved.slot, env);
    const { input, phase } = resolved;
    // While the radial menu is on, the joystick picks from it, and its directions do nothing.
    if (this.settings.radialMenu.enabled && isJoystickDirection(input)) return { kind: "none" };
    if (phase === "press") {
      const binding = bindingFor(this.settings, input);
      const gesture = this.held.press(input, binding, gestureGroup(this.settings, input));
      return gesture ? planTrigger(triggerFor(binding, "press"), env, gesture) : { kind: "none" };
    }
    if (phase === "release") {
      const gesture = this.held.release(input);
      return gesture
        ? planTrigger(triggerFor(gesture.binding, "release"), env, gesture)
        : { kind: "none" };
    }
    return planTrigger(triggerFor(bindingFor(this.settings, input), "step"), env);
  }

  /**
   * Whether a press of a top key in the "recentAgents" mode opens its agent:
   * always with `topKeys.openOnSingleTap`, else on the second tap of a double tap.
   */
  private opensAgent(key: number): boolean {
    const { mode, openOnSingleTap } = this.settings.topKeys;
    if (mode !== "recentAgents") return false;
    if (openOnSingleTap) return true;
    const agentId = this.agentSlots[key];
    return agentId ? this.taps.tap(key, agentId, this.now()) : false;
  }

  private accept(plan: ActionPlan): void {
    if (plan.kind === "none") return;
    if (plan.kind === "done") {
      this.recordAction(plan.result);
      return;
    }
    const { action, ignoreRepeats } = plan.planned;
    if (
      ignoreRepeats &&
      (this.active?.planned.action === action ||
        this.queued.some((task) => task.planned.action === action))
    ) {
      // A repeat of an action that is still waiting or running would only stack its work,
      // as mashing the dial click would stack bursts of scrolls.
      this.recordAction({ action, ok: true, message: "Ignored: the last one has not finished" });
      return;
    }
    const scroll = plan.planned.scroll;
    const waiting = this.queued.at(-1)?.planned.scroll;
    if (scroll && waiting) {
      // A scroll that has not started, plain or fast, takes this one's lines,
      // so that a fast turn of the dial, held or not, is one scroll rather than a full queue.
      waiting.lines = Math.max(
        -MAX_SCROLL_LINES,
        Math.min(MAX_SCROLL_LINES, waiting.lines + scroll.lines),
      );
      return;
    }
    const thinking = plan.planned.thinking;
    const waitingThinking = this.queued.at(-1)?.planned.thinking;
    if (
      thinking &&
      waitingThinking &&
      waitingThinking.agentId === thinking.agentId &&
      waitingThinking.direction === thinking.direction
    ) {
      // A thinking change that has not started takes this one's steps, so that a fast turn
      // of a dial bound to thinking is one change, not a `paseo` command for each step.
      waitingThinking.steps += thinking.steps;
      return;
    }
    const talk = plan.planned.talk;
    if (talk?.phase === "stop") {
      // A rejected start has no reservation and must not send a stop.
      if (!this.talkReleases.delete(talk.gesture)) return;
    } else if (
      this.queued.length + this.talkReleases.size + (talk?.phase === "start" ? 1 : 0) >=
      MAX_QUEUED_ACTIONS
    ) {
      this.recordAction({
        action: plan.planned.action,
        ok: false,
        message: "Skipped: too many keypad actions are waiting",
      });
      return;
    }
    if (talk?.phase === "start") this.talkReleases.add(talk.gesture);
    this.queued.push({ planned: plan.planned, abort: new AbortController() });
    this.drain();
  }

  private drain(): void {
    if (this.draining || this.stopped) return;
    this.draining = this.runQueued().finally(() => {
      this.draining = null;
      if (this.queued.length > 0) this.drain();
    });
  }

  private async runQueued(): Promise<void> {
    for (let next = this.queued.shift(); next; next = this.queued.shift()) {
      this.active = next;
      try {
        await this.execute(next);
      } finally {
        this.active = null;
      }
    }
  }

  private async execute({ planned, abort }: QueuedAction): Promise<void> {
    if (abort.signal.aborted) return;
    const reason = planned.stale();
    if (reason !== null) {
      this.recordAction({ action: planned.action, ok: false, message: `Skipped: ${reason}` });
      return;
    }
    try {
      const result = await planned.run(this.environment, abort.signal);
      if (result) this.recordAction(result);
    } catch (error) {
      if (abort.signal.aborted && !(error instanceof BridgeUncertainError)) {
        this.log(`${planned.action}: cancelled because ${describeError(abort.signal.reason)}`);
        return;
      }
      this.recordAction({
        action: planned.action,
        ok: false,
        message: describeError(error),
        uncertain: error instanceof BridgeUncertainError,
      });
    }
  }

  /** Cancels every action that has not started. */
  private cancelWaiting(reason: string): void {
    this.talkReleases.clear();
    const dropped = this.queued.splice(0);
    for (const task of dropped) task.abort.abort(new ActionCancelled(reason));
    if (dropped.length > 0) {
      const count = dropped.length === 1 ? "1 waiting action" : `${dropped.length} waiting actions`;
      this.log(`Dropped ${count} because ${reason}`);
    }
  }

  private recordAction(result: ActionResult): void {
    this.lastAction = { ...result, at: new Date(this.now()).toISOString() };
    if (!result.ok) this.log(`${result.action}: ${result.message}`);
  }

  private requireSession(): PaseoSession {
    if (!this.session) {
      throw new Error("The plugin is not connected to Paseo yet. Open the Paseo app once.");
    }
    return this.session;
  }

  private async serverIdFor(agentId: string, signal: AbortSignal): Promise<string> {
    const session = this.requireSession();
    try {
      return await session.serverId();
    } catch (error) {
      signal.throwIfAborted();
      const labeled = this.agents.get(agentId)?.labeledServerId;
      if (labeled) return labeled;
      this.log(`Could not read the server ID from Paseo (${describeError(error)}); asking the CLI`);
      return this.cli.serverId(signal);
    }
  }

  private readonly environment: ActionEnvironment = {
    agents: () => this.eligibleAgents,
    workspaces: () => [...this.workspaces.values()].filter(isWorkspaceEligible),
    slots: () => this.slots,
    agentSlots: () => this.agentSlots,
    selectedWorkspaceId: () => this.selected,
    select: (workspaceId) => {
      // A selection on the keypad replaces one that waits to be restored.
      this.restoring = null;
      if (workspaceId === this.selected) return;
      this.selected = workspaceId;
      this.selectedAgent = null;
      this.scheduleRender();
    },
    selectedAgentId: () => this.selectedAgent,
    selectAgent: (agentId, workspaceId) => {
      this.restoring = null;
      this.selected = workspaceId;
      this.selectedAgent = agentId;
      this.scheduleRender();
    },
    openedAgentId: () => this.openedAgent,
    noteOpened: (agentId) => {
      this.openedAgent = agentId;
      // The next agent that needs action moves past the one just opened.
      this.scheduleRender();
    },
    actionableWalk: () => this.walk,
    dictating: () => this.dictationOn,
    noteDictating: (active) => {
      this.dictationOn = active;
    },
    history: () => this.history,
    settings: () => this.settings,
    permissionSeenAt: (agentId, requestId) => this.permissionSeenAt(agentId, requestId),
    // Commands with effects reset the bridge connection when they time out,
    // so that a late delivery cannot run them after they were reported.
    openAgent: async (agentId, signal) => {
      const serverId = await step(signal, () => this.serverIdFor(agentId, signal));
      signal.throwIfAborted();
      await this.bridge.request(
        { type: "openURL", url: agentLink(serverId, agentId) },
        { resetOnTimeout: true, signal },
      );
    },
    sendShortcut: async (shortcut, signal) => {
      await this.bridge.request(
        {
          type: "sendShortcut",
          bundleID: this.settings.connection.paseoBundleId,
          shortcut,
          activate: true,
        },
        { resetOnTimeout: true, signal },
      );
    },
    scroll: async (lines, signal) => {
      await this.bridge.request(
        {
          type: "scroll",
          bundleID: this.settings.connection.paseoBundleId,
          lines,
          activate: true,
          fromTop: this.settings.scroll.fromTop,
        },
        { resetOnTimeout: true, signal },
      );
    },
    scrollToEdge: async (edge, signal) => {
      await this.bridge.request(
        {
          type: "scroll",
          bundleID: this.settings.connection.paseoBundleId,
          edge,
          activate: true,
          fromTop: this.settings.scroll.fromTop,
        },
        { resetOnTimeout: true, signal },
      );
    },
    showThinkingMeter: (position, count) => this.showMeter(position, count),
    showThinkingFailure: () => this.showOverlay({ kind: "failure" }, this.failureMs),
    thinkingNote: (agentId) => this.thinkingNotes.get(agentId) ?? null,
    noteThinking: (agentId, note) => {
      this.thinkingNotes.set(agentId, note);
    },
    respondToPermission: (agentId: string, requestId: string, response: AgentPermissionResponse) =>
      this.requireSession().respondToPermission(agentId, requestId, response),
    sendPrompt: (agentId, text) => this.requireSession().sendPrompt(agentId, text),
    thinkingChoices: (agent): Promise<ThinkingChoices | null> =>
      this.requireSession().thinkingChoices(agent),
    stopAgent: async (agentId, signal) => {
      await this.cli.stop(agentId, signal);
    },
    setThinking: async (agentId, optionId, signal) => {
      await this.cli.setThinking(agentId, optionId, signal);
    },
    sleep: (ms) => this.sleep(ms),
  };
}
