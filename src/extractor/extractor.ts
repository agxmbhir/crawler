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
    added?: string[];
    removed?: string[];
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

                function excludeGlobal(el: Element): boolean {
                    const tag = el.tagName.toLowerCase();
                    if (tag === 'header' || tag === 'nav' || tag === 'aside') return true;
                    const st = window.getComputedStyle(el as HTMLElement);
                    const r = (el as HTMLElement).getBoundingClientRect();
                    if ((st.position === 'fixed' || st.position === 'sticky') && r.height < 140) return true;
                    return false;
                }

                function pickPrimaryRegion(): Element {
                    const main = document.querySelector('[role="main"]');
                    if (main && isVisible(main as Element)) return main as Element;
                    const vw = window.innerWidth, vh = window.innerHeight;
                    const cx = vw / 2, cy = vh / 2;
                    let best: { el: Element; score: number } | null = null;
                    const nodes = Array.from(document.body.querySelectorAll('*')) as Element[];
                    for (const el of nodes) {
                        if (!isVisible(el) || excludeGlobal(el)) continue;
                        const st = window.getComputedStyle(el as HTMLElement);
                        if (st.position === 'fixed' || st.position === 'sticky') continue;
                        const r = (el as HTMLElement).getBoundingClientRect();
                        const dist = Math.hypot((r.left + r.width / 2) - cx, (r.top + r.height / 2) - cy);
                        const area = r.width * r.height;
                        const score = area - dist * 50;
                        if (!best || score > best.score) best = { el, score };
                    }
                    return best?.el || document.body;
                }

                const primaryRegion = pickPrimaryRegion();

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

                // Also search within dialogs/menus if they are present
                const overlayRoots = Array.from(document.querySelectorAll("[role='dialog'], dialog, [aria-modal='true'], .modal, .dropdown-menu, [role='menu']")) as Element[];
                const scopeRoots: Element[] = [primaryRegion, ...overlayRoots];

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
                            if (!label && tag !== "a") continue; // skip unlabeled non-links
                            const selector = toSelector(el);

                            let options: string[] | undefined = undefined;
                            if (type !== "navigate") {
                                // best-effort local options from nearest container
                                let container: Element = el.parentElement || el;
                                for (let i = 0; i < 4 && container.parentElement; i++) container = container.parentElement;
                                const opts: string[] = [];
                                for (const q2 of ["button", "[role='button']", "a[href]", "input[type='submit']", "input[type='button']"]) {
                                    for (const c of Array.from(container.querySelectorAll(q2))) {
                                        if (!isVisible(c)) continue;
                                        const l2 = labelOf(c);
                                        if (!l2 || l2 === label) continue;
                                        opts.push(l2);
                                        if (opts.length >= 8) break;
                                    }
                                    if (opts.length >= 8) break;
                                }
                                options = Array.from(new Set(opts));
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
        // Pick triggers from current DOM (kept simple)
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
            const nodes = Array.from(document.querySelectorAll('button, [role="button"], label[for], [tabindex], [role="tab"], [aria-haspopup="true"]'));
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

        // Helper: collect labels inside a container scoped to the trigger
        async function collectScopedLabels(elHandle: any, mode: 'pre' | 'post'): Promise<string[]> {
            return await page.evaluate((el: Element, modeArg: string) => {
                function visible(el: Element): boolean {
                    const st = window.getComputedStyle(el as HTMLElement);
                    const r = (el as HTMLElement).getBoundingClientRect();
                    return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0' && r.width > 0 && r.height > 0;
                }
                function labelOf(el: Element): string {
                    const aria = (el.getAttribute('aria-label') || '').trim(); if (aria) return aria;
                    const title = (el.getAttribute('title') || '').trim(); if (title) return title;
                    const txt = (el as HTMLElement).innerText || (el.textContent || '');
                    return (txt || '').trim().replace(/\s+/g, ' ').slice(0, 120);
                }
                function excludeGlobal(el: Element | null): boolean {
                    if (!el) return false;
                    const tag = el.tagName.toLowerCase();
                    if (tag === 'header' || tag === 'nav' || tag === 'aside') return true;
                    const st = window.getComputedStyle(el as HTMLElement);
                    const r = (el as HTMLElement).getBoundingClientRect();
                    if ((st.position === 'fixed' || st.position === 'sticky') && r.top <= 0 && r.height < 140) return true;
                    return false;
                }
                function nearestMenuContainer(start: Element | null): Element | null {
                    let cur: Element | null = start;
                    while (cur) {
                        const cand = (cur.closest('[role="menu"], [role="listbox"], [data-sidebar="menu"], [data-sidebar="group"], ul, nav, aside') as Element) || null;
                        if (cand && visible(cand)) return cand;
                        cur = cur.parentElement;
                    }
                    return null;
                }
                function baselineContainerFor(trigger: Element): Element {
                    const id = trigger.getAttribute('aria-controls');
                    if (id) {
                        const target = document.getElementById(id);
                        if (target && visible(target)) return target as Element;
                    }
                    if ((trigger.getAttribute('role') || '').toLowerCase() === 'tab') {
                        const tid = trigger.getAttribute('id');
                        if (tid) {
                            const panel = document.querySelector(`[role="tabpanel"][aria-labelledby="${CSS.escape(tid)}"]`);
                            if (panel && visible(panel as Element)) return panel as Element;
                        }
                    }
                    const menu = nearestMenuContainer(trigger);
                    if (menu) return menu;
                    let up: Element = trigger;
                    for (let i = 0; i < 3 && up.parentElement; i++) up = up.parentElement as Element;
                    return up;
                }
                function postContainerFor(trigger: Element, baseline: Element): Element {
                    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"')) as Element[];
                    const vis = dialogs.filter(visible);
                    if (vis.length) return vis[vis.length - 1];
                    const id = trigger.getAttribute('aria-controls');
                    if (id) {
                        const target = document.getElementById(id);
                        if (target && visible(target)) return target as Element;
                    }
                    if ((trigger.getAttribute('role') || '').toLowerCase() === 'tab') {
                        const tid = trigger.getAttribute('id');
                        if (tid) {
                            const panel = document.querySelector(`[role="tabpanel"][aria-labelledby="${CSS.escape(tid)}"]`);
                            if (panel && visible(panel as Element)) return panel as Element;
                        }
                    }
                    const expanded = trigger.closest('[aria-expanded="true"]') || trigger;
                    const menu = nearestMenuContainer(expanded as Element);
                    if (menu) return menu;
                    return baseline;
                }
                function collect(root: Element): string[] {
                    const labels: string[] = [];
                    const sels = ['a[href]', 'button', '[role="button"]', '[role="menuitem"]', '[role="tab"]', 'input[type="submit"]', 'input[type="button"]'];
                    for (const q of sels) {
                        for (const el of Array.from(root.querySelectorAll(q))) {
                            if (!visible(el) || excludeGlobal(el)) continue;
                            const l = labelOf(el); if (!l) continue;
                            labels.push(l);
                            if (labels.length >= 40) break;
                        }
                        if (labels.length >= 40) break;
                    }
                    return Array.from(new Set(labels));
                }
                try {
                    const trigger = el;
                    const base = baselineContainerFor(trigger);
                    const mode = modeArg === 'pre' ? 'pre' : 'post';
                    const container = mode === 'pre' ? base : postContainerFor(trigger, base);
                    return collect(container);
                } catch { return []; }
            }, elHandle, mode as any).catch(() => []);
        }

        const transitions: Transition[] = [];
        for (const t of triggers) {
            const handle = await page.$(t.selector);
            if (!handle) continue;

            const preLabels = await collectScopedLabels(handle, 'pre');

            try { await handle.hover({}); } catch { }
            try { await handle.click({ delay: 10 }); } catch { }

            await Promise.race([
                page.waitForFunction(() => !!document.querySelector('[role="dialog"], dialog, [aria-modal="true"], [data-state="open"], [aria-expanded="true"]'), { timeout: 1500 }).catch(() => { }),
                waitForDomQuiet(page, 1500, 250)
            ]);

            const postLabels = await collectScopedLabels(handle, 'post');

            const preSet = new Set(preLabels);
            const postSet = new Set(postLabels);
            const added = postLabels.filter(l => !preSet.has(l));
            const removed = preLabels.filter(l => !postSet.has(l));

            const actions: Action[] = postLabels.map(l => ({ type: 'click', label: l, selector: '' }));
            transitions.push({ triggerLabel: t.label, triggerSelector: t.selector, actions, added, removed });

            await page.keyboard.press('Escape').catch(() => { });
            await waitForDomQuiet(page, 600, 200);
        }
        return transitions;
    }
}


