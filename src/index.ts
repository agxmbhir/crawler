import { Renderer } from "./renderer";
import { Extractor } from "./extractor";
import { Crawler, toDot } from "./crawler";
import * as fs from "fs";
import * as path from "path";

async function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function main(): Promise<void> {
    const manualLoginUrl = process.env.MANUAL_LOGIN_URL; // optional
    const loginWaitMs = Number(process.env.LOGIN_WAIT_MS || 120000); // default 3 minutes
    const seedUrl = process.env.SEED_URL || "https://ant.design/components/modal";

    const renderer = new Renderer({ headless: manualLoginUrl ? false : true, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36" });
    try {
        await renderer.init();

        if (manualLoginUrl) {
            console.log(`Opening login page and waiting ${Math.round(loginWaitMs / 1000)}s for you to complete login...`);
            await renderer.withPage(async (page: any) => {
                await page.goto(manualLoginUrl, { waitUntil: ["load", "domcontentloaded"] });
                await sleep(loginWaitMs);
            }, { blockMedia: false });
            console.log("Continuing with crawl using your session...");
        }

        const extractor = new Extractor();
        const crawler = new Crawler(renderer, extractor);
        const { pages, graph, actionGraph } = await crawler.crawl({
            seeds: [seedUrl],
            maxDepth: 1,
            maxPages: 10,
            sameOrigin: true,
            delayMs: 0,
            concurrency: 4,
            discoverTransitions: true,
            transitionsPerPage: 12,
            screenshotDir: path.join(process.cwd(), "out", "screens"),
        });
        console.log(`visited pages: ${pages.length}`);
        console.log(pages.map(p => ({ url: p.url, depth: p.depth, actions: p.actions.length, screenshot: p.screenshotPath })));
        const outDir = path.join(process.cwd(), "out");
        const outFile = path.join(outDir, "site.dot");
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(outFile, toDot({ pages, graph, actionGraph }), "utf8");
        console.log(`DOT graph written to: ${outFile}`);
        console.log(`Screenshots saved to: ${path.join(process.cwd(), "out", "screens")}`);
    } finally {
        await renderer.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});


