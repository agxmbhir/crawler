import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { SimpleGraph } from './load';

export type SiteLabel = { domain: string; description: string };

const DEFAULT_MODEL = 'claude-3-haiku-20240307';
const SCHEMA_VERSION = 'v2-transition-options-1';

function toPathQuery(u: string): string {
    try { const x = new URL(u); return x.pathname + x.search; } catch { return u; }
}
function sectionOf(u: string): string {
    try { const x = new URL(u); const seg = x.pathname.split('/').filter(Boolean)[0]; return seg || 'root'; } catch { return 'root'; }
}
function tabOf(u: string): string | undefined {
    try { const x = new URL(u); return x.searchParams.get('tab') || undefined; } catch { return undefined; }
}

export class Labeller {
    private client: Anthropic;
    private model: string;

    constructor(opts: { client?: Anthropic; apiKey?: string; model?: string } = {}) {
        if (opts.client) {
            this.client = opts.client;
        } else {
            const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
            if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing');
            this.client = new Anthropic({ apiKey });
        }
        this.model = opts.model || DEFAULT_MODEL;
    }

    private async callJSON(system: string, user: string, max_tokens = 512): Promise<any> {
        const resp = await this.client.messages.create({
            model: this.model,
            max_tokens,
            temperature: 0,
            system,
            messages: [{ role: 'user', content: user }],
        });
        const stop = (resp as any).stop_reason;
        const usage = (resp as any).usage;
        const t = Array.isArray((resp as any).content)
            ? (resp as any).content.map((b: any) => (b && b.type === 'text' && typeof b.text === 'string') ? b.text : '').join('')
            : '';
        if (stop === 'max_tokens') {
            throw new Error(`LLM truncated at max_tokens=${max_tokens}. usage=${JSON.stringify(usage || {})}. First 200 chars: ${t.slice(0, 200)}`);
        }
        try { return JSON.parse(t); } catch {
            throw new Error(`LLM returned non-JSON. First 500 chars: ${t.slice(0, 500)}`);
        }
    }

