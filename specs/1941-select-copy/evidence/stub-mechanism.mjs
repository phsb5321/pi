// Instrumented: which width keys do Text memos see inside TuiAltScreen, and do stubs get painted?
import { Text } from "/home/notroot/Documents/Code/pi-upstream-1941-select-copy/packages/tui/src/components/text.ts";
import { VStack } from "/home/notroot/Documents/Code/pi-upstream-1941-select-copy/packages/tui/src/components/v-stack.ts";
import { ScrollView } from "/home/notroot/Documents/Code/pi-upstream-1941-select-copy/packages/tui/src/components/scroll-view.ts";
import { TuiAltScreen } from "/home/notroot/Documents/Code/pi-upstream-1941-select-copy/packages/tui/src/tui-alt-screen.ts";

import { VirtualTerminal } from "/home/notroot/Documents/Code/pi-upstream-1941-select-copy/packages/tui/test/virtual-terminal.ts";
const counts = new Map();
class ProbeText extends Text {
  render(width) {
    const key = `${this.text.split("\n")[0].slice(0, 8)}@${width}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return super.render(width);
  }
  dropRenderedLines() {
    console.log("DROP:", this.text.split("\n")[0]);
    super.dropRenderedLines();
  }
}
const children = Array.from({ length: 40 }, (_, i) => new ProbeText(`child ${i} a\nchild ${i} b\nchild ${i} c`, 0, 0));
const scroll = new ScrollView(new VStack(children), { primary: true });
const term = new VirtualTerminal(20, 5);
const tui = new TuiAltScreen(term, false, undefined);
tui.addChild(scroll);
tui.start();
await term.waitForRender();
console.log("after start:", JSON.stringify(children[0].render(19).map((l) => l.trimEnd())), JSON.stringify(children[0].render(20).map((l) => l.trimEnd())));
tui.scrollToBottom();
await term.waitForRender();
console.log("after bottom:", JSON.stringify(children[0].render(19).map((l) => l.trimEnd())), JSON.stringify(children[0].render(20).map((l) => l.trimEnd())));
tui.requestRender();
await term.waitForRender();
console.log("after repaint:", JSON.stringify(children[0].render(19).map((l) => l.trimEnd())), JSON.stringify(children[0].render(20).map((l) => l.trimEnd())));
tui.scrollToTop();
await term.waitForRender();
console.log("SCREEN at top:", JSON.stringify(tui.getScreenLines().map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;\x07/g, "").trimEnd())));
console.log("child0@19:", JSON.stringify(children[0].render(19).map((l) => l.trimEnd())));
console.log("child0@20:", JSON.stringify(children[0].render(20).map((l) => l.trimEnd())));
console.log("render counts (width-keyed):", JSON.stringify([...counts.entries()].filter(([k]) => k.startsWith("child 0") || k.startsWith("child 38"))));
tui.stop();
