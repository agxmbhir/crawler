export type Action = {
    type: "navigate" | "click" | "toggle";
    label: string;
    href?: string;
    selector: string;
    options?: string[];
};

export type ExtractOptions = {
    limit?: number;
    probes?: boolean;
    maxProbeTargets?: number;
};

export type Transition = {
    triggerLabel: string;
    triggerSelector: string;
    actions: Action[];
};

export class Extractor {
    async extract(page: any, options?: ExtractOptions): Promise<Action[]> {
        const limit = options?.limit ?? 3000;
        const probes = options?.probes ?? true;
        const maxProbeTargets = options?.maxProbeTargets ?? 12;

        const harvest = async (): Promise<Action[]> => {
            const actions: Action[] = await page.evaluate((max: number) => {
                function isVisible(el: Element): boolean {
                    const style = window.getComputedStyle(el as HTMLElement);
                    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
                    const rect = (el as HTMLElement).getBoundingClientRect();
                    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
                    if (style.pointerEvents === "none") return false;
                    return true;
                }

                function labelOf(el: Element): string {
                    const aria = (el.getAttribute("aria-label") || "").trim();
                    if (aria) return aria;
                    const labelledby = (el.getAttribute("aria-labelledby") || "").trim();
                    if (labelledby) {
                        const idEl = document.getElementById(labelledby);
                        if (idEl) return (idEl.textContent || "").trim();
                    }
                    const title = (el.getAttribute("title") || "").trim();
                    if (title) return title;
                    const placeholder = (el.getAttribute("placeholder") || "").trim();
                    if (placeholder) return placeholder;
                    const alt = (el.getAttribute("alt") || "").trim();
                    if (alt) return alt;
                    const text = (el as HTMLElement).innerText || (el.textContent || "");
                    return (text || "").trim().replace(/\s+/g, " ").slice(0, 180);
                }

                function toSelector(el: Element): string {
                    const id = el.getAttribute("id");
                    if (id) return `#${CSS.escape(id)}`;
                    const classes = (el.getAttribute("class") || "").split(/\s+/).filter(Boolean).slice(0, 2).map(c => `.${CSS.escape(c)}`).join("");
                    const tag = el.tagName.toLowerCase();
                    return `${tag}${classes}`;
                }

                function isDisabled(el: Element): boolean {
                    return (el as any).disabled === true || el.getAttribute("aria-disabled") === "true";
                }

                function nearestContainer(el: Element): Element {
                    let curr: Element | null = el;
                    let depth = 0;
                    while (curr && depth < 5) {
                        const name = curr.tagName.toLowerCase();
                        const role = (curr.getAttribute("role") || "").toLowerCase();
                        const cls = (curr.getAttribute("class") || "");
                        if (role === "group" || role === "region" || role === "dialog" || name === "section" || /card|panel|container|modal|dropdown|menu/.test(cls)) {
                            return curr;
                        }
                        curr = curr.parentElement;
                        depth++;
                    }
                    return el.parentElement || el;
                }

                function gatherOptions(scope: Element): string[] {
                    const opts: string[] = [];
                    const selectors = ["button", "[role='button']", "a[href]", "[data-action]", "[data-testid]", "[tabindex]"];
                    for (const q of selectors) {
                        for (const el of Array.from(scope.querySelectorAll(q))) {
                            if (!isVisible(el)) continue;
                            const lbl = labelOf(el);
                            if (!lbl) continue;
                            if (opts.length >= 8) return opts;
                            opts.push(lbl);
                        }
                    }
                    return Array.from(new Set(opts));
                }

                const queries = [
                    "a[href]",
                    "button",
                    "[role='button']",
                    "[role='menuitem']",
                    "[role='tab']",
                    "input[type='submit']",
                    "input[type='button']",
                    "[onclick]",
                    "[tabindex]",
                    "label[for]"
                ];

                const scopeRoots: Element[] = [document.body, ...Array.from(document.querySelectorAll("[role='dialog'], .modal, .dropdown-menu, [role='menu']"))];

                const out: Action[] = [] as any;
                const seen = new Set<Element>();

                for (const root of scopeRoots) {
                    for (const q of queries) {
                        const nodes = Array.from((root as Element).querySelectorAll(q)) as Element[];
                        for (const el of nodes) {
                            if (seen.has(el)) continue;
                            if (!isVisible(el) || isDisabled(el)) continue;

                            let type: Action["type"] = "click";
                            let href: string | undefined = undefined;
                            let targetEl: Element = el;

                            const tag = el.tagName.toLowerCase();
                            if (tag === "a") {
                                href = (el as HTMLAnchorElement).getAttribute?.("href") || undefined;
                                if (href) type = "navigate";
                            }

                            if (tag === "label" && (el as HTMLLabelElement).htmlFor) {
                                const forId = (el as HTMLLabelElement).htmlFor;
                                const control = document.getElementById(forId);
                                if (control) {
                                    targetEl = control;
                                    const ctag = control.tagName.toLowerCase();
                                    if (ctag === "input") {
                                        const t = (control as HTMLInputElement).type;
                                        if (t === "checkbox" || t === "radio") type = "toggle";
                                        else type = "click";
                                    } else {
                                        type = "click";
                                    }
                                }
                            }

                            const label = labelOf(el);
                            if (!label && tag !== "a") continue;
                            const selector = toSelector(el);

                            let options: string[] | undefined = undefined;
                            if (type !== "navigate") {
                                const container = nearestContainer(el);
                                options = gatherOptions(container).filter(o => o !== label).slice(0, 8);
                            }

                            out.push({ type, label, href, selector, options });
                            seen.add(el);
                            if (out.length >= max) break;
                        }
                        if (out.length >= max) break;
                    }
                    if (out.length >= max) break;
                }

                const uniq: Action[] = [];
                const sig = new Set<string>();
                for (const a of out) {
                    const key = `${a.type}|${a.label}|${a.href || ""}|${a.selector}`;
                    if (sig.has(key)) continue;
                    sig.add(key);
                    uniq.push(a);
                }
                return uniq;
            }, limit);
            return actions;
        };

        let actions: Action[] = await harvest();

        if (probes) {
            try {
                const candidateSelectors = [
                    "[aria-haspopup='true']",
                    "[aria-expanded='false']",
                    "[data-toggle]",
                    "[data-menu]",
                    "[role='button']",
                    ".dropdown-toggle",
                    ".menu-button",
                    "label[for]"
                ];
                const selectorUnion = candidateSelectors.join(", ");
                const handles = await page.$$(selectorUnion);
                let probed = 0;
                for (const h of handles) {
                    if (probed >= maxProbeTargets) break;
                    const box = await h.boundingBox();
                    if (!box || box.width <= 0 || box.height <= 0) { await h.dispose?.(); continue; }
                    try { await h.hover({ position: { x: Math.min(2, box.width - 1), y: Math.min(2, box.height - 1) } }); } catch { }
                    try { await h.focus(); } catch { }
                    await page.waitForTimeout(150);
                    await h.dispose?.();
                    probed++;
                }
                const extra = await harvest();
                const sig = new Set(actions.map(a => `${a.type}|${a.label}|${a.href || ""}|${a.selector}`));
                for (const a of extra) {
                    const key = `${a.type}|${a.label}|${a.href || ""}|${a.selector}`;
                    if (!sig.has(key)) {
                        sig.add(key);
                        actions.push(a);
                    }
                }
            } catch { }
        }

        return actions;
    }