    public async labelSite(g: SimpleGraph): Promise<SiteLabel> {
        const samplePages = Array.from(g.pagesByCanon.keys());
        if (samplePages.length === 0) throw new Error('No pages to label');
        const domain = new URL(samplePages[0]).origin;
        const sectionsCount = new Map<string, number>();
        const allNavLabels = new Map<string, number>();
        for (const [from, edges] of g.edgesByFromCanon.entries()) {
            const sec = sectionOf(from);
            sectionsCount.set(sec, (sectionsCount.get(sec) || 0) + 1);
            for (const e of edges) if (e.type === 'nav' && e.label) allNavLabels.set(e.label, (allNavLabels.get(e.label) || 0) + 1);
        }
        const topSections = Array.from(sectionsCount.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s]) => s);
        const topNavLabels = Array.from(allNavLabels.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([l]) => l);
        const samplePaths = samplePages.slice(0, 12).map(toPathQuery);

        const siteSystem = 'You label websites. Keep descriptions to one or two concise sentences. Output JSON only.';
        const siteUser = JSON.stringify({ domain, sections: topSections, samplePaths, commonNavLabels: topNavLabels });
        const siteLabel = await this.callJSON(siteSystem, `Summarize the website purpose given this data. Output {domain, description}.\nDATA: ${siteUser}`, 300);
        return { domain, description: siteLabel.description || '' };
    }

    private buildPageClickables(g: SimpleGraph, urlCanon: string, limits: { maxNav: number; maxTransitions: number; maxClicks: number }) {
        const { maxNav, maxTransitions, maxClicks } = limits;
        const edges = g.edgesByFromCanon.get(urlCanon) || [];
        const navs = edges.filter(e => e.type === 'nav' && e.label).slice(0, maxNav).map(e => ({ kind: 'nav', label: e.label!, targetPath: toPathQuery(e.toUrl) }));
        const clicks = edges.filter(e => e.type === 'click' && e.label).slice(0, maxClicks).map(e => ({ kind: 'click', label: e.label! }));

        // Transitions: page -> transitionNode (type=transition); then transitionNode -> optionNode (type=click);
        // Prefer explicit trigger/option fields from JSONL if present.
        const transitionEdges = edges.filter(e => e.type === 'transition').slice(0, maxTransitions);
        const transitions: any[] = [];
        for (const te of transitionEdges) {
            const trigger = te.trigger || te.label || 'Open options';
            const transOut = g.edgesByFromCanon.get(te.toUrl) || [];
            // Candidate option edges: click edges with option label or label
            const optionEdges = transOut.filter(e => e.type === 'click');
            const opts = optionEdges.slice(0, maxTransitions).map(oe => {
                const optLabel = oe.option || oe.label || 'Option';
                const optOut = g.edgesByFromCanon.get(oe.toUrl) || [];
                const navEdge = optOut.find(x => x.type === 'nav');
                const targetPath = navEdge ? toPathQuery(navEdge.toUrl) : undefined;
                return { kind: 'transition', label: optLabel, trigger, targetPath };
            });
            transitions.push({ kind: 'transition', label: trigger });
            transitions.push(...opts);
        }
        return [...navs, ...clicks, ...transitions];
    }

    // Fallbacks removed to propagate errors

    private pageCtxFor(g: SimpleGraph, urlCanon: string, limits: { maxNav: number; maxTransitions: number; maxClicks: number }) {
        const section = sectionOf(urlCanon);
        const tab = tabOf(urlCanon);
        const clickables = this.buildPageClickables(g, urlCanon, limits);
        return { urlCanon, section, tab, clickables };
    }

    private hashInput(site: SiteLabel, pageCtx: any): string {
        const s = JSON.stringify({ v: SCHEMA_VERSION, site, pageCtx });
        return createHash('sha256').update(s).digest('hex');
    }

    private readCache(cachePath: string): Map<string, any> {
        const map = new Map<string, any>();
        if (!fs.existsSync(cachePath)) return map;
        const data = fs.readFileSync(cachePath, 'utf8');
        for (const line of data.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try { const obj = JSON.parse(trimmed); if (obj.hash && obj.result) map.set(obj.hash, obj.result); } catch { }
        }
        return map;
    }

    private appendCache(cachePath: string, items: { hash: string; result: any }[]) {
        if (items.length === 0) return;
        const dir = path.dirname(cachePath);
        try { fs.mkdirSync(dir, { recursive: true }); } catch { }
        fs.appendFileSync(cachePath, items.map(i => JSON.stringify(i)).join('\n') + '\n');
    }

    private async withRetries<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 500): Promise<T> {
        let lastErr: any;
        for (let i = 0; i < attempts; i++) {
            try { return await fn(); } catch (err) {
                lastErr = err;
                const delay = baseDelayMs * Math.pow(2, i);
                await new Promise(res => setTimeout(res, delay));
            }
        }
        throw lastErr;
    }

    // Per-page chunked labeling to avoid truncation
    private chunk<T>(arr: T[], size: number): T[][] {
        const out: T[][] = [];
        for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
        return out;
    }

    private async labelActionsChunk(site: SiteLabel, urlCanon: string, section: string, tab: string | undefined, clickablesChunk: any[], offset: number): Promise<any[]> {
        const system = 'You label actions for browser automation. Output JSON object only.';
        const payload = { site, page: { urlCanon, section, tab }, offset, clickables: clickablesChunk };
        const prompt =
            `Return object: { actions }.\n` +
            `actions MUST be same length and order as provided clickables.\n` +
            `For each action COPY fields: { kind, label, targetPath, trigger } and ADD: { shortLabel (≤4 words), intentTags (2-5) }.\n` +
            `Do not invent targets. If unknown, omit targetPath.\n` +
            `DATA: ${JSON.stringify(payload)}`;
        const maxTokens = 1500; // ample for a small chunk
        const out = await this.callJSON(system, prompt, maxTokens);
        const actions = Array.isArray(out?.actions) ? out.actions : [];
        if (actions.length !== clickablesChunk.length) throw new Error(`LLM chunk length mismatch: got ${actions.length}, expected ${clickablesChunk.length}`);
        return actions;
    }

    private async labelDescTags(site: SiteLabel, urlCanon: string, section: string, tab: string | undefined, clickablesSample: any[]): Promise<{ description: string; tags: string[] }> {
        const system = 'You summarize a page for an automation agent. Output JSON object only.';
        const payload = { site, page: { urlCanon, section, tab, clickablesSample } };
        const prompt =
            `Return: { description, tags }.\n` +
            `description ≤ 1 sentence. tags: 3-6 short keywords.\n` +
            `DATA: ${JSON.stringify(payload)}`;
        const out = await this.callJSON(system, prompt, 600);
        const description = typeof out?.description === 'string' ? out.description : '';
        const tags = Array.isArray(out?.tags) ? out.tags.filter((t: any) => typeof t === 'string').slice(0, 8) : [];
        return { description, tags };
    }

    private async labelPageChunked(site: SiteLabel, pageCtx: any): Promise<any> {
        const { urlCanon, section, tab } = pageCtx;
        const clickables = pageCtx.clickables || [];
        const chunks = this.chunk(clickables, 12);
        const actions: any[] = [];
        for (let i = 0; i < chunks.length; i++) {
            const chunkActs = await this.labelActionsChunk(site, urlCanon, section, tab, chunks[i], actions.length);
            actions.push(...chunkActs);
        }
        const { description, tags } = await this.labelDescTags(site, urlCanon, section, tab, clickables.slice(0, 6));
        return { urlCanon, description, tags, actions };
    }

    private async runPool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
        const ret: R[] = [];
        let i = 0;
        const running: Promise<void>[] = [];
        const next = async () => {
            if (i >= items.length) return;
            const idx = i++;
            const it = items[idx];
            const p = (async () => { const r = await worker(it); (ret as any)[idx] = r; })();
            running.push(p.then(() => { running.splice(running.indexOf(p), 1); }));
            if (running.length >= limit) await Promise.race(running);
            return next();
        };
        await next();
        await Promise.all(running);
        return ret;
    }

    public async labelPagesBatched(g: SimpleGraph, destJsonlPath: string, site: SiteLabel, opts?: { maxNav?: number; maxTransitions?: number; maxClicks?: number; batchSize?: number; concurrency?: number; cachePath?: string }) {
        const limits = {
            maxNav: opts?.maxNav ?? 20,
            maxTransitions: opts?.maxTransitions ?? 12,
            maxClicks: opts?.maxClicks ?? 12,
        };
        const concurrency = opts?.concurrency ?? 2;
        const cachePath = opts?.cachePath || path.join(path.dirname(destJsonlPath), 'page_labels_cache.jsonl');

        const dir = path.dirname(destJsonlPath);
        try { fs.mkdirSync(dir, { recursive: true }); } catch { }
        const stream = fs.createWriteStream(destJsonlPath);

        const pages = Array.from(g.pagesByCanon.keys());
        const toLabel: { urlCanon: string; pageCtx: any }[] = pages.map(urlCanon => ({ urlCanon, pageCtx: this.pageCtxFor(g, urlCanon, limits) }));

        await this.runPool(toLabel, concurrency, async (it) => {
            const out = await this.withRetries(() => this.labelPageChunked(site, it.pageCtx), 1, 500);
            stream.write(JSON.stringify(out) + '\n');
            return out;
        });

        stream.end();
    }

    public async labelPages(g: SimpleGraph, destJsonlPath: string, site: SiteLabel, limits?: { maxNav?: number; maxTransitions?: number; maxClicks?: number }) {
        await this.labelPagesBatched(g, destJsonlPath, site, {
            maxNav: limits?.maxNav,
            maxTransitions: limits?.maxTransitions,
            maxClicks: limits?.maxClicks,
            concurrency: 2,
        });
    }
}
