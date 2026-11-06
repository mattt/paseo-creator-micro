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
    description: "Opens the agent that has waited longest for you.",
  },
  nextStuckWorkspace: {
    label: "Open next workspace that needs input",
    description: "Opens the next workspace with an agent that needs input.",
  },
  navigateBack: {
    label: "Go back",
    description: "Goes back through the places that the keypad opened.",
  },
  navigateForward: {
    label: "Go forward",
    description: "Goes forward through the places that the keypad opened.",
  },
  previousWorkspace: {
    label: "Previous workspace (Cmd+[)",
    description: "Opens the previous workspace in Paseo's sidebar.",
  },
  nextWorkspace: {
    label: "Next workspace (Cmd+])",
    description: "Opens the next workspace in Paseo's sidebar.",
  },
  previousProject: {
    label: "Previous project",
    description: "Opens the most recent workspace in the previous project.",
  },
  nextProject: {
    label: "Next project",
    description: "Opens the most recent workspace in the next project.",
  },
  newAgent: {
    label: "New agent (Cmd+O)",
    description: "Starts a new agent in Paseo.",
  },
  pushToTalk: {
    label: "Push to talk",
    description: "Dictates while you hold the input.",
  },
  submit: {
    label: "Submit",
    description: "Sends the composer's text.",
  },
  focusComposer: {
    label: "Focus the composer (Cmd+L)",
    description: "Puts the cursor in the open agent's composer.",
  },
  scrollDown: {
    label: "Scroll down",
    description: "Scrolls the conversation toward its newest messages.",
  },
  scrollUp: {
    label: "Scroll up",
    description: "Scrolls the conversation toward its oldest messages.",
  },
  scrollDownFast: {
    label: "Scroll down fast",
    description: "Scrolls quickly toward the newest messages.",
  },
  scrollUpFast: {
    label: "Scroll up fast",
    description: "Scrolls quickly toward the oldest messages.",
  },
  jumpToBottom: {
    label: "Jump to the bottom",
    description: "Scrolls the conversation to its newest message.",
  },
  toggleVoiceMode: {
    label: "Toggle voice mode",
    description: "Turns Paseo's spoken answers on or off.",
  },
  approvePermission: {
    label: "Approve permission",
    description: "Allows the selected agent's pending request, else the oldest one.",
  },
  denyPermission: {
    label: "Deny permission",
    description: "Denies the selected agent's pending request, else the oldest one.",
  },
  stopAgent: {
    label: "Stop agent",
    description: "Stops the selected agent's turn.",
  },
  thinkingUp: {
    label: "More thinking",
    description: "Moves the selected agent to its next thinking level.",
  },
  thinkingDown: {
    label: "Less thinking",
    description: "Moves the selected agent to its previous thinking level.",
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
    description: "Sends your text to the selected agent.",
  },
};
