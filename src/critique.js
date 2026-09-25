// Visualization Critique and Redesign — page entry.
//
// Section 3 renders the redesign: an interactive Sankey of flight-simulator
// switching from the 2026 FlightSim Community Survey. The prose lives in
// critique/index.html; this file builds the two figures and the detail panel.
//
// Why the redesign differs from the original:
//
//   1. Over-plotting. The original draws all fifteen categories twice over.
//      Here the resting state is deliberately quiet — neutral ribbons, coloured
//      bars — and colour is spent only on the one simulator the reader is asking
//      about, chosen from the chip row or by hovering the chart.
//
//   2. Effectiveness. The original answers only "where did switchers go". The
//      matrix keeps the non-switchers, so drawing BOTH columns lets the bar
//      heights carry the market-share shift (MSFS 2020 falls 50.5% -> 29.6%
//      while MSFS 2024 rises 22.9% -> 45.6%) at the same time as the flows.
//
// The layout is a single stage (previous -> current). d3-sankey keys nodes by
// id across the WHOLE graph and every category appears on both sides, so ids
// are namespaced `prev:` / `curr:`. Without that namespacing the diagonal link
// becomes a true self-loop and d3-sankey throws `Error: circular link` out of
// computeNodeDepths — the chart never renders at all, rather than rendering
// wrongly.

import * as d3 from 'd3';
import { sankey, sankeyLinkHorizontal } from 'd3-sankey';
import { mountNav } from './labs/nav.js';
import './styles/main.css';

mountNav('#nav');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Kept as individual categories; every other source label folds into "Others".
const KEPT = ['MSFS2024', 'MSFS2020', 'XP12', 'XP11', 'GeoFS', 'P3D'];
const CATS = [...KEPT, 'Others'];

// Column order is fixed and identical on both sides, rather than sorted by
// size. Sorting each column by its own total would cross far more ribbons and
// would break the one thing the all-respondents view is for: with both columns
// in the same order the diagonal reads as a straight band, so "who stayed" is
// legible at a glance.
const LABEL = {
    MSFS2024: 'MSFS 2024',
    MSFS2020: 'MSFS 2020',
    XP12: 'X-Plane 12',
    XP11: 'X-Plane 11',
    GeoFS: 'GeoFS',
    P3D: 'Prepar3D',
    Others: 'Others',
};

// Six of the eleven topic colours used by Lab 8. That set is validated
// all-pairs against a light surface — worst pair 15.6 delta-E under normal
// vision and 8.3 under deuteranopia — and because the validation is all-pairs,
// any subset inherits it: the worst pair among six is at least as good as the
// worst pair among eleven. The comment is carried over from lab8.js so the
// provenance survives; the array is copied rather than imported, because
// lab8.js is an entry module that calls mountNav() and draw() at its tail.
const SIM_COLORS = [
    '#884117', // brown
    '#c56b23', // orange
    '#70c170', // green
    '#1c8f6e', // teal
    '#5cb6e6', // light blue
    '#2e5794', // navy
];

// "Others" is a residual bin, not a category: giving it a saturated first-class
// hue would read as a peer of the six named simulators. It takes Lab 8's
// existing everything-else tone instead.
const OTHER_COLOR = '#c3c2b7';

// Dimmed ribbons and bars. Deliberately lighter than OTHER_COLOR so that
// "dimmed" and "the Others category" can never be mistaken for each other.
const NEUTRAL = '#cfcec7';
const NODE_DIM = '#dcdbd4';

const INK = '#0b0b0b';
const INK_2 = '#52514e';
// Connector lines from a displaced label back to its bar. These carry meaning —
// they are the only thing tying a moved label to its bar — so they are drawn in
// this mid grey rather than the much lighter gridline tone used elsewhere.
const CONNECTOR = '#898781';

const RING_COLOR = '#0b0b0b';
const RING_W = 2;
const RING_PAD = 3;

