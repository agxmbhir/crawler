export type Action = {
    type: "navigate" | "click";
    label: string;
    href?: string;
    selector: string;
};

export class Extractor {
    async extract(page: any, limit: number = 2000): Promise<Action[]> {
        const actions: Action[] = await page.evaluate((max: number) => {
            function isVisible(el: Element): boolean {
                const rect = (el as HTMLElement).getBoundingClientRect();
                const style = window.getComputedStyle(el as HTMLElement);
                if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
                if (rect.width <= 0 || rect.height <= 0) return false;
                return true;
            }

            function labelOf(el: Element): string {
                const aria = (el.getAttribute("aria-label") || "").trim();
                if (aria) return aria;
                const title = (el.getAttribute("title") || "").trim();
                if (title) return title;
                const text = (el as HTMLElement).innerText || (el.textContent || "");
                return (text || "").trim().replace(/\s+/g, " ").slice(0, 120);
            }

            function toSelector(el: Element): string {
                const id = el.getAttribute("id");
                if (id) return `#${CSS.escape(id)}`;
                const classes = (el.getAttribute("class") || "").split(/\s+/).filter(Boolean).slice(0, 2).map(c => `.${CSS.escape(c)}`).join("");
                const tag = el.tagName.toLowerCase();
                return `${tag}${classes}`;
            }

            const out: any[] = [];
            const anchors = Array.from(document.querySelectorAll("a[href]"));
            const buttons = Array.from(document.querySelectorAll("button, [role='button']"));
            const nodes = anchors.concat(buttons).slice(0, max);
            for (const el of nodes) {
                if (!isVisible(el)) continue;
                const label = labelOf(el);
                if (!label) continue;
                const tag = el.tagName.toLowerCase();
                const type = tag === "a" ? "navigate" : "click";
                const href = (el as HTMLAnchorElement).getAttribute?.("href") || undefined;
                out.push({ type, label, href, selector: toSelector(el) });
            }
            return out;
        }, limit);
        return actions;
    }
}


