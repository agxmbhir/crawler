// Generic types for post-processing and agent-ready context

export type PageRec = {
    url: string;
    title?: string;
    depth?: number;
    screenshotPath?: string;
};

export type EdgeRec = {
    type: 'nav' | 'transition' | 'click';
    fromUrl: string;
    toUrl: string; // self for non-nav
    label?: string; // for nav/click
    trigger?: string; // for transition or derived from node
    option?: string; // for option node derived edges
    options?: string[]; // deprecated, kept for backward compatibility
};

export type CanonPage = {
    urlCanon: string;
    title?: string;
    depth?: number;
    screenshotPath?: string;
    meta?: {
        tab?: string;
        section?: string;
        stateHints?: Record<string, boolean>;
    };
};

export type SelectorHints = {
    role?: string;
    text?: string;
    attrs?: Record<string, string>;
    css?: string;
};

export type Action = {
    id: string;
    pageUrlCanon: string;
    type: 'nav' | 'click' | 'transition';
    label: string;
    selectorHints?: SelectorHints;
    region?: 'main' | 'dialog' | 'menu';
    options?: string[];
    confidence?: number; // 0..1
};

export type CanonEdge = {
    kind: 'nav' | 'transition' | 'click';
    fromCanon: string;
    toCanon: string; // self for transitions/clicks
    labels: string[]; // merged
    options?: string[]; // merged for transitions
    evidenceIds?: string[];
};

export type Graph = {
    pagesByCanon: Map<string, CanonPage>;
    edgesByFromCanon: Map<string, CanonEdge[]>;
};
