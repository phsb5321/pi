/** Blankness memo (its length is the rendered height) with droppable lines: render caches keep
 * scan-identical stubs after the lines are freed, so windowing never triggers a re-render storm. */
export class RenderMemo {
	private text?: string;
	private width?: number;
	private lines?: string[];
	private blankness: boolean[] = [];

	/** The cached lines, or scan-identical stub rows after drop(); undefined when the key changed. */
	hit(text: string, width: number): string[] | undefined {
		if (this.text !== text || this.width !== width) return undefined;
		if (this.lines) return this.lines;
		return this.blankness.map((blank) => (blank ? "" : "\u0000"));
	}

	store(text: string, width: number, lines: string[]): void {
		this.text = text;
		this.width = width;
		this.lines = lines;
		this.blankness = lines.map((line) => line === "");
	}

	/** Free the rendered lines, keeping height/blankness; the next real render re-stores. */
	drop(): void {
		this.lines = undefined;
	}

	clear(): void {
		this.text = undefined;
		this.width = undefined;
		this.lines = undefined;
		this.blankness = [];
	}
}

/** Component base with a droppable render memo: windowed caches answer with stubs, never re-render storms. */
export abstract class MemoizedRender {
	protected renderMemo = new RenderMemo();

	/** Free the rendered lines, keeping height/blankness; render() stubs until the next real render. */
	dropRenderedLines(): void {
		this.renderMemo.drop();
	}
}
