/** The actions that a keypad input can run. */
export const ACTION_IDS = [
  "none",
  "nextActionableAgent",
  "nextStuckWorkspace",
  "navigateBack",
  "navigateForward",
  "previousWorkspace",
  "nextWorkspace",
  "previousProject",
  "nextProject",
  "newAgent",
  "pushToTalk",
  "submit",
  "focusComposer",
  "scrollDown",
  "scrollUp",
  "scrollDownFast",
  "scrollUpFast",
  "jumpToBottom",
  "toggleVoiceMode",
  "approvePermission",
  "denyPermission",
  "stopAgent",
  "thinkingUp",
  "thinkingDown",
  "selectNextWorkspace",
  "selectPreviousWorkspace",
  "openSelectedWorkspace",
  "sendPrompt",
] as const;

export type ActionId = (typeof ACTION_IDS)[number];

/** Actions of the agent-key version (settings version 1) and the workspace actions that replace them. */
export const RENAMED_ACTIONS: Readonly<Record<string, ActionId>> = {
  selectNextAgent: "selectNextWorkspace",
  selectPreviousAgent: "selectPreviousWorkspace",
  openSelectedAgent: "openSelectedWorkspace",
};

/** Actions of settings version 3 that version 4 folds into another action. */
export const VERSION_4_RENAMED_ACTIONS: Readonly<Record<string, ActionId>> = {
  openNextUnread: "nextActionableAgent",
};

/**
 * Actions of settings version 8 that version 9 renames: the jump to the bottom, then the top,
 * goes only to the bottom.
 */
export const VERSION_9_RENAMED_ACTIONS: Readonly<Record<string, ActionId>> = {
  jumpToEdge: "jumpToBottom",
};

export interface ActionDescription {
  readonly label: string;
  readonly description: string;
}

export const ACTIONS: Readonly<Record<ActionId, ActionDescription>> = {
  none: { label: "Nothing", description: "The input does nothing." },
  nextActionableAgent: {
    label: "Open next agent that needs action",
    description:
      "Opens the agent that has waited longest with a permission request, a failure, or an unread result, skipping the agents it opened in this round. Does nothing when no agent needs action.",
  },
  nextStuckWorkspace: {
    label: "Open next workspace that needs input",
    description:
      "Opens the waiting agent of the next workspace with an agent that needs input, in order of how long each has waited, starting after the selected workspace. Does nothing when no agent waits.",
  },
  navigateBack: {
    label: "Go back",
    description:
      "Opens the agent that the keypad opened before the current one, like a browser's back button. Repeated presses go further back. The history has only the places that the keypad opened.",
  },
  navigateForward: {
    label: "Go forward",
    description:
      "After going back, opens the agent that the keypad opened after the current one, like a browser's forward button. Opening something new drops the places ahead.",
  },
  previousWorkspace: {
    label: "Previous workspace (Cmd+[)",
    description: "Sends Cmd+[ to Paseo, which opens the previous workspace in its sidebar.",
  },
  nextWorkspace: {
    label: "Next workspace (Cmd+])",
    description: "Sends Cmd+] to Paseo, which opens the next workspace in its sidebar.",
  },
  previousProject: {
    label: "Previous project",
    description:
      "Opens the most relevant agent of the most recently active workspace in the previous project, with the projects in name order. Paseo has no shortcut for projects.",
  },
  nextProject: {
    label: "Next project",
    description:
      "Opens the most relevant agent of the most recently active workspace in the next project, with the projects in name order. Paseo has no shortcut for projects.",
  },
  newAgent: {
    label: "New agent (Cmd+O)",
    description: "Sends Cmd+O to Paseo, its shortcut for a new agent (agent.new).",
  },
  pushToTalk: {
    label: "Push to talk",
    description:
      "Starts Paseo dictation on press and stops it on release. Inputs without a release toggle dictation.",
  },
  submit: {
    label: "Submit",
    description:
      "Sends Return to Paseo to send the composer's text. Stops dictation first if the keypad started it.",
  },
  focusComposer: {
    label: "Focus the composer (Cmd+L)",
    description: "Sends Cmd+L to Paseo, which puts the cursor in the open agent's composer.",
  },
  scrollDown: {
    label: "Scroll down",
    description:
      "Scrolls the open agent's conversation in Paseo toward its newest messages, by the lines in the scroll settings.",
  },
  scrollUp: {
    label: "Scroll up",
    description:
      "Scrolls the open agent's conversation in Paseo toward its oldest messages, by the lines in the scroll settings.",
  },
  scrollDownFast: {
    label: "Scroll down fast",
    description:
      "Scrolls the open agent's conversation in Paseo toward its newest messages, by the fast lines in the scroll settings.",
  },
  scrollUpFast: {
    label: "Scroll up fast",
    description:
      "Scrolls the open agent's conversation in Paseo toward its oldest messages, by the fast lines in the scroll settings.",
  },
  jumpToBottom: {
    label: "Jump to the bottom",
    description:
      "Scrolls the open agent's conversation in Paseo to its newest message. Presses that arrive while a jump waits or runs are ignored.",
  },
  toggleVoiceMode: {
    label: "Toggle voice mode",
    description: "Turns Paseo voice mode on or off, in which Paseo answers aloud.",
  },
  approvePermission: {
    label: "Approve permission",
    description:
      "Allows the pending request of the selected workspace's agent, else the oldest pending request. Questions open the agent instead.",
  },
  denyPermission: {
    label: "Deny permission",
    description:
      "Denies the pending request of the selected workspace's agent, else the oldest pending request. Questions open the agent instead.",
  },
  stopAgent: {
    label: "Stop agent",
    description: "Interrupts the turn of the selected workspace's agent.",
  },
  thinkingUp: {
    label: "More thinking",
    description:
      "Moves the selected workspace's agent to the next thinking option of its model, and shows the new level on the workspace keys for a moment.",
  },
  thinkingDown: {
    label: "Less thinking",
    description:
      "Moves the selected workspace's agent to the previous thinking option of its model, and shows the new level on the workspace keys for a moment.",
  },
  selectNextWorkspace: {
    label: "Select next workspace",
    description: "Selects the workspace on the next key without opening it.",
  },
  selectPreviousWorkspace: {
    label: "Select previous workspace",
    description: "Selects the workspace on the previous key without opening it.",
  },
  openSelectedWorkspace: {
    label: "Open selected workspace",
    description: "Opens the selected workspace's agent.",
  },
  sendPrompt: {
    label: "Send prompt",
    description:
      "Sends the configured text to the selected workspace's agent. A running agent receives it as steering. With no text, the input does nothing.",
  },
};
