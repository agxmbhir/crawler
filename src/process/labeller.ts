import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { SimpleGraph } from './load';

export type SiteLabel = { domain: string; description: string };

const DEFAULT_MODEL = 'claude-3-haiku-20240307';

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
        const t = (resp.content?.[0] as any)?.text || '';
        try { return JSON.parse(t); } catch { return { _raw: t }; }
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
        const transitions = edges.filter(e => e.type === 'transition' && (e.trigger || (e.options && e.options.length))).slice(0, maxTransitions).flatMap(e => {
            const trigger = e.trigger || 'Open options';
            const opts = (e.options || []).slice(0, maxTransitions).map(opt => ({ kind: 'transition', label: opt, trigger }));
            return [{ kind: 'transition', label: trigger }, ...opts];
        });
        return [...navs, ...clicks, ...transitions];
    }

    private pageCtxFor(g: SimpleGraph, urlCanon: string, limits: { maxNav: number; maxTransitions: number; maxClicks: number }) {
        const section = sectionOf(urlCanon);
        const tab = tabOf(urlCanon);
        const clickables = this.buildPageClickables(g, urlCanon, limits);
        return { urlCanon, section, tab, clickables };
    }

    private hashInput(site: SiteLabel, pageCtx: any): string {
        const s = JSON.stringify({ site, pageCtx });
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

    private async labelBatch(site: SiteLabel, pagesCtx: any[]): Promise<any[]> {
        const system = 'You label pages and their clickables in batch for an automation agent. Output JSON array only.';
        const payload = { site, pages: pagesCtx };
        const prompt =
            `For each page in the input, return one result in the same order.\n` +
            `For each page, produce: { urlCanon, description (≤1 sentence), tags[3-6], actions[1:1 with clickables] }.\n` +
            `For each action, copy: kind, label, targetPath, trigger (if present). Add only: shortLabel (≤4 words), intentTags (2-5). Do not invent.\n` +
            `Return an array where results[i] corresponds to pages[i].\n` +
            `DATA: ${JSON.stringify(payload)}`;
        const out = await this.callJSON(system, prompt, 2000);
        return Array.isArray(out) ? out : (out?.results || []);
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
        const batchSize = opts?.batchSize ?? 12;
        const concurrency = opts?.concurrency ?? 3;
        const cachePath = opts?.cachePath || path.join(path.dirname(destJsonlPath), 'page_labels_cache.jsonl');

        const dir = path.dirname(destJsonlPath);
        try { fs.mkdirSync(dir, { recursive: true }); } catch { }
        const stream = fs.createWriteStream(destJsonlPath);

        const cache = this.readCache(cachePath);
        const pages = Array.from(g.pagesByCanon.keys());
        const toLabel: { urlCanon: string; pageCtx: any; hash: string }[] = [];
        for (const urlCanon of pages) {
            const pageCtx = this.pageCtxFor(g, urlCanon, limits);
            const hash = this.hashInput(site, pageCtx);
            const cached = cache.get(hash);
            if (cached) {
                stream.write(JSON.stringify({ urlCanon, ...cached }) + '\n');
                continue;
            }
            toLabel.push({ urlCanon, pageCtx, hash });
        }

        // Create batches
        const batches: { items: { urlCanon: string; pageCtx: any; hash: string }[] }[] = [];
        for (let i = 0; i < toLabel.length; i += batchSize) {
            batches.push({ items: toLabel.slice(i, i + batchSize) });
        }

        const cacheAppends: { hash: string; result: any }[] = [];
        await this.runPool(batches, concurrency, async (batch) => {
            const pagesCtx = batch.items.map(it => it.pageCtx);
            const results = await this.withRetries(() => this.labelBatch(site, pagesCtx));
            for (let j = 0; j < batch.items.length; j++) {
                const it = batch.items[j];
                const result = results[j] || { urlCanon: it.pageCtx.urlCanon, _raw: undefined };
                stream.write(JSON.stringify({ urlCanon: it.pageCtx.urlCanon, ...result }) + '\n');
                cacheAppends.push({ hash: it.hash, result });
            }
        });

        this.appendCache(cachePath, cacheAppends);
        stream.end();
    }

    public async labelPages(g: SimpleGraph, destJsonlPath: string, site: SiteLabel, limits?: { maxNav?: number; maxTransitions?: number; maxClicks?: number }) {
        await this.labelPagesBatched(g, destJsonlPath, site, {
            maxNav: limits?.maxNav,
            maxTransitions: limits?.maxTransitions,
            maxClicks: limits?.maxClicks,
            batchSize: 12,
            concurrency: 3,
        });
    }
}