// Resting ribbons are neutral; flip this to colour them by source category and
// the page becomes the thing it is criticising. Kept as a named switch so the
// default is a decision rather than an accident.
const RIBBON_BY_SOURCE = false;

const RIBBON_OPACITY = 0.42;
const RIBBON_OPACITY_HOT = 0.78;
const RIBBON_OPACITY_DIM = 0.10;

// Ribbon width is the count, so sub-pixel flows are both invisible and
// unhittable. The node column is 568px tall and the scale works out at
// 0.0215px per respondent, so 23 of the 49 ribbons — very nearly half the
// chart — fall under one pixel, the smallest at 0.02px. Flooring the painted
// width at 1px costs about 1.6% of the column height and keeps the long tail
// visible; a separate transparent hit layer, below, keeps it hoverable
// regardless.
const MIN_RIBBON_W = 1;
const HIT_RIBBON_W = 9;

const W = 920;
const H = 700;
const M = { top: 34, right: 116, bottom: 38, left: 128 };
const NODE_W = 16;
const NODE_PAD = 10;

// Label rows need this much vertical room each. With seven nodes the column is
// exactly full — sum(heights) == 620 - 6*10 — so the gap between adjacent bars
// is NODE_PAD and nothing more. A three-line label cannot sit beside an 8px
// bar, so the labels are de-collided by spread() and tied to their bars by a
// connector rather than by proximity.
const LINE_H = 13;
const LABEL_GAP = { prev: 34, curr: 46 };

const FOCUS_DUR = 140;

