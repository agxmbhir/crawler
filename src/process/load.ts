import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { PageRec, EdgeRec, CanonPage } from './types';


export function canonicalizeUrl(raw: string): string {
    try {
        const u = new URL(raw);
        const params = Array.from(u.searchParams.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
        const search = params.length ? `?${params.join('&')}` : '';
        return `${u.origin}${u.pathname}${search}`;
    } catch {
        return raw;
    }
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
    const items: T[] = [];
    if (!fs.existsSync(filePath)) return items;
    const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
    for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { items.push(JSON.parse(trimmed) as T); } catch { }
    }
    return items;
}

export async function loadPages(jsonlDir: string): Promise<Map<string, CanonPage>> {
    const pagesPath = path.join(jsonlDir, 'pages.jsonl');
    const recs = await readJsonl<PageRec>(pagesPath);
    const map = new Map<string, CanonPage>();
    for (const r of recs) {
        const urlCanon = canonicalizeUrl(r.url);
        if (!map.has(urlCanon)) {
            map.set(urlCanon, {
                urlCanon,
                title: r.title,
                depth: r.depth,
                screenshotPath: r.screenshotPath,
            });
        }
    }
    return map;
}

export async function loadEdges(jsonlDir: string): Promise<EdgeRec[]> {
    const edgesPath = path.join(jsonlDir, 'edges.jsonl');
    return readJsonl<EdgeRec>(edgesPath);
}

export type SimpleGraph = {
    pagesByCanon: Map<string, CanonPage>;
    edgesByFromCanon: Map<string, EdgeRec[]>;
    navByDestCanon: Map<string, EdgeRec[]>;
};

export async function loadGraph(jsonlDir: string): Promise<SimpleGraph> {
    const pagesByCanon = await loadPages(jsonlDir);
    const edges = await loadEdges(jsonlDir);
    const edgesByFromCanon = new Map<string, EdgeRec[]>();
    const navByDestCanon = new Map<string, EdgeRec[]>();

    for (const e of edges) {
        const fromCanon = canonicalizeUrl(e.fromUrl);
        const toCanon = canonicalizeUrl(e.toUrl);
        const rec: EdgeRec = { ...e, fromUrl: fromCanon, toUrl: toCanon };
        const arr = edgesByFromCanon.get(fromCanon) || [];
        arr.push(rec);
        edgesByFromCanon.set(fromCanon, arr);
        if (e.type === 'nav') {
            const arr2 = navByDestCanon.get(toCanon) || [];
            arr2.push(rec);
            navByDestCanon.set(toCanon, arr2);
        }
    }

    return { pagesByCanon, edgesByFromCanon, navByDestCanon };
}
