import { Text } from "/home/notroot/Documents/Code/pi-upstream-1941-select-copy/packages/tui/src/components/text.ts";
import { VStack } from "/home/notroot/Documents/Code/pi-upstream-1941-select-copy/packages/tui/src/components/v-stack.ts";
import { ScrollView } from "/home/notroot/Documents/Code/pi-upstream-1941-select-copy/packages/tui/src/components/scroll-view.ts";
import { renderLayoutFrame } from "/home/notroot/Documents/Code/pi-upstream-1941-select-copy/packages/tui/src/layout.ts";

const children = Array.from({ length: 40 }, (_, i) => new Text(`child ${i} a\nchild ${i} b\nchild ${i} c`, 0, 0));
const scroll = new ScrollView(new VStack(children), { primary: true });
let frame = renderLayoutFrame(scroll, 20, 5, () => {});
console.log("frame1 lines", JSON.stringify(frame.lines.map((l) => l.trimEnd())));
console.log("scrollTop after f1", frame.primaryScrollView?.scrollTop);
// scroll to bottom: max = contentHeight - viewport
frame.primaryScrollView.scrollTo(9999);
frame = renderLayoutFrame(scroll, 20, 5, () => {});
console.log("frame2 lines", JSON.stringify(frame.lines.map((l) => l.trimEnd())));
console.log("scrollTop after f2", frame.primaryScrollView?.scrollTop);
console.log("child0 memo after f2", JSON.stringify(children[0].render(20).map((l) => l.trimEnd())));
frame = renderLayoutFrame(scroll, 20, 5, () => {});
console.log("child0 memo after f3", JSON.stringify(children[0].render(20).map((l) => l.trimEnd())));
frame.primaryScrollView.scrollTo(0);
frame = renderLayoutFrame(scroll, 20, 5, () => {});
console.log("frame4 lines (back at top)", JSON.stringify(frame.lines.map((l) => l.trimEnd())));
