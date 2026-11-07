/**
 * The Paseo Micro menu bar app's keypad glyph (see `Scripts/menu-bar-icons.swift`) as inline SVG:
 * the keys in rows of 2, 4, 4, and 2 with the double-wide keycap, the knob as a dot,
 * and the joystick as a square with a round cutout.
 * It paints with `currentColor`, so Paseo draws it in each surface's icon color.
 */
export const KEYPAD_ICON_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 1 17 17" fill="currentColor">',
  ...[
    [5, 2, 3],
    [9, 2, 3],
    [1, 6, 3],
    [5, 6, 3],
    [9, 6, 3],
    [13, 6, 3],
    [1, 10, 3],
    [5, 10, 3],
    [9, 10, 3],
    [13, 10, 3],
    [5, 14, 7],
    [13, 14, 3],
  ].map(([x, y, width]) => `<rect x="${x}" y="${y}" width="${width}" height="3" rx="0.5"/>`),
  '<circle cx="2.5" cy="3.5" r="0.5"/>',
  '<path fill-rule="evenodd" d="M13.5 2h2a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1-.5-.5v-2a.5.5 0 0 1 .5-.5zM14.5 3a.5.5 0 1 0 0 1 .5.5 0 1 0 0-1z"/>',
  "</svg>",
].join("");

export const KEYPAD_ICON = { svg: KEYPAD_ICON_SVG } as const;