// Only what the guide above does not already say. Each mode gets its own base,
// and each base has a caveat that is invisible from the picture: in the
// all-respondents view the diagonal ribbons are non-movers, and in the
// switchers view two groups of people are missing or disguised.
const BASE_NOTE = {
    all: (t) =>
        `Base: all ${n0(t)} respondents. Ribbons running straight across are people who `
        + `did not change simulator.`,
    sw: (t, all) =>
        `Base: the ${n0(t)} respondents who changed simulator — ${pct(t, all)} of the `
        + `sample. The 1,976 who left a simulator and later returned are not in this view. `
        + `The 79 flows inside "Others" are moves between two of the nine simulators that `
        + `bin groups.`,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

const n0 = d3.format(',');
const pct = (v, total) => (total ? `${((100 * v) / total).toFixed(1)}%` : '—');
const signedPct = (v, total) => {
    if (!total) return '—';
    const x = (100 * v) / total;
    if (Math.abs(x) < 0.05) return '0.0pp';
    return `${x > 0 ? '+' : '−'}${Math.abs(x).toFixed(1)}pp`;
};

const key = (from, to) => `${from}\u0000${to}`;
const bucket = (cat) => (KEPT.includes(cat) ? cat : 'Others');
const colourOf = (cat) => (cat === 'Others' ? OTHER_COLOR : SIM_COLORS[KEPT.indexOf(cat)]);

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

// Both matrices are 15x15 wide tables (previous x current) with a trailing
// `total` column. They differ ONLY on the diagonal: the all-respondents file
// counts the people who did not move, the switchers file zeroes them.
//
// Collapsing to seven categories is done here rather than in
// critique/prepare_survey.py so that the 15-category CSVs stay the single data
// contract, data/survey_eda.md keeps matching its source, and the grouping rule
// is visible next to the chart it produces.
//
// The one thing to know about the grouped switchers matrix: because "Others"
// absorbs nine simulators, the 79 people who moved BETWEEN two of those nine
// land back on the Others diagonal. That is why Others is the only non-zero
// diagonal cell in switchers mode, and it is a real flow, not a rounding error.
function collapse(rows) {
    const sims = rows.columns.filter((c) => c !== 'previous' && c !== 'total');
    const grid = new Map();
    for (const from of CATS) for (const to of CATS) grid.set(key(from, to), 0);
    for (const row of rows) {
        const from = bucket(row.previous);
        for (const sim of sims) {
            const v = +row[sim] || 0;
            if (!v) continue;
            const k = key(from, bucket(sim));
            grid.set(k, grid.get(k) + v);
        }
    }
    return grid;
}

function margins(grid) {
    const prev = new Map();
    const curr = new Map();
    let total = 0;
    for (const cat of CATS) {
        let r = 0;
        let c = 0;
        for (const other of CATS) {
            r += grid.get(key(cat, other));
            c += grid.get(key(other, cat));
        }
        prev.set(cat, r);
        curr.set(cat, c);
        total += r;
    }
    return { prev, curr, total };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// A focus is `{ cat, side }`, where `side` is 'prev', 'curr' or null:
//
//   side: 'prev'  — the FROM bar was clicked: light only the flows leaving it
//   side: 'curr'  — the TO bar was clicked:   light only the flows arriving at it
//   side: null    — a legend chip was clicked: light the category on both sides
//
// The two entry points mean different things and should stay different. A bar is
// ONE end of a flow — "where did this bar's people go", or "where did this bar's
// people come from" — whereas a chip names a simulator on both sides at once.
const state = { mode: 'all', hover: null, pinned: null };

const focus = () => state.pinned ?? state.hover;
const sameFocus = (a, b) => a === b || (a && b && a.cat === b.cat && a.side === b.side);

/** Is this ribbon part of the focus? */
function isHot(l, f) {
    if (!f) return false;
    if (f.side === 'prev') return l.source.cat === f.cat;   // leaving the from bar
    if (f.side === 'curr') return l.target.cat === f.cat;   // arriving at the to bar
    return l.source.cat === f.cat || l.target.cat === f.cat;
}

/** Is this bar part of the focus? A side focus lights one bar, not both. */
const isLit = (d, f) => !!f && d.cat === f.cat && (f.side === null || f.side === d.side);

const GRIDS = {};
const MARG = {};

let graph = null;
let sel = {};       // the d3 selections updateFocus() rewrites

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const DUR = reducedMotion ? 0 : FOCUS_DUR;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

// Fresh node and link objects on every call. d3-sankey mutates both in place —
// it replaces link.source/target with node references and writes x0/y0/value
// onto the nodes — so reusing a laid-out graph across a mode switch would carry
// stale links and a stale value.
function buildGraph(grid) {
    const nodes = CATS.map((cat) => ({ id: `prev:${cat}`, cat, side: 'prev' }))
        .concat(CATS.map((cat) => ({ id: `curr:${cat}`, cat, side: 'curr' })));
    const links = [];
    for (const from of CATS) {
        for (const to of CATS) {
            const v = grid.get(key(from, to));
            if (v > 0) links.push({ source: `prev:${from}`, target: `curr:${to}`, value: v });
        }
    }
    return { nodes, links };
}

function layout(grid) {
    return sankey()
        .nodeId((d) => d.id)
        // `null`, not the default `undefined`. The default re-sorts each column
        // by breadth on every relaxation pass, so the final vertical order is
        // whatever the relaxation settles on; passing null disables that sort as
        // well as the initial one, which is what preserves CATS order.
        .nodeSort(null)
        .nodeWidth(NODE_W)
        .nodePadding(NODE_PAD)
        .extent([[M.left, M.top], [W - M.right, H - M.bottom]])(buildGraph(grid));
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

// Push label baselines apart so no two are closer than `gap`, then slide the
// whole block back inside [lo, hi]. One forward sweep plus one uniform shift is
// enough for seven labels and preserves order, so no label ever jumps past
// another simulator.
function spread(rows, gap, lo, hi) {
    rows.forEach((r, i) => {
        r.y = i === 0
            ? Math.min(r.anchor, hi)
            : Math.max(r.anchor, rows[i - 1].y + gap);
    });
    const over = rows[rows.length - 1].y - hi;
    if (over > 0) rows.forEach((r) => { r.y -= over; });
    rows.forEach((r) => { r.y = Math.min(Math.max(r.y, lo), hi); });
    return rows;
}

function labelRows(side) {
    const rows = graph.nodes
        .filter((d) => d.side === side)
        .map((d) => ({ d, anchor: (d.y0 + d.y1) / 2, y: (d.y0 + d.y1) / 2 }));
    return spread(rows, LABEL_GAP[side], M.top, H - M.bottom);
}

function drawLabels() {
    const { prev: pTot, curr: cTot, total } = MARG[state.mode];

    for (const side of ['prev', 'curr']) {
        const isPrev = side === 'prev';
        const x = isPrev ? M.left - 14 : W - M.right + 14;
        const rows = labelRows(side);
        const sideTotals = isPrev ? pTot : cTot;

        const g = sel.labels.selectAll(`g.lab-${side}`)
            .data(rows)
            .join('g')
            .attr('class', `lab-${side}`)
            .attr('transform', (r) => `translate(${x},${r.y})`);

        const lines = (r) => {
            const cat = r.d.cat;
            const v = sideTotals.get(cat);
            const base = [`${LABEL[cat]}`, `${n0(v)} · ${pct(v, total)}`];
            if (isPrev) return base;
            const delta = v - pTot.get(cat);
            return base.concat(signedPct(delta, total));
        };

        const text = g.selectAll('text')
            .data((r) => lines(r).map((t, i) => ({ r, t, i, n: lines(r).length })))
            .join('text')
            .attr('class', 'lab-line')
            .attr('text-anchor', isPrev ? 'end' : 'start')
            .attr('dominant-baseline', 'middle')
            .attr('x', 0)
            .attr('y', (d) => (d.i - (d.n - 1) / 2) * LINE_H);

        text.attr('fill', (d) => (d.i === 0 ? INK : INK_2))
            .attr('font-weight', (d) => (d.i === 0 ? 600 : 400))
            .text((d) => d.t);

        // A label that had to move away from its bar gets a connector. Proximity
        // is no longer what ties the two together, so the line has to be.
        const conn = g.selectAll('line.conn')
            .data((r) => (Math.abs(r.y - r.anchor) > 3 ? [r] : []))
            .join('line')
            .attr('class', 'conn')
            .attr('x1', isPrev ? 12 : -12)
            .attr('y1', (r) => r.anchor - r.y)
            .attr('x2', 0)
            .attr('y2', 0)
            .attr('stroke', CONNECTOR)
            .attr('stroke-width', 1);
        conn.lower();
    }
}

// ---------------------------------------------------------------------------
// Focus
// ---------------------------------------------------------------------------

// The only function that writes paint onto ribbons, bars or labels. It never
// touches stroke-width or `d`: both of those carry counts, and animating them
// on hover would be animating the data.
function updateFocus(animate = true) {
    if (!graph) return;
    const f = focus();
    const hot = (l) => isHot(l, f);
    const put = (s) => (DUR && animate ? s.transition('focus').duration(DUR) : s.interrupt('focus'));

    // Lit ribbons have to paint above the dimmed field, or a grey ribbon
    // crossing a lit one cuts a grey band through it.
    sel.ribbons.sort((a, b) => (hot(a) ? 1 : 0) - (hot(b) ? 1 : 0));

    put(sel.ribbons)
        .attr('stroke', (l) => {
            if (!f) return RIBBON_BY_SOURCE ? colourOf(l.source.cat) : NEUTRAL;
            return hot(l) ? colourOf(l.source.cat) : NEUTRAL;
        })
        .attr('stroke-opacity', (l) => {
            if (!f) return RIBBON_OPACITY;
            return hot(l) ? RIBBON_OPACITY_HOT : RIBBON_OPACITY_DIM;
        });

    put(sel.bars).attr('fill', (d) => (isLit(d, f) || !f ? colourOf(d.cat) : NODE_DIM));

    // Labels are deliberately NOT dimmed with the focus. Thinning them to grey
    // made the chart harder to read at exactly the moment the reader is trying
    // to compare the focused bar against its neighbours.

    // A ring on the focused bars, so focus is not carried by hue alone — the
    // same ink ring idiom Lab 8 uses. A side focus rings one bar, which is what
    // distinguishes it from the chip's two.
    sel.ringsG.selectAll('rect')
        .data(graph.nodes.filter((d) => isLit(d, f)), (d) => d.id)
        .join('rect')
        .attr('x', (d) => d.x0 - RING_PAD)
        .attr('y', (d) => d.y0 - RING_PAD)
        .attr('width', (d) => d.x1 - d.x0 + 2 * RING_PAD)
        .attr('height', (d) => d.y1 - d.y0 + 2 * RING_PAD)
        .attr('rx', 3)
        .attr('fill', 'none')
        .attr('stroke', RING_COLOR)
        .attr('stroke-width', RING_W);
}

function setFocus(f) {
    if (sameFocus(state.hover, f)) return;
    state.hover = f;
    updateFocus();
    updateLegend();
}

function togglePin(f) {
    state.pinned = sameFocus(state.pinned, f) ? null : f;
    state.hover = null;
    updateFocus();
    updateLegend();
    renderDetail();
}

// There is deliberately no tooltip. Every number a ribbon or bar could show is
// already in the table below, with its denominator spelled out — and the table
// does not cover the chart, disappear on the way to the thing you wanted to
// compare against, or need repeating for each of the 49 ribbons.

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------

function renderChart() {
    graph = layout(GRIDS[state.mode]);
    const host = d3.select('#critique-chart');
    host.selectAll('svg').remove();

    const svg = host.append('svg')
        .attr('viewBox', `0 0 ${W} ${H}`)
        .attr('width', W)
        .attr('height', H)
        // The chart is a redundant view: every number in it is in the table
        // below. That is what makes the accessibility claim honest rather than
        // aspirational, and it saves making 49 SVG paths focusable.
        .attr('aria-hidden', 'true')
        .attr('focusable', 'false');

    const ribbon = sankeyLinkHorizontal();

    // Layer order, bottom to top: ribbons, hit targets, bars, rings, labels.
    // The visual ribbon layer takes no pointer events so the hit layer below it
    // is the only thing that ever fires.
    sel.ribbons = svg.append('g').attr('class', 'ribbons').attr('fill', 'none')
        .attr('pointer-events', 'none')
        .selectAll('path')
        .data(graph.links, (l) => `${l.source.id}|${l.target.id}`)
        .join('path')
        .attr('class', 'ribbon')
        // sankeyLinkHorizontal() is a CENTRELINE, not a closed ribbon: it builds
        // a horizontal link through (source.x1, y0) and (target.x0, y1). It is
        // meant to be stroked with the link's width, so `fill` stays none and
        // the count rides on stroke-width. (It also has no .curvature() in
        // 0.12.3, whatever the older tutorials say.)
        .attr('d', ribbon)
        .attr('stroke-linecap', 'butt')
        .attr('stroke-width', (l) => Math.max(l.width, MIN_RIBBON_W));

    // Transparent targets, so a 0.02px flow is still hoverable. `transparent`
    // rather than `none` because `none` would leave no stroke region to hit.
    svg.append('g').attr('class', 'ribbon-hits').attr('fill', 'none')
        .selectAll('path')
        .data(graph.links, (l) => `${l.source.id}|${l.target.id}`)
        .join('path')
        .attr('class', 'hit')
        .attr('d', ribbon)
        .attr('stroke', 'transparent')
        .attr('stroke-width', (l) => Math.max(l.width, HIT_RIBBON_W))
        .attr('pointer-events', 'stroke')
        .on('click', (_event, l) => {
            // A ribbon belongs to a category, not to one end of itself, so this
            // focuses the category on both sides — same as a legend chip.
            togglePin({ cat: l.source.cat, side: null });
        });

    sel.bars = svg.append('g').attr('class', 'bars')
        .selectAll('rect')
        .data(graph.nodes, (d) => d.id)
        .join('rect')
        .attr('x', (d) => d.x0)
        .attr('y', (d) => d.y0)
        .attr('width', (d) => d.x1 - d.x0)
        .attr('height', (d) => d.y1 - d.y0)
        .attr('rx', 2)
        .style('cursor', 'pointer')
        // A bar is one end of a flow, so both hover and click carry its side:
        // the from bar lights only what leaves it, the to bar only what reaches
        // it. Hover previews exactly what the click will pin.
        .on('mouseenter', (_event, d) => setFocus({ cat: d.cat, side: d.side }))
        // Clearing the hover matters as much as setting it: without this the
        // focus ring stays on the bars after the pointer leaves. setFocus(null)
        // falls back to whatever is pinned, so a pinned focus keeps its ring.
        .on('mouseleave', () => setFocus(null))
        .on('click', (_event, d) => togglePin({ cat: d.cat, side: d.side }));

    // Hold the GROUP, not a pre-join empty selection. An empty selection cannot
    // see the elements a later join appends, so re-joining it would append two
    // more rings on every hover and never exit the old ones.
    sel.ringsG = svg.append('g').attr('class', 'rings').attr('pointer-events', 'none');

    sel.labels = svg.append('g').attr('class', 'labels').attr('pointer-events', 'none');
    drawLabels();

    updateFocus(false);
}

// ---------------------------------------------------------------------------
// Legend, controls, detail panel
// ---------------------------------------------------------------------------

// The chips are built once — the seven categories never change — and the
// pressed state is a separate, cheap update. Rebuilding the innerHTML on every
// hover would rewrite seven buttons each time the pointer crossed a bar.
function buildLegend() {
    d3.select('#critique-legend')
        .selectAll('button')
        .data(CATS)
        .join('button')
        .attr('type', 'button')
        .attr('class', 'chip')
        .attr('aria-controls', 'critique-details')
        .html((c) => `<span class="chip-i" style="background:${colourOf(c)}"></span>`
            + `<span class="chip-n">${CATS.indexOf(c) + 1}</span>`
            + `<span class="chip-t">${esc(LABEL[c])}</span>`)
        // A chip names a simulator, not a bar, so it focuses both sides —
        // `side: null`. That is what keeps it distinct from clicking a bar.
        .on('click', (_event, c) => togglePin({ cat: c, side: null }))
        .on('mouseenter', (_event, c) => setFocus({ cat: c, side: null }))
        .on('mouseleave', () => setFocus(null))
        // Keyboard parity: tabbing to a chip previews it, leaving clears it,
        // which is what hovering does with a pointer.
        .on('focus', (_event, c) => setFocus({ cat: c, side: null }))
        .on('blur', () => setFocus(null));

    updateLegend();
}

function updateLegend() {
    const f = focus();
    d3.select('#critique-legend').selectAll('button.chip')
        .attr('aria-pressed', (c) => String(!!f && f.cat === c))
        // Which end is in focus, for anyone who arrives at the chip rather than
        // at the bar. The chip stays pressed either way; the bar is the thing
        // that shows the side.
        .attr('data-side', (c) => (f && f.cat === c ? (f.side ?? 'both') : null));
}

function renderControls() {
    const all = MARG.all.total;
    const sw = MARG.sw.total;
    const host = d3.select('#critique-controls');

    host.selectAll('button.mode')
        .data([{ m: 'all', t: `All respondents (${n0(all)})` },
            { m: 'sw', t: `Switchers only (${n0(sw)})` }])
        .join('button')
        .attr('type', 'button')
        .attr('class', 'mode')
        .attr('aria-pressed', (d) => String(state.mode === d.m))
        .text((d) => d.t)
        .on('click', (_event, d) => setMode(d.m));

    d3.select('#critique-base').text(
        state.mode === 'all' ? BASE_NOTE.all(all) : BASE_NOTE.sw(sw, all),
    );
}

// The resting table is the whole dataset as text — the chart above it is a
// redundant view of the same numbers, never the only carrier of them.
function renderDetail() {
    const { prev: pTot, curr: cTot, total } = MARG[state.mode];
    const host = d3.select('#critique-details');
    const f = state.pinned;

    if (!f) {
        const rows = CATS.map((c, i) => {
            const p = pTot.get(c);
            const q = cTot.get(c);
            const keep = GRIDS[state.mode].get(key(c, c));
            return `<tr>
                <td class="idx">${i + 1}</td>
                <th scope="row"><span class="swatch" style="background:${colourOf(c)}"></span>
                    ${esc(LABEL[c])}</th>
                <td class="num">${n0(p)}</td><td class="num">${pct(p, total)}</td>
                <td class="num">${n0(q)}</td><td class="num">${pct(q, total)}</td>
                <td class="num ${q >= p ? 'up' : 'down'}">${signedPct(q - p, total)}</td>
                <td class="num">${state.mode === 'all' ? pct(keep, p) : '—'}</td>
            </tr>`;
        }).join('');

        host.html(`
            <table id="data-table">
                <caption>Listed in the same order as the chart above.</caption>
                <thead><tr>
                    <th class="idx">#</th><th scope="col">Simulator</th>
                    <th scope="col" class="num">Prev</th><th scope="col" class="num">Prev %</th>
                    <th scope="col" class="num">Now</th><th scope="col" class="num">Now %</th>
                    <th scope="col" class="num">Change</th>
                    <th scope="col" class="num">Retained</th>
                </tr></thead>
                <tbody>${rows}</tbody>
                <tfoot><tr>
                    <td></td><th scope="row">All</th>
                    <td class="num">${n0(total)}</td><td class="num">100%</td>
                    <td class="num">${n0(total)}</td><td class="num">100%</td>
                    <td class="num">${signedPct(0, total)}</td>
                    <td class="num">${state.mode === 'all'
        ? pct(CATS.reduce((a, c) => a + GRIDS.all.get(key(c, c)), 0), total) : '—'}</td>
                </tr></tfoot>
            </table>
        `);
        return;
    }

    const cat = f.cat;
    const p = pTot.get(cat);
    const q = cTot.get(cat);
    const keep = GRIDS[state.mode].get(key(cat, cat));

    // A bar focus asks one directional question, so only that half of the table
    // is rendered. A chip focus asks about the simulator, so both halves are.
    const showOut = f.side === null || f.side === 'prev';
    const showIn = f.side === null || f.side === 'curr';

    // Only what the guide does not already cover: a denominator caution, and a
    // reason for a column that is missing rather than zero. The chip-vs-bar
    // instruction that used to live here is gone — the guide states it, and the
    // heading's side tag already says which bar this is.
    const hint = [
        showOut && showIn
            ? 'Shares are of the base named in each block, so the two blocks do not share a denominator.'
            : '',
        state.mode === 'sw'
            ? 'Retention is not shown: this view is defined by removing the diagonal.'
            : '',
    ].filter(Boolean).join(' ');

    // One block of the flows table. Every share is taken against the base named
    // in the block header, never against the page total — the two blocks have
    // different denominators and conflating them is the commonest way a chart
    // like this misleads.
    const flows = ({ title, selfVerb, arrow, get, base }) => {
        const items = CATS
            .filter((c) => c !== cat)
            .map((c) => ({ c, v: get(c) }))
            .filter((d) => d.v > 0)
            .sort((a, b) => b.v - a.v);
        const top = items.slice(0, 3);
        const tail = items.slice(3);
        const rest = tail.reduce((a, d) => a + d.v, 0);

        const row = (label, v) => `<tr><th scope="row">${label}</th>
                <td class="num">${n0(v)}</td><td class="num">${pct(v, base)}</td></tr>`;

        // The self row is only meaningful when the diagonal is non-zero. In
        // switchers mode that is true for exactly one category — "Others",
        // whose 79 is people moving between two simulators that bin groups,
        // not people who stayed.
        const self = keep > 0 ? row(`${selfVerb} ${esc(LABEL[cat])}`, keep) : '';
        const rows = top.map((d) => row(`${arrow} ${esc(LABEL[d.c])}`, d.v)).join('');

        // Say the count and say these are not itemised, and never say "other".
        // "Others" is a category — nine simulators binned together — while this
        // row is the tail of the top-3 cut. The old "all other simulators" put
        // two different meanings of "other" in one column; worse, "all" made it
        // read as a subtotal of everything except the focused simulator, which
        // would double-count the named rows directly above it.
        const n = tail.length;
        const restRow = rest > 0
            ? row(`${arrow} ${n} simulator${n === 1 ? '' : 's'} not listed above`, rest)
            : '';

        return `<tr class="group"><th colspan="3">${title}
            <span class="base">base ${n0(base)}</span></th></tr>${self}${rows}${restRow}`;
    };

    const stayed = state.mode === 'all' ? 'Stayed on' : 'Moved within';
    const already = state.mode === 'all' ? 'Already on' : 'Moved within';
    const grid = GRIDS[state.mode];

    host.html(`
        <h3><span class="swatch" style="background:${colourOf(cat)}"></span>${esc(LABEL[cat])}${
        f.side === null ? ''
            : ` <span class="side-tag">${f.side === 'prev' ? 'from bar' : 'to bar'}</span>`}</h3>
        <p class="detail-meta">
            Previous users <strong>${n0(p)}</strong> (${pct(p, total)} of ${n0(total)})
            · now <strong>${n0(q)}</strong> (${pct(q, total)})
            · net <strong class="${q >= p ? 'up' : 'down'}">${signedPct(q - p, total)}</strong>
            ${state.mode === 'all' ? `· retained <strong>${pct(keep, p)}</strong>` : ''}
        </p>
        <table id="data-table">
            <thead><tr><th scope="col">Flow</th>
                <th scope="col" class="num">People</th>
                <th scope="col" class="num">Share</th></tr></thead>
            <tbody>
                ${showOut ? flows({
        title: 'Where its previous users went',
        selfVerb: stayed,
        arrow: '→',
        get: (c) => grid.get(key(cat, c)),
        base: p,
    }) : ''}
                ${showIn ? flows({
        title: 'Where its current users came from',
        selfVerb: already,
        arrow: '←',
        get: (c) => grid.get(key(c, cat)),
        base: q,
    }) : ''}
            </tbody>
        </table>
        ${hint ? `<p class="detail-hint">${hint}</p>` : ''}
    `);
}

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

function setMode(mode) {
    if (state.mode === mode) return;
    state.mode = mode;
    // Every number the focused simulator shows changes with the base, so the
    // focus is dropped rather than silently reinterpreted.
    state.pinned = null;
    state.hover = null;
    renderControls();
    renderChart();
    updateLegend();
    renderDetail();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function draw() {
    const base = import.meta.env.BASE_URL;
    const [allRows, swRows] = await Promise.all([
        d3.csv(`${base}data/survey_flow_matrix.csv`),
        d3.csv(`${base}data/survey_flow_matrix_switchers.csv`),
    ]);

    // Both files go through the same collapse, so the two modes cannot drift.
    // Note the grouped switchers base is 9,819, not the 11,795 who reported a
    // switch: the switchers matrix is defined by zeroing the diagonal, which is
    // exactly where the 1,976 people who left a simulator and came back sit.
    GRIDS.all = collapse(allRows);
    GRIDS.sw = collapse(swRows);
    MARG.all = margins(GRIDS.all);
    MARG.sw = margins(GRIDS.sw);

    renderControls();
    renderChart();
    buildLegend();
    renderDetail();

    d3.select(window).on('keydown.critique', (event) => {
        if (event.key !== 'Escape') return;
        if (!state.pinned) return;
        state.pinned = null;
        updateFocus();
        updateLegend();
        renderDetail();
    });
}

draw();
