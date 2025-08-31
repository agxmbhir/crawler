import { Renderer } from "../renderer";
import { Extractor, Action } from "../extractor";

export type CrawlOptions = {
    seeds: string[];
    maxDepth?: number;
    maxPages?: number;
    sameOrigin?: boolean;
    delayMs?: number;
};

export type PageVisit = {
    url: string;
    depth: number;
    actions: Action[];
};

export type CrawlResult = {
    pages: PageVisit[];
    graph: Record<string, string[]>; // url -> outgoing urls
};

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUrl(raw: string): string {
    try {
        const u = new URL(raw);
        u.hash = "";
        // Normalize trailing slash: keep for root-only, remove otherwise
        if (u.pathname !== "/" && u.pathname.endsWith("/")) {
            u.pathname = u.pathname.replace(/\/+$/, "");
        }
        return u.toString();
    } catch {
        return raw;
    }
}

function resolveHref(baseUrl: string, href?: string): string | null {
    if (!href) return null;
    try {
        const abs = new URL(href, baseUrl);
        if (!/^https?:$/.test(abs.protocol)) return null;
        return abs.toString();
    } catch {
        return null;
    }
}

export class Crawler {
    private renderer: Renderer;
    private extractor: Extractor;

    constructor(renderer: Renderer, extractor: Extractor) {
        this.renderer = renderer;
        this.extractor = extractor;
    }

    async crawl(options: CrawlOptions): Promise<CrawlResult> {
        const maxDepth = options.maxDepth ?? 1;
        const maxPages = options.maxPages ?? 50;
        const sameOrigin = options.sameOrigin ?? true;
        const delayMs = options.delayMs ?? 250;

        const queue: Array<{ url: string; depth: number }> = [];
        const visited = new Set<string>();
        const pages: PageVisit[] = [];
        const graph: Record<string, string[]> = {};

        for (const s of options.seeds) {
            queue.push({ url: normalizeUrl(s), depth: 0 });
        }

        while (queue.length > 0 && pages.length < maxPages) {
            const { url, depth } = queue.shift()!;
            if (visited.has(url)) continue;
            visited.add(url);

            const baseOrigin = (() => {
                try { return new URL(url).origin; } catch { return null; }
            })();

            const { actions, currentUrl } = await this.renderer.renderAndRun(url, async (page: any) => {
                const items = await this.extractor.extract(page);
                const href = await page.url();
                return { actions: items, currentUrl: href as string };
            }, { blockMedia: true });

            const normalized = normalizeUrl(currentUrl);
            const nextUrls: string[] = [];

            for (const a of actions) {
                if (a.type !== "navigate") continue;
                const abs = resolveHref(normalized, a.href);
                if (!abs) continue;
                const finalUrl = normalizeUrl(abs);
                if (sameOrigin && baseOrigin) {
                    try {
                        if (new URL(finalUrl).origin !== baseOrigin) continue;
                    } catch { continue; }
                }
                if (!visited.has(finalUrl) && !queue.some(q => q.url === finalUrl)) {
                    nextUrls.push(finalUrl);
                    if (depth + 1 <= maxDepth) {
                        queue.push({ url: finalUrl, depth: depth + 1 });
                    }
                }
            }

            graph[normalized] = nextUrls;
            pages.push({ url: normalized, depth, actions });

            if (delayMs > 0) {
                await sleep(delayMs);
            }
        }

        return { pages, graph };
    }
}

export function toDot(result: CrawlResult): string {
    function esc(s: string): string {
        return s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
    }
    const lines: string[] = [];
    lines.push("digraph G {");
    lines.push("  rankdir=LR;");
    lines.push("  node [shape=box, style=rounded, fontsize=10];");
    // Declare nodes
    const nodes = new Set<string>([...Object.keys(result.graph)]);
    for (const outs of Object.values(result.graph)) {
        for (const v of outs) nodes.add(v);
    }
    for (const n of nodes) {
        lines.push(`  "${esc(n)}" [label="${esc(n)}"];`);
    }
    // Edges
    for (const [src, outs] of Object.entries(result.graph)) {
        for (const dst of outs) {
            lines.push(`  "${esc(src)}" -> "${esc(dst)}";`);
        }
    }
    lines.push("}");
    return lines.join("\n");
}
