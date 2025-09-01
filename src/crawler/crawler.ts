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
    jsonlDir?: string;
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

function parseTriggerFromNode(node: string): string | null {
    const ix = node.indexOf('::TRANS::');
    if (ix < 0) return null;
    const rest = node.slice(ix + '::TRANS::'.length);
    const optIx = rest.indexOf('::OPT::');
    return optIx >= 0 ? rest.slice(0, optIx) : rest;
}

function parseOptionFromNode(node: string): string | null {
    const ix = node.indexOf('::OPT::');
    if (ix < 0) return null;
    return node.slice(ix + '::OPT::'.length);
}

function safeFileName(url: string): string {
    try {
        const u = new URL(url);
        return (u.hostname + u.pathname + u.search).replace(/[^a-z0-9\-]+/gi, "_").slice(0, 200) + ".png";
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

    private async visit(url: string, discoverTransitions: boolean, transitionsPerPage: number, screenshotDir?: string): Promise<{ normalized: string; title: string; actions: Action[]; transitions: Array<{ triggerLabel: string; actions: Action[]; added?: string[]; removed?: string[] }>; screenshotPath?: string }> {
        const shotPath = screenshotDir ? path.join(screenshotDir, safeFileName(url)) : undefined;
        const { actions, currentUrl, title, transitions } = await this.renderer.renderAndRun(url, async (page: any) => {
            const items = await this.extractor.extract(page);
            const href = await page.url();
            const t = await page.title().catch(() => "");
            let trans: Array<{ triggerLabel: string; actions: Action[]; added?: string[]; removed?: string[] }> = [];
            if (discoverTransitions) {
                try {
                    const discovered = await this.extractor.discoverTransitions(page, transitionsPerPage);
                    trans = (discovered || []).map((d: any) => ({ triggerLabel: d.triggerLabel, actions: d.actions || [], added: d.added || [], removed: d.removed || [] }));
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
        const jsonlDir = options.jsonlDir ?? path.join(process.cwd(), "out", "jsonl");
        try { fs.mkdirSync(screenshotDir, { recursive: true }); } catch { }
        try { fs.mkdirSync(jsonlDir, { recursive: true }); } catch { }

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

                    // Create explicit transition nodes and edges (page and transition nodes; option nodes are treated as transition-type)
                    for (const tr of (res as any).transitions || []) {
                        const trigger = tr.triggerLabel;
                        if (!trigger) continue;
                        const transitionNode = `${normalized}::TRANS::${trigger}`;
                        // Edge from page to transition node
                        actionEdges.push({ to: transitionNode, label: trigger, type: "transition" });

                        // Options: prefer added; if none, fall back to removed (toggle case)
                        const combined = [...new Set([...(tr.added || []), ...(tr.added && tr.added.length ? [] : (tr.removed || []))])];
                        if (!actionGraph[transitionNode]) actionGraph[transitionNode] = [];
                        for (const opt of combined) {
                            if (!opt) continue;
                            const optNode = `${transitionNode}::OPT::${opt}`;
                            // transition node -> option node (click semantics)
                            actionGraph[transitionNode].push({ to: optNode, label: opt, type: "click" });
                            // Option node -> destination (if navigation label matches), else back to page
                            const navMatch = actionEdges.find(e => e.type === "navigate" && e.label && e.label.toLowerCase() === opt.toLowerCase());
                            if (!actionGraph[optNode]) actionGraph[optNode] = [];
                            if (navMatch) {
                                actionGraph[optNode].push({ to: navMatch.to, label: navMatch.label || opt, type: "navigate" });
                            } else {
                                actionGraph[optNode].push({ to: normalized, label: opt, type: "click" });
                            }
                        }
                    }

                    const transitionLabels = new Set<string>(actionEdges.filter(e => e.type === 'transition').map(e => e.label));
                    const filteredEdges = actionEdges.filter(e => !(e.type !== 'navigate' && e.type !== 'transition' && transitionLabels.has(e.label)));

                    graph[normalized] = nextUrls;
                    actionGraph[normalized] = (actionGraph[normalized] || []).concat(filteredEdges);
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

        // JSONL export
        try {
            const pagesPath = path.join(jsonlDir, 'pages.jsonl');
            const edgesPath = path.join(jsonlDir, 'edges.jsonl');
            const pws = fs.createWriteStream(pagesPath);
            const ews = fs.createWriteStream(edgesPath);
            for (const p of pages) {
                const rec = { url: p.url, title: p.title, depth: p.depth, screenshotPath: p.screenshotPath };
                pws.write(JSON.stringify(rec) + "\n");
            }
            for (const [src, edges] of Object.entries(actionGraph)) {
                for (const e of edges) {
                    if (e.type === 'navigate') {
                        const srcTrigger = parseTriggerFromNode(src);
                        const srcOption = parseOptionFromNode(src);
                        const rec: any = { type: 'nav', fromUrl: src, toUrl: e.to, label: e.label };
                        if (srcTrigger) rec.trigger = srcTrigger;
                        if (srcOption) rec.option = srcOption;
                        ews.write(JSON.stringify(rec) + "\n");
                    } else if (e.type === 'transition') {
                        const rec: any = { type: 'transition', fromUrl: src, toUrl: e.to, trigger: e.label };
                        ews.write(JSON.stringify(rec) + "\n");
                    } else {
                        const srcTrigger = parseTriggerFromNode(src);
                        const srcOption = parseOptionFromNode(src);
                        const rec: any = { type: 'click', fromUrl: src, toUrl: e.to, label: e.label };
                        if (srcTrigger) rec.trigger = srcTrigger;
                        if (srcOption) rec.option = srcOption;
                        ews.write(JSON.stringify(rec) + "\n");
                    }
                }
            }
            pws.end(); ews.end();
        } catch { }

        return { pages, graph, actionGraph };
    }
}

export function toDot(result: CrawlResult): string {
    function esc(s: string): string {
        return s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
    }
    function labelFor(url: string): string {
        try {
            const u = new URL(url);
            const pathq = `${u.pathname}${u.search}` || "/";
            return pathq.length > 120 ? pathq.slice(0, 117) + "…" : pathq;
        } catch {
            const tIx = url.indexOf('::TRANS::');
            const oIx = url.indexOf('::OPT::');
            if (tIx >= 0 && oIx === -1) {
                const trigger = url.slice(tIx + '::TRANS::'.length);
                return `▶ ${trigger}`;
            }
            if (oIx >= 0) {
                const opt = url.slice(oIx + '::OPT::'.length);
                return `• ${opt}`;
            }
            return url.length > 120 ? url.slice(0, 117) + "…" : url;
        }
    }
    const lines: string[] = [];
    lines.push("digraph G {");
    lines.push("  rankdir=LR;");
    lines.push("  node [shape=box, style=rounded, fontsize=10];");

    const nodes = new Set<string>([...Object.keys(result.graph)]);
    for (const outs of Object.values(result.graph)) {
        for (const v of outs) nodes.add(v);
    }
    // Also include synthetic transition nodes from actionGraph
    for (const [src, edges] of Object.entries(result.actionGraph)) {
        nodes.add(src);
        for (const e of edges) nodes.add(e.to);
    }

    // Declare page, transition, and option nodes
    for (const n of nodes) {
        const label = esc(labelFor(n));
        const tooltip = esc(n);
        const isTrans = n.includes('::TRANS::');
        const isOpt = n.includes('::OPT::');
        const style = isOpt ? 'dashed,rounded' : (isTrans ? 'dashed,rounded' : 'rounded');
        const color = isOpt ? 'gray50' : (isTrans ? 'dodgerblue' : 'black');
        const extra = isOpt ? ', fillcolor="whitesmoke"' : '';
        lines.push(`  "${esc(n)}" [label="${label}", tooltip="${tooltip}", color="${color}", style="${style}"${extra}];`);
    }

    // Navigation edges (solid) with labels
    for (const [src, outs] of Object.entries(result.graph)) {
        const seen = new Set<string>();
        for (const dst of outs) {
            if (seen.has(dst)) continue; seen.add(dst);
            const acts = (result.actionGraph[src] || []).filter(e => e.type === "navigate" && e.to === dst);
            const lbl = esc((acts[0]?.label) || "");
            if (lbl) {
                lines.push(`  "${esc(src)}" -> "${esc(dst)}" [label="${lbl}"];`);
            } else {
                lines.push(`  "${esc(src)}" -> "${esc(dst)}";`);
            }
        }
    }

    // Action edges: page → transition (dotted), transition → option (dashed), option → page (dashed) or option → destination (solid)
    for (const [src, edges] of Object.entries(result.actionGraph)) {
        for (const e of edges) {
            if (e.type === 'navigate') {
                const isTransSrc = src.includes('::TRANS::') || src.includes('::OPT::');
                if (isTransSrc) {
                    lines.push(`  "${esc(src)}" -> "${esc(e.to)}" [label="${esc(e.label)}"];`);
                }
                continue;
            }
            if (e.type === 'transition') {
                lines.push(`  "${esc(src)}" -> "${esc(e.to)}" [style=dotted, color=dodgerblue, label="${esc(e.label)}"];`);
            } else {
                const isTransSrc = src.includes('::TRANS::') || src.includes('::OPT::');
                const style = isTransSrc ? 'dashed' : 'dashed';
                const color = isTransSrc ? 'gray50' : 'gray50';
                lines.push(`  "${esc(src)}" -> "${esc(e.to)}" [style=${style}, color=${color}, label="${esc(e.label)}"];`);
            }
        }
    }

    lines.push("}");
    return lines.join("\n");
}
