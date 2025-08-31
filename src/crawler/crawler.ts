import { Renderer } from "../renderer";
import { Extractor, Action } from "../extractor";
import * as path from "path";
import * as fs from "fs";

export type CrawlOptions = {
    seeds: string[];
    maxDepth?: number;
    maxPages?: number;
    sameOrigin?: boolean;
    delayMs?: number;
    concurrency?: number;
    discoverTransitions?: boolean;
    transitionsPerPage?: number;
    screenshotDir?: string;
};

export type PageVisit = {
    url: string;
    title: string;
    depth: number;
    actions: Action[];
    screenshotPath?: string;
};

export type Edge = { to: string; label: string; type: Action["type"] | "transition"; options?: string[] };

export type CrawlResult = {
    pages: PageVisit[];
    graph: Record<string, string[]>; // legacy: url -> outgoing urls (navigate only)
    actionGraph: Record<string, Edge[]>; // url -> actions (navigate edges to other nodes, clicks/toggles/transition as self)
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

function safeFileName(url: string): string {
    try {
        const u = new URL(url);
        return (u.hostname + u.pathname).replace(/[^a-z0-9\-]+/gi, "_").slice(0, 200) + ".png";
    } catch {
        return url.replace(/[^a-z0-9\-]+/gi, "_").slice(0, 200) + ".png";
    }
}

export class Crawler {
    private renderer: Renderer;
    private extractor: Extractor;

    constructor(renderer: Renderer, extractor: Extractor) {
        this.renderer = renderer;
        this.extractor = extractor;
    }

    private async visit(url: string, discoverTransitions: boolean, transitionsPerPage: number, screenshotDir?: string): Promise<{ normalized: string; title: string; actions: Action[]; transitions: Array<{ triggerLabel: string; actions: Action[] }>; screenshotPath?: string }> {
        const shotPath = screenshotDir ? path.join(screenshotDir, safeFileName(url)) : undefined;
        const { actions, currentUrl, title, transitions } = await this.renderer.renderAndRun(url, async (page: any) => {
            const items = await this.extractor.extract(page);
            const href = await page.url();
            const t = await page.title().catch(() => "");
            let trans: Array<{ triggerLabel: string; actions: Action[] }> = [];
            if (discoverTransitions) {
                try {
                    const discovered = await this.extractor.discoverTransitions(page, transitionsPerPage);
                    trans = (discovered || []).map((d: any) => ({ triggerLabel: d.triggerLabel, actions: d.actions || [] }));
                } catch { }
            }
            return { actions: items, currentUrl: href as string, title: t as string, transitions: trans };
        }, { blockMedia: true, screenshotPath: shotPath });
        return { normalized: normalizeUrl(currentUrl), title, actions, transitions, screenshotPath: shotPath };
    }

    async crawl(options: CrawlOptions): Promise<CrawlResult> {
        const maxDepth = options.maxDepth ?? 1;
        const maxPages = options.maxPages ?? 50;
        const sameOrigin = options.sameOrigin ?? true;
        const delayMs = options.delayMs ?? 0;
        const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, 10));
        const discoverTransitions = options.discoverTransitions ?? true;
        const transitionsPerPage = Math.max(0, Math.min(options.transitionsPerPage ?? 12, 50));
        const screenshotDir = options.screenshotDir ?? path.join(process.cwd(), "out", "screens");
        try { fs.mkdirSync(screenshotDir, { recursive: true }); } catch { }

        const visited = new Set<string>();
        const pages: PageVisit[] = [];
        const graph: Record<string, string[]> = {};
        const actionGraph: Record<string, Edge[]> = {};

        let frontier: Array<{ url: string; depth: number; origin: string | null }> = [];
        for (const s of options.seeds) {
            let origin: string | null = null;
            try { origin = new URL(s).origin; } catch { }
            frontier.push({ url: normalizeUrl(s), depth: 0, origin });
        }

        for (let depth = 0; depth <= maxDepth && frontier.length > 0 && pages.length < maxPages; depth++) {
            const currentLayer = frontier.filter(f => f.depth === depth);
            if (currentLayer.length === 0) continue;

            const toVisit = currentLayer
                .filter(f => !visited.has(f.url))
                .slice(0, Math.max(0, maxPages - pages.length));

            const nextFrontierCandidates: Array<{ url: string; depth: number; origin: string | null }> = [];

            for (let i = 0; i < toVisit.length; i += concurrency) {
                const chunk = toVisit.slice(i, i + concurrency);
                const results = await Promise.allSettled(chunk.map(async (f) => {
                    const res = await this.visit(f.url, discoverTransitions, transitionsPerPage, screenshotDir);
                    return { input: f, res };
                }));

                for (const r of results) {
                    if (r.status !== "fulfilled") continue;
                    const { input, res } = r.value;
                    const baseOrigin = input.origin;
                    const normalized = res.normalized;
                    if (visited.has(normalized)) continue;
                    visited.add(normalized);

                    const nextUrls: string[] = [];
                    const actionEdges: Edge[] = [];

                    for (const a of res.actions) {
                        if (a.type === "navigate") {
                            const abs = resolveHref(normalized, a.href);
                            if (!abs) continue;
                            const finalUrl = normalizeUrl(abs);
                            if (sameOrigin && baseOrigin) {
                                try {
                                    if (new URL(finalUrl).origin !== baseOrigin) continue;
                                } catch { continue; }
                            }
                            if (!visited.has(finalUrl)) {
                                nextUrls.push(finalUrl);
                            }
                            actionEdges.push({ to: finalUrl, label: a.label, type: "navigate" });
                        } else {
                            actionEdges.push({ to: normalized, label: a.label, type: a.type, options: a.options });
                        }
                    }

                    for (const tr of (res as any).transitions || []) {
                        const trigger = tr.triggerLabel;
                        const opts = Array.from(new Set(((tr.actions || []) as Action[]).map(a => a.label).filter(Boolean)));
                        if (trigger && opts.length) {
                            actionEdges.push({ to: normalized, label: trigger, type: "transition", options: opts.slice(0, 12) });
                        }
                    }

                    graph[normalized] = nextUrls;
                    actionGraph[normalized] = actionEdges;
                    pages.push({ url: normalized, title: res.title, depth: input.depth, actions: res.actions, screenshotPath: res.screenshotPath });

                    const childDepth = input.depth + 1;
                    if (childDepth <= maxDepth) {
                        for (const nurl of nextUrls) {
                            nextFrontierCandidates.push({ url: nurl, depth: childDepth, origin: baseOrigin });
                        }
                    }
                }
            }

            const seenNext = new Set<string>();
            const nextFrontier: Array<{ url: string; depth: number; origin: string | null }> = [];
            for (const c of nextFrontierCandidates) {
                if (visited.has(c.url)) continue;
                if (seenNext.has(c.url)) continue;
                seenNext.add(c.url);
                nextFrontier.push(c);
            }

            frontier = nextFrontier;
            if (delayMs > 0 && frontier.length > 0) {
                await sleep(delayMs);
            }
        }

        return { pages, graph, actionGraph };
    }
}

