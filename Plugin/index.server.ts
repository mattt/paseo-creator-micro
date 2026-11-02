import type { PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { describeError } from "./server/bridge-client";
import { KeypadController, type ControllerOptions } from "./server/controller";
import { reconnectRpc, statusRpc } from "./shared/rpc";
import { keypadSettings } from "./shared/settings";

function log(message: string): void {
  console.log(`[creator-micro] ${message}`);
}

/** How long to wait before reading settings again after a read fails; doubles up to the maximum. */
const SETTINGS_RETRY_MS = 5_000;
const SETTINGS_RETRY_MAX_MS = 60_000;

/**
 * Registers the plugin's daemon code. `options` overrides parts of the controller, for tests.
 *
 * Keypad actions stay off until valid settings arrive. A fresh install reads as valid
 * defaults, because Paseo parses a missing settings document as `{}`; so does a reset.
 * Invalid stored settings and read failures turn actions off and report the error
 * instead of falling back to the defaults.
 */
export function contributeKeypad(
  server: PluginServerContext,
  options: Partial<ControllerOptions> = {},
) {
  const controller = new KeypadController({ log, ...options });
  const settings = server.registerSettings(keypadSettings);

  let notified = false;
  let stopped = false;
  let retryTimer: NodeJS.Timeout | null = null;

  function applySettings(state: Awaited<ReturnType<typeof settings.read>>): void {
    if (state.status === "ready") controller.applySettings(state.values);
    else controller.settingsFailed(`The stored settings are invalid: ${state.error}`);
  }

  // A change notification is newer than any read that is still in flight.
  const removeSettingsListener = settings.subscribe((state) => {
    notified = true;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    applySettings(state);
  });

  function load(retryMs: number): void {
    settings.read().then(
      (state) => {
        if (!notified && !stopped) applySettings(state);
      },
      (error: unknown) => {
        if (notified || stopped) return;
        controller.settingsFailed(`Could not read the settings: ${describeError(error)}`);
        retryTimer = setTimeout(() => {
          retryTimer = null;
          load(Math.min(retryMs * 2, SETTINGS_RETRY_MAX_MS));
        }, retryMs);
        retryTimer.unref();
      },
    );
  }
  load(SETTINGS_RETRY_MS);

  // The server context has no Paseo API of its own. Handlers and hooks receive the
  // plugin's one API, whose connection lasts until the plugin stops, so the first
  // handler or hook to run gives it to the controller. The client entry calls the
  // status RPC as soon as the Paseo app connects.
  const attach = ({ paseo }: Pick<PluginHookContext, "paseo">) => controller.attachPaseo(paseo);

  server.handle(statusRpc, (_input, context) => {
    attach(context);
    return controller.status();
  });
  server.handle(reconnectRpc, (_input, context) => {
    attach(context);
    return { ok: controller.reconnect() };
  });

  const removeHooks = [
    server.on("agent.permission_requested", (event, context) => {
      attach(context);
      controller.notePermissionRequest(event.agent.id, event.request.id);
    }),
    server.on("agent.archived", (event, context) => {
      attach(context);
      controller.forgetAgent(event.agent.id);
    }),
    server.on("agent.created", (_event, context) => attach(context)),
    server.on("agent.turn_started", (_event, context) => attach(context)),
    server.on("agent.turn_ended", (_event, context) => attach(context)),
    server.on("agent.permission_resolved", (_event, context) => attach(context)),
    server.on("agent.closed", (_event, context) => attach(context)),
    server.on("workspace.archived", (event, context) => {
      attach(context);
      controller.forgetWorkspace(event.workspace.id);
    }),
    server.on("workspace.created", (_event, context) => attach(context)),
  ];

  controller.start();

  return async () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    for (const remove of removeHooks) remove();
    await removeSettingsListener();
    await controller.stop();
  };
}

export default function contribute(server: PluginServerContext) {
  return contributeKeypad(server);
}
