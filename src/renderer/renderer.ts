export type RendererOptions = {
    headless?: boolean;
    userAgent?: string;
    viewport?: { width: number; height: number; deviceScaleFactor?: number };
    timeoutMs?: number;
    extraHTTPHeaders?: Record<string, string>;
};

export type RenderPageOptions = {
    waitUntil?: Array<"load" | "domcontentloaded" | "networkidle0" | "networkidle2">;
    timeoutMs?: number;
    blockMedia?: boolean;
};

export type ConsoleMessageRecord = {
    type: string;
    text: string;
};

export type RenderResult = {
    url: string;
    statusCode: number | null;
    title: string;
    html: string;
    timingMs: number;
    consoleMessages: ConsoleMessageRecord[];
};

/**
 * Puppeteer-based renderer for loading pages and returning HTML and metadata.
 * Uses dynamic import to be compatible with CommonJS output.
 */
export class Renderer {
    private options: RendererOptions;
    private browser: any | null = null;

    constructor(options?: RendererOptions) {
        this.options = {
            headless: true,
            timeoutMs: 30000,
            ...options,
        };
    }

    async init(): Promise<void> {
        if (this.browser) return;
        const puppeteerModule = (await import("puppeteer")) as any;
        this.browser = await puppeteerModule.launch({
            headless: this.options.headless !== false,
            defaultViewport: this.options.viewport ?? { width: 1366, height: 768, deviceScaleFactor: 1 },
        });
    }

    private async configurePage(page: any, blockMedia?: boolean): Promise<void> {
        if (this.options.userAgent) {
            await page.setUserAgent(this.options.userAgent);
        }

        if (this.options.extraHTTPHeaders) {
            await page.setExtraHTTPHeaders(this.options.extraHTTPHeaders);
        }

        if (blockMedia) {
            await page.setRequestInterception(true);
            page.on("request", (req: any) => {
                const resourceType = req.resourceType();
                if (resourceType === "image" || resourceType === "media" || resourceType === "font") {
                    req.abort();
                } else {
                    req.continue();
                }
            });
        }
    }

    async withPage<T>(fn: (page: any) => Promise<T>, opts?: { blockMedia?: boolean }): Promise<T> {
        if (!this.browser) {
            await this.init();
        }
        const page = await (this.browser as any).newPage();
        try {
            await this.configurePage(page, opts?.blockMedia);
            return await fn(page);
        } finally {
            try {
                if (typeof (page as any).isClosed === 'function') {
                    if (!(page as any).isClosed()) await page.close().catch(() => { });
                } else {
                    await page.close().catch(() => { });
                }
            } catch { }
        }
    }

    async renderAndRun<T>(url: string, fn: (page: any) => Promise<T>, options?: RenderPageOptions & { screenshotPath?: string }): Promise<T> {
        return this.withPage(async (page) => {
            const waitUntil = options?.waitUntil ?? ["load", "domcontentloaded", "networkidle2"];
            const timeout = options?.timeoutMs ?? this.options.timeoutMs ?? 30000;
            try {
                await page.goto(url, { waitUntil: waitUntil as any, timeout });
            } catch { }
            if (options?.screenshotPath) {
                try { await page.screenshot({ path: options.screenshotPath, fullPage: true }); } catch { }
            }
            return fn(page);
        }, { blockMedia: options?.blockMedia });
    }

    async renderPage(url: string, options?: RenderPageOptions): Promise<RenderResult> {
        if (!this.browser) {
            await this.init();
        }

        const page = await this.browser.newPage();

        if (this.options.userAgent) {
            await page.setUserAgent(this.options.userAgent);
        }

        if (this.options.extraHTTPHeaders) {
            await page.setExtraHTTPHeaders(this.options.extraHTTPHeaders);
        }

        if (options?.blockMedia) {
            await page.setRequestInterception(true);
            page.on("request", (req: any) => {
                const resourceType = req.resourceType();
                if (resourceType === "image" || resourceType === "media" || resourceType === "font") {
                    req.abort();
                } else {
                    req.continue();
                }
            });
        }

        const consoleMessages: ConsoleMessageRecord[] = [];
        const consoleListener = (msg: any) => {
            try {
                consoleMessages.push({ type: msg.type?.() ?? "log", text: msg.text?.() ?? String(msg) });
            } catch {
                // ignore
            }
        };
        page.on("console", consoleListener);

        const start = Date.now();
        const waitUntil = options?.waitUntil ?? ["load", "domcontentloaded", "networkidle2"];
        const timeout = options?.timeoutMs ?? this.options.timeoutMs ?? 30000;
        let response: any = null;
        try {
            response = await page.goto(url, { waitUntil: waitUntil as any, timeout });
        } catch (error) {
            // navigation may timeout but still load partially; continue to capture what we can
        }

        const statusCode: number | null = response ? response.status?.() ?? null : null;
        const title: string = await page.title().catch(() => "");
        const html: string = await page.content().catch(() => "");
        const timingMs = Date.now() - start;
        const currentUrl: string = page.url();

        page.off("console", consoleListener);
        try { if (!(page as any).isClosed?.()) await page.close(); } catch { }

        return {
            url: currentUrl,
            statusCode,
            title,
            html,
            timingMs,
            consoleMessages,
        };
    }

    async close(): Promise<void> {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
    }
}


