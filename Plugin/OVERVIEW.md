Creator Micro turns a Work Louder Creator Micro 2 keypad into a controller for Paseo.
Its lights show which agents need you,
and its keys, dial, and joystick act on them without the mouse.

## How you use it

- One key opens the next agent that needs your action, one agent per press,
  and the light under the keypad shows that agent's state.
- Two keys under one double-wide keycap are push to talk for dictation,
  and another key submits.
- Other keys approve or deny a permission request and start a new agent.
- The top keys move back and forward through the agents you opened,
  and between projects and workspaces.
  In the settings, they can instead show your most recently active agents or workspaces,
  or workspaces that you pin.
- Key colors show agent state: red for a failure, yellow when an agent needs input,
  blue while it runs, and green for a finished result that you have not read.
- The dial scrolls the open conversation, and a click jumps to the bottom.
- The joystick opens a radial menu of common prompts and actions over Paseo's window.

The settings show a picture of the keypad with each key's light and action,
and let you change what most keys, the dial, and the joystick do.

## Setup

The plugin needs Paseo 0.13.0 or later on macOS 15 or later,
and the Paseo Micro menu bar app, which talks to the keypad over USB
and needs Accessibility access for shortcuts and scrolling.
Keep the keypad on its stock ChatGPT layer (layer 4) for the keys and dial,
and quit the ChatGPT app while you use the keypad with Paseo,
because it also listens to the keypad and resets its lights.

## Limits

The joystick menu and the next-agent key's own light need a custom keypad layer,
which is experimental and has no supported tool yet.
The plugin cannot switch an agent's model.