    async discoverTransitions(page: any, maxTriggers: number = 12): Promise<Transition[]> {
        // 1) Pick triggers from current DOM
        const triggers: { label: string; selector: string }[] = await page.evaluate((limit: number) => {
            function isVisible(el: Element): boolean {
                const st = window.getComputedStyle(el as HTMLElement);
                if (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0') return false;
                const r = (el as HTMLElement).getBoundingClientRect();
                return !!r && r.width > 0 && r.height > 0;
            }
            function labelOf(el: Element): string {
                const aria = (el.getAttribute('aria-label') || '').trim(); if (aria) return aria;
                const title = (el.getAttribute('title') || '').trim(); if (title) return title;
                const text = (el as HTMLElement).innerText || (el.textContent || '');
                return (text || '').trim().replace(/\s+/g, ' ').slice(0, 120);
            }
            function toSelector(el: Element): string {
                const id = el.getAttribute('id'); if (id) return `#${CSS.escape(id)}`;
                const cs = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).map(c => `.${CSS.escape(c)}`).join('');
                const tag = el.tagName.toLowerCase();
                return `${tag}${cs}`;
            }
            const out: { label: string; selector: string }[] = [];
            const nodes = Array.from(document.querySelectorAll('button, [role="button"], label[for], [tabindex]'));
            for (const el of nodes) {
                if (!isVisible(el)) continue;
                const label = labelOf(el); if (!label) continue;
                out.push({ label, selector: toSelector(el) });
                if (out.length >= limit) break;
            }
            return out;
        }, maxTriggers);

        async function waitForDomQuiet(page: any, timeoutMs: number = 3000, quietMs: number = 350): Promise<void> {
            await page.evaluate((timeout: number, quiet: number) => new Promise<void>((resolve) => {
                let last = Date.now();
                const obs = new MutationObserver(() => { last = Date.now(); });
                obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
                const iv = setInterval(() => { if (Date.now() - last >= quiet) { clearInterval(iv); obs.disconnect(); resolve(); } }, 50);
                setTimeout(() => { clearInterval(iv); obs.disconnect(); resolve(); }, timeout);
            }), timeoutMs, quietMs).catch(() => { });
        }

        // Track added nodes after a click using a short-lived MutationObserver in the page context
        async function trackAddedNodes(page: any, windowMs: number = 1200): Promise<string[]> {
            const paths: string[] = await page.evaluate((winMs: number) => new Promise<string[]>((resolve) => {
                const added: Element[] = [];
                const obs = new MutationObserver((recs) => {
                    for (const rec of recs) {
                        rec.addedNodes.forEach((n) => { if (n instanceof Element) added.push(n as Element); });
                    }
                });
                obs.observe(document.documentElement, { subtree: true, childList: true });
                setTimeout(() => {
                    obs.disconnect();
                    function nodePath(el: Element): string {
                        const id = el.getAttribute('id');
                        const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
                        return `${el.tagName.toLowerCase()}${id ? `#${id}` : ''}${cls ? `.` + cls : ''}`;
                    }
                    const out = Array.from(new Set(added.map(nodePath)));
                    resolve(out);
                }, winMs);
            }), windowMs).catch(() => []);
            return paths;
        }

        const transitions: Transition[] = [];
        for (const t of triggers) {
            const handle = await page.$(t.selector);
            if (!handle) continue;

            const tryOnce = async (): Promise<Action[]> => {
                try {
                    const beforeFocus: string = await page.evaluate(() => {
                        const ae = document.activeElement as HTMLElement | null;
                        return ae ? (ae.innerText || ae.getAttribute('aria-label') || ae.tagName).slice(0, 120) : '';
                    });

                    await handle.hover().catch(() => { });
                    await handle.click({ delay: 10 }).catch(() => { });

                    const addedPathsPromise = trackAddedNodes(page, 1200);

                    await Promise.race([
                        page.waitForFunction((bf: string) => {
                            const ae = document.activeElement as HTMLElement | null;
                            const now = ae ? (ae.innerText || ae.getAttribute('aria-label') || ae.tagName).slice(0, 120) : '';
                            return now !== bf;
                        }, { timeout: 1800 }, beforeFocus).catch(() => { }),
                        page.waitForFunction(() => !!document.querySelector('[role="dialog"], dialog, [aria-modal="true"], [data-state="open"], [aria-expanded="true"]'), { timeout: 1800 }).catch(() => { }),
                        waitForDomQuiet(page, 1800, 300)
                    ]);

                    const addedPaths = await addedPathsPromise;

                    const actions: Action[] = await page.evaluate(() => {
                        function visible(el: Element): boolean {
                            const st = window.getComputedStyle(el as HTMLElement);
                            const r = (el as HTMLElement).getBoundingClientRect();
                            const rects = (el as HTMLElement).getClientRects();
                            return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0' && r.width > 0 && r.height > 0 && rects.length > 0;
                        }
                        function labelOf(el: Element): string {
                            const aria = (el.getAttribute('aria-label') || '').trim(); if (aria) return aria;
                            const title = (el.getAttribute('title') || '').trim(); if (title) return title;
                            const text = (el as HTMLElement).innerText || (el.textContent || '');
                            return (text || '').trim().replace(/\s+/g, ' ').slice(0, 120);
                        }
                        function pickContainer(): Element | null {
                            // Prefer explicit dialog markers
                            const dialogCandidates = Array.from(document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"]')) as Element[];
                            const visibles = dialogCandidates.filter(visible);
                            if (visibles.length) return visibles[visibles.length - 1];
                            // Fallback: highest z-index fixed/absolute large box
                            const candidates = Array.from(document.querySelectorAll('*')) as Element[];
                            let best: { el: Element; score: number } | null = null;
                            for (const el of candidates) {
                                const st = window.getComputedStyle(el as HTMLElement);
                                if (!(st.position === 'fixed' || st.position === 'absolute')) continue;
                                if (!visible(el)) continue;
                                const r = (el as HTMLElement).getBoundingClientRect();
                                const z = parseInt(st.zIndex || '0', 10) || 0;
                                const area = r.width * r.height;
                                const score = z * 10 + area;
                                if (!best || score > best.score) best = { el, score };
                            }
                            return best?.el || null;
                        }
                        function pickActionRegion(container: Element): Element {
                            const qs = ['footer', '[class*="footer" i]', '[class*="actions" i]', '[data-actions]'];
                            for (const q of qs) {
                                const el = container.querySelector(q);
                                if (el && visible(el)) return el as Element;
                            }
                            return container;
                        }
                        const container = pickContainer() || document.body;
                        const region = pickActionRegion(container);
                        const out: any[] = [];
                        const controlSelectors = ["a[href]", "button", "[role='button']", "input[type='submit']", "input[type='button']"];
                        for (const q of controlSelectors) {
                            for (const el of Array.from(region.querySelectorAll(q))) {
                                if (!visible(el)) continue;
                                const lbl = labelOf(el);
                                if (!lbl) continue;
                                out.push({ type: 'click', label: lbl, selector: '' });
                                if (out.length >= 20) break;
                            }
                            if (out.length >= 20) break;
                        }
                        // Close control inside container
                        const close = container.querySelector('[aria-label*="close" i], .close, .modal-close');
                        if (close && visible(close)) {
                            const cl = labelOf(close) || 'Close';
                            out.push({ type: 'click', label: cl, selector: '' });
                        }
                        const uniq: any[] = []; const sig = new Set<string>();
                        for (const a of out) { const k = `${a.type}|${a.label}`; if (!sig.has(k)) { sig.add(k); uniq.push(a); } }
                        return uniq;
                    });

                    return actions;
                } catch { return []; }
            };

            let actions = await tryOnce();
            if (actions.length === 0) {
                // Retry with longer quiet window
                await waitForDomQuiet(page, 600, 300);
                actions = await tryOnce();
            }

            transitions.push({ triggerLabel: t.label, triggerSelector: t.selector, actions });

            // Reset state
            await page.keyboard.press('Escape').catch(() => { });
            await waitForDomQuiet(page, 600, 250);
        }
        return transitions;
    }
}