export function toDot(result: CrawlResult): string {
    function esc(s: string): string {
        return s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
    }
    function labelFor(url: string): string {
        const pv = result.pages.find(p => p.url === url);
        const title = pv?.title?.trim();
        if (title) return title.length > 100 ? title.slice(0, 97) + "…" : title;
        try {
            const u = new URL(url);
            const pathq = `${u.pathname}${u.search}` || "/";
            return pathq.length > 100 ? pathq.slice(0, 97) + "…" : pathq;
        } catch {
            return url.length > 100 ? url.slice(0, 97) + "…" : url;
        }
    }

    const MAX_SELF_EDGES_PER_PAGE = 100;

    const lines: string[] = [];
    lines.push("digraph G {");
    lines.push("  rankdir=LR;");
    lines.push("  node [shape=box, style=rounded, fontsize=10];");

    const nodes = new Set<string>([...Object.keys(result.graph)]);
    for (const outs of Object.values(result.graph)) {
        for (const v of outs) nodes.add(v);
    }

    // Page nodes
    for (const n of nodes) {
        const label = esc(labelFor(n));
        const tooltip = esc(n);
        lines.push(`  "${esc(n)}" [label="${label}", tooltip="${tooltip}"];`);
    }

    // Navigation edges (solid)
    for (const [src, outs] of Object.entries(result.graph)) {
        const seen = new Set<string>();
        for (const dst of outs) {
            if (seen.has(dst)) continue; seen.add(dst);
            const acts = (result.actionGraph[src] || []).filter(e => e.type === "navigate" && e.to === dst);
            const lbl = esc((acts[0]?.label) || "");
            if (lbl) lines.push(`  "${esc(src)}" -> "${esc(dst)}" [label="${lbl}"];`);
            else lines.push(`  "${esc(src)}" -> "${esc(dst)}";`);
        }
    }

    // Self edges summarizing page-local actions/transitions
    for (const [src, edges] of Object.entries(result.actionGraph)) {
        const used = new Set<string>();
        let count = 0;
        // Prefer transitions and click-with-options
        const sorted = [...edges].sort((a, b) => {
            const rank = (e: Edge) => (e.type === "transition" ? 0 : (e.options && e.options.length ? 1 : 2));
            return rank(a) - rank(b);
        });
        for (const e of sorted) {
            if (e.type === "navigate") continue; // handled above
            if (count >= MAX_SELF_EDGES_PER_PAGE) break;
            if (e.type === "transition" || (e.options && e.options.length)) {
                const opts = (e.options || []).slice(0, 8).map(o => esc(o)).join(" | ");
                const lbl = `${esc(e.label)} -> (${opts})`;
                if (used.has(lbl)) continue; used.add(lbl);
                lines.push(`  "${esc(src)}" -> "${esc(src)}" [style=dotted, color=dodgerblue, label="${lbl}"];`);
                count++;
            } else {
                const lbl = esc(e.label);
                if (used.has(lbl)) continue; used.add(lbl);
                lines.push(`  "${esc(src)}" -> "${esc(src)}" [style=dashed, color=gray50, label="${lbl}"];`);
                count++;
            }
        }
    }

    lines.push("}");
    return lines.join("\n");
}
