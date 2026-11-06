# Creator Micro for Paseo

This [Paseo](https://paseo.sh) plugin maps the Work Louder Creator Micro 2's
keys, dial, and joystick to Paseo actions and shows agent state with keypad lights.
The six top keys can navigate, select recent agents, or select workspaces.
The settings show each key's current light and action.

See the repository README for [installation and requirements](../README.md#install),
[keypad layers](../README.md#keypad-layers-and-experimental-features),
and [default bindings](../README.md#keys-and-default-bindings).
This document covers selection, action behavior, settings, and plugin development.

## How it works

The plugin's daemon code follows agents and workspaces through the Paseo SDK.
It receives inputs from the companion PaseoMicro app over a local Unix socket
and sends light updates back.
PaseoMicro owns the keypad's USB connection, opens `paseo://` agent links,
sends keyboard shortcuts, and scrolls Paseo's window.
Without the app, the plugin waits and reconnects when it starts.
See [Bridge and MCP](../README.md#bridge-and-mcp) for the socket and protocol.

Apart from reading state and updating lights, actions require keypad input.
Each input uses the binding, workspace, and agent selected when it arrives.
Before a queued action runs, the plugin checks that its target still exists.
If the agent, workspace, or permission request is gone,
it skips the action instead of choosing another target.

The plugin gets its Paseo connection from the first app request or agent event.
Until then, the top keys stay dark and agent actions wait.
Opening Paseo on this Mac is enough to connect.

## Top keys and selection

**Keypad > Top keys** chooses Navigation, Recent agents, Workspaces,
Pinned workspaces, or Off.
The [main configuration guide](../README.md#configuration) describes the modes
and how to open settings.

### Navigation

A navigation key is dim white while it can act and off when it cannot.
Back and forward need a place in the keypad's history;
project and workspace keys need more than one project or workspace.
A disabled key does nothing, and the status says why.

Project keys open the most recently active workspace in the adjacent project
that has an agent to open.
Within that workspace, they choose the agent described under
[Workspaces](#workspaces).
Projects count only while they have a workspace that is not archived,
background, or internal.
Their name order ignores case and treats numbers numerically;
the keys wrap from the last project to the first.

The current project comes from the selected workspace,
else the last place opened with the keypad.
Without either, next project opens the first project and previous project the last.
Workspace shortcuts do not report which workspace Paseo opened,
so they do not update the keypad's selection.
See [Plugin API limits](../README.md#plugin-api-limits) for navigation limits.

### Recent agents

Recent agents mode assigns the six most recently active agents across workspaces.
An agent keeps its key while it stays among those six;
a new agent takes a key freed by one that drops out.
Subagents are excluded unless **Include subagents** is on.

A tap selects the agent and its workspace for subsequent actions.
The selected agent's key is brighter.
A double tap means two taps of the same key, showing the same agent,
within 0.4 seconds.
The single-tap opening option changes whether selection also opens the agent;
it does not change which agent subsequent actions use.

### Workspaces

Workspaces mode fills free keys with the most recently active eligible workspaces.
Activity is the latest of the workspace's own activity and its agents' activity.
A workspace keeps its key until it leaves the eligible set or a pin takes the key;
new activity alone does not replace it.
Archived, background, and internal workspaces are excluded.
Pinned workspaces mode shows only eligible pinned workspaces,
leaving the other keys dark.

Pressing a workspace key selects it and opens an agent in Paseo.
The plugin chooses an agent that needs input, else one that failed,
in each case the one that has waited longest.
Otherwise, it chooses the most recently active agent.
If the workspace has no eligible agent, it is selected but nothing opens.

"The selected workspace's agent" means the agent selected by a recent-agent key,
if still available in that workspace, else the agent chosen by these rules.
Stop, thinking, prompts, approve, and deny use that target when the input arrives.
Subagents cannot be targets unless **Include subagents** is on.

Without a selected workspace, these actions use the fallback described in the
[main configuration guide](../README.md#configuration).
Choosing a fallback agent does not select its workspace.
**Open selected workspace** still requires a selection.
Set **Agents > Without a selected workspace** to "No agent"
to disable the fallback.

The plugin stores its selected workspace in PaseoMicro's memory.
After a plugin reload, the app returns the selection,
and the plugin restores it if the workspace is still eligible.
If PaseoMicro restarts while the plugin remains running,
the plugin sends its selection again.
Restarting both clears the selection.

### State colors

Each workspace key shows its agents' most urgent state,
excluding archived, closed, and internal agents.
The first matching state below wins:

| State        | Condition                                                                       | Default light     |
| ------------ | ------------------------------------------------------------------------------- | ----------------- |
| Failed       | An agent has `error` status or an unread failed turn                            | Red               |
| Needs input  | A pending permission request, question, or plan, or unread permission attention | Yellow, breathing |
| Running      | An agent is running or starting                                                 | Blue              |
| Done         | An agent has an unread finished turn                                            | Green             |
| Idle         | None of these, including a workspace without agents                             | Off               |
| No workspace | No workspace is assigned to the key                                             | Off               |

For example, a failed agent takes priority over one that needs permission.
Green means an unread result, not every finished agent.
Reading the result clears that indication.

By default, a subagent contributes only a running or idle state:
its failures, requests, and results do not make the key red, yellow, or green.
**Include subagents** makes them count like other agents.
Paseo identifies the parent through the `paseo.parent-agent-id` label,
shown as `ParentAgentId` by `paseo agent inspect`.

The selected workspace's key is brighter.
If its state light would be off, it shows dim white instead.
Recent-agent keys use the same colors for their individual agents.
Every state color, effect, and brightness can be changed in **Lights**.

## Actions

The [default bindings](../README.md#keys-and-default-bindings) cover navigation,
new agents, dictation, submit, scrolling, and the joystick.
Inputs can be reassigned in settings.
The following details apply to custom bindings as well.

### Permissions and agent actions

Approve and deny use the target agent's first pending request,
else the oldest pending request across eligible agents.
They select that agent's workspace.
If the request is a question, they open the agent so you can answer it.
A request that disappears before execution is skipped.

Other actions available for assignment include:

| Action                                           | Behavior                                                                                                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Open next workspace that needs input             | Orders waiting workspaces by how long their agents have waited, moves after the selected workspace, and opens the longest-waiting agent there |
| Stop agent                                       | Interrupts the target agent's turn with `paseo stop`                                                                                          |
| More thinking, less thinking                     | Changes the target agent's thinking option with `paseo agent update --thinking`                                                               |
| Toggle voice mode                                | Sends Cmd+Shift+D to turn Paseo's spoken answers on or off                                                                                    |
| Focus the composer                               | Sends Cmd+L to focus the open agent's composer                                                                                                |
| Select next workspace, select previous workspace | Selects the next or previous occupied workspace key, wrapping around, without opening it                                                      |
| Open selected workspace                          | Opens the selected workspace's agent                                                                                                          |
| Send prompt                                      | Sends the configured text to the target agent; a running agent receives it as steering                                                        |
| Nothing                                          | Leaves the input inactive                                                                                                                     |

An empty prompt does nothing.
When no workspace needs input, the corresponding action does nothing
and reports "No workspace needs input".

### Next agent that needs action

An agent needs action if it needs input, has failed, or has an unread result.
The action can open agents from workspaces that have no keypad key.
Waiting time comes from Paseo's attention time,
else the first time the plugin saw a pending request,
else the agent's latest activity.

The [default binding guide](../README.md#keys-and-default-bindings)
describes the order and lights.
The plugin also tracks which agents it opened in the current round:

- It skips the agent last opened by any keypad action while another needs action.
  If only that agent needs action, it opens it again and reports that fact.
- An agent leaves the round when it no longer needs action.
  A new request or newer result makes an agent count as new.
- After every waiting agent has been visited, another round starts.
  Opening an agent need not clear its request for the cycle to continue.

### History

History records agents opened with top keys, project keys,
**Open selected workspace**, **Open next workspace that needs input**,
**Open next agent that needs action**, or a question opened by approve or deny.
Going back preserves forward history;
opening a new place after going back discards it.

If a recorded agent is gone, history opens the workspace's most relevant agent.
It skips places whose workspaces are archived or have no eligible agents.
History starts empty when the plugin starts.
Its size and the events it cannot observe are listed under
[Plugin API limits](../README.md#plugin-api-limits).

### Dictation and scrolling

A push-to-talk release does nothing if its press was missed or failed,
or if Submit already stopped dictation.
Inputs without a release, such as dial turns, toggle dictation.
The dial click acts on release, so binding it to push to talk also toggles dictation.

Grouped keys use the first key's binding.
In the keypad picture, select a key and use **One keycap with**
to join it with the key to its right, or turn off **One keycap**.
The `keyGroups` setting stores these groups.

Plain and fast scroll steps that arrive while a scroll waits
combine into that scroll, up to 100 lines.
PaseoMicro scrolls the frontmost Paseo window at the configured position,
40% from the top by default.
The click's bounded jump uses a 1,000-line burst.
See [default bindings](../README.md#keys-and-default-bindings)
for step sizes and [Plugin API limits](../README.md#plugin-api-limits)
for jump limits.

### Thinking levels

A thinking change shows a meter on the six top keys for about 1.5 seconds.
The number of lit keys represents the level among the model's options:
six options light one more key per step, while three options light two.
At either end, another step shows the meter without changing the level.

If the model is unknown, has no thinking options, or the CLI command fails,
the keys flash the failure light, red by default, for about 0.6 seconds.
Waiting steps in the same direction for the same agent combine into one
`paseo agent update` command, stopping at the end of the available options.
A step in the opposite direction starts a separate change.
While Paseo's snapshot catches up, each change starts from the option
that the keypad last set.

Thinking options come from the provider's model list.
The plugin tries the runtime model name first, then the configured model name.
For each name, it looks for an exact ID, then an alias.
If the name contains only letters, it next tries the first model in provider order
whose ID is `<provider>-<name>` or starts with `<provider>-<name>-`.
When neither name is present, it uses the provider's default model.
If no model matches, the change fails and reports the error.
Model switching limits are described in the
[repository README](../README.md#plugin-api-limits).

### Radial menu and joystick prompts

PaseoMicro draws the ring over the middle of Paseo's front window,
or the main screen when Paseo has no window, without taking focus.
The choice nearest the stick's direction grows;
it fills with color when the stick is far enough out to select it.
Releasing before that point cancels the choice.
After cancellation, returning the stick to the center selects nothing.
PaseoMicro intercepts Escape while the ring is visible,
so it does not reach Paseo and interrupt the agent.

The ring's center names the target agent.
A choice that cannot act is dimmed and does nothing.
Back and Forward require history; Stop requires a running target;
agent actions require an agent.
Approve and Deny in the radial menu require that target's own pending request
and never answer another agent's request.
Actions are checked again before execution.

Select the radial menu in the keypad picture to edit each choice's icon,
label, color, action, and prompt, or to turn the menu off.
Icons come from the supplied SF Symbols list.
The [default binding guide](../README.md#keys-and-default-bindings)
gives the directions and selection gestures.
The default prompt text is:

| Choice   | Prompt                                         |
| -------- | ---------------------------------------------- |
| Test     | "Run the tests and fix any failures"           |
| Continue | "Continue"                                     |
| Commit   | "Commit this work"                             |
| Review   | "Review your diff for bugs"                    |
| Summary  | "Summarize where things stand and what's left" |

While the radial menu is on, the four directional prompt bindings remain stored
but do not fire.
With it off, a direction sends its prompt once when the stick passes
60% of its travel.
It can fire again after the stick returns to the center.
The plugin reads direction from the angle.

Input layers can supply angle events (`kb.radial`) or cardinal sector codes:
`AG15` down, `AG16` left, `AG17` up, and `AG18` right.
For hardware and firmware restrictions, see
[keypad layers](../README.md#keypad-layers-and-experimental-features).

## Settings

The [configuration guide](../README.md#configuration) explains where to open
settings and assign inputs.
The plugin's settings are grouped as follows:

| Group        | Controls                                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keypad       | Plain status, top-key mode, single-tap opening, bindings, key groups, and radial choices                                                                 |
| Lights       | State styles, selection brightness, selected-off light, navigation light, underglow, action-key lights, key backlight, thinking meter, and failure flash |
| Agents       | Subagent inclusion and the target used without a selected workspace                                                                                      |
| Scrolling    | Normal and fast lines per step, and the scroll position in Paseo's window                                                                                |
| Push to talk | Return on release and the delay after dictation stops, including when Submit stops it                                                                    |
| Advanced     | Collapsed: CLI path, socket path, the bundle ID that receives shortcuts, and Reconnect                                                                   |

**Underglow** can show the next agent that needs action,
light yellow while any agent needs input, or stay off.
Each action key can show the next agent's state or use the general key backlight;
individual key lights depend on the input layer.
The thinking meter has separate styles for lit and unlit keys.
The failure flash has its own style.

### Saved settings

New installs use settings version 14.
Version 13 settings migrate to navigation on the top keys.
Unchanged bindings on `ACT07`–`ACT09` become approve, deny, and new agent,
and unchanged radial Approve and Deny choices become Back and Forward.
Custom bindings and radial choices are retained.

Earlier versions migrate in sequence before reaching version 14.
For users with older saved settings, these are the changes at each step:

- **12 to 13** enables the fallback target: the next agent that needs action,
  else the most recently active agent.
  Other settings remain unchanged.
- **10 and 11 to 12** remove final periods from unchanged default radial prompts.
  Custom prompts keep their punctuation.
- **9 to 10** enables the radial menu with its default choices.
  The four directional bindings and their prompts remain stored
  and work again when the menu is off.
- **8 to 9** changes every "jump to the bottom, then the top" binding
  to "jump to the bottom", including bindings you assigned yourself.
  Other settings remain unchanged.
- **7 to 8** makes an enabled underglow show the next agent that needs action;
  a disabled underglow stays off.
  Its previous style remains available for "While any agent needs input".
  The action-key lights take their defaults.
- **6 to 7** changes unchanged dial defaults:
  held turns scroll fast instead of changing thinking,
  and the click jumps instead of focusing the composer.
  Custom bindings remain, and fast scrolling takes its default line count.
- **5 to 6** keeps existing settings and starts **Include subagents** off.
- **4 to 5** changes unchanged dial and joystick defaults:
  turns scroll, the click focuses the composer,
  and joystick directions send prompts that start empty.
  Custom bindings remain.
  Held turns, scroll settings, and meter lights take their defaults.
- **3 to 4** changes unchanged defaults so that `ACT06` opens the next agent
  that needs action and `ACT12` submits.
  Custom bindings remain, except "Open next unread agent"
  becomes "Open next agent that needs action".
- **2 to 3** changes unchanged defaults to workspace navigation,
  joins `ACT10` and `ACT11` for push to talk,
  and assigns `ACT12` to voice mode.
  Custom bindings remain, and the two switches become one keycap.
- **1 to 2** drops agent pins and old state colors.
  Agent-selection bindings become workspace-selection bindings;
  the ambient switch and brightness become underglow settings.
  The remaining bindings, selected-key brightness, other-key light,
  push-to-talk settings, and connection settings are kept.

The later migrations still apply after each of these steps;
an intermediate binding is not necessarily the final binding.
See `migrateSettings` in [shared/settings.ts](shared/settings.ts)
for the complete rules.

Unreadable or invalid settings disable actions rather than silently loading defaults.
The settings screen, sidebar footer, and plugin logs report the error.
Fix or reset the stored settings to restore actions.

### Commands and status

The [configuration guide](../README.md#configuration) lists the pin commands
and composer commands.
Pins apply to Workspaces and Pinned workspaces modes.
**Creator Micro: unpin every key** clears all pins.
**Creator Micro: reconnect to the keypad app** reconnects immediately,
replacing a connection that is still waiting for PaseoMicro to answer.

Click the sidebar footer to see what each top key shows
and the last action.

## Development

The plugin follows the `paseo plugin init` layout:

| Path                          | Purpose                                 |
| ----------------------------- | --------------------------------------- |
| `index.client.tsx`, `client/` | Code that runs in the Paseo app         |
| `index.server.ts`, `server/`  | Code that runs in the daemon            |
| `shared/`                     | Settings and RPC contracts used by both |
| `test/`                       | Plugin tests                            |
| `scripts/fake-bridge.ts`      | Fake PaseoMicro app                     |

Use the Node.js version in the root `mise.toml`.
See [repository development](../README.md#development)
for dependency installation, checks, local plugin installation, and reload commands.
To inspect plugin logs, run `paseo plugin logs creator-micro`.

To work without a keypad, change to `Plugin/` and start the fake app:

```sh
npm run fake-bridge
```

It serves the default socket and accepts inputs such as
`tap 3`, `cw`, `hold`, or `press 10`.
From the repository root, `mise run fake-bridge:plugin` starts the same tool.
The fake app refuses to start while PaseoMicro already serves the socket.
Its inputs run real actions in your Paseo daemon.

[bridge-protocol.ts](server/bridge-protocol.ts) and
[BridgeProtocol.swift](../Sources/PaseoMicroCore/BridgeProtocol.swift)
define the messages exchanged with the app.
