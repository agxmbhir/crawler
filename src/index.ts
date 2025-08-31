import { Renderer } from "./renderer";
import { Extractor } from "./extractor";
import { Crawler, toDot } from "./crawler";
import * as fs from "fs";
import * as path from "path";

async function main(): Promise<void> {
    const renderer = new Renderer({ headless: true, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36" });
    try {
        await renderer.init();
        const extractor = new Extractor();
        const crawler = new Crawler(renderer, extractor);
        const { pages, graph, actionGraph } = await crawler.crawl({
            seeds: ["https://ant.design/components/modal"],
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


