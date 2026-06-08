// OSC 8 terminal hyperlinks — make URLs clickable in supporting terminals
// (iTerm2, kitty, WezTerm, modern VS Code terminal, etc.). Degrades to plain
// text where unsupported. Pattern borrowed from OpenClaw's tui/osc8-hyperlinks.
//
// The escape is zero-width, so string-width / ink layout measure only the
// visible label. Safe to embed inside an ink <Text>.

const OSC = ']8;;';
const BEL = '';

/** Wrap a label in an OSC 8 hyperlink. Returns the bare label if no url. */
export function link(url: string | undefined | null, label: string): string {
  if (!url) return label;
  return `${OSC}${url}${BEL}${label}${OSC}${BEL}`;
}
