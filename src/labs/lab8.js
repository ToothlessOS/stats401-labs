// Lab 8 - an interactive reading of the DKU Undergraduate Bulletin.
//
// Two views over one corpus: a semantic map where each point is one passage,
// and a Topic x Bulletin Section matrix over the document's own hierarchy.
// They share a single highlight state, so pointing at something in either view
// is visible in both.
//
// The design decision that shapes this file is that dimming answers two
// different questions and therefore gets two strengths, and that pointing is
// shown with rings rather than opacity at all.  See updateStyles().

import * as d3 from 'd3';
import { mountNav } from './nav.js';
import '../styles/main.css';

mountNav('#nav');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAP_W = 920;
const MAP_H = 620;
const MAP_M = { top: 24, right: 22, bottom: 24, left: 22 };

const BAR_W = 920;
const BAR_ROW = 23;
const BAR_PAD = { top: 30, right: 92, bottom: 34, left: 300 };

const MAT_W = 920;
const MAT_LABEL_W = 286;   // row gutter: section name + its n=
const MAT_N_W = 46;
const MAT_HEAD_H = 66;
const MAT_ROW_H = 13;
const MAT_BOTTOM = 54;
const MAT_COMPACT_N = 20;
// A gutter of its own on the right for the colour bar.  The grid used to run
// underneath the bar, and the cells showing through the ramp made the scale
// read as broken - worst in compact view, where the surviving top rows keep the
// last column full.
const MAT_RIGHT_W = 54;
const MAT_BAR_GAP = 10;
const MAT_GRID_W = MAT_W - MAT_LABEL_W - MAT_RIGHT_W;
const MAT_BAR_X = MAT_LABEL_W + MAT_GRID_W + MAT_BAR_GAP;

const R_MIN = 3;
const R_MAX = 9;

// Opacity.  Filters are a scope declaration, so they dim hardest; search and
// the chapter highlight are emphasis within that scope, so they dim less.  Two
// strengths rather than one is what keeps "inside the highlighted chapter" and
// "one of the selected passage's neighbours" from being the same statement.
const DIM_FILTER = 0.05;
const DIM_FOCUS = 0.15;

// The neighbour glow.  A blurred stroke reads as a glow rather than as a second
// outline; the filter region is widened where it is declared, because the
// default (-10% to 120% of the box) would clip it.
const GLOW_COLOR = '#ffd60a';
const GLOW_W = 5;
const GLOW_PAD = 3;
const GLOW_BLUR = 3;
const RING_COLOR = '#0b0b0b';
const RING_W = 2;
const RING_PAD = 4;

const INK = '#0b0b0b';
const INK_2 = '#52514e';
const MUTED = '#898781';
const GRID = '#e1e0d9';
const SURFACE = '#fcfcfb';
const ZERO_CELL = '#f4f4f2';
const OTHER_COLOR = '#c3c2b7';
const BAR_COLOR = '#2a78d6';

const NO_SECTION = '(no section)';
const N_NEIGHBOURS_SHOWN = 5;
const SNIPPET_CHARS = 150;

// The eleven topic colours, assigned to cluster 0-10 in fixed order and never
// cycled.  Validated as an all-pairs categorical set (a scatter lets any two
// topics land side by side, so the all-pairs test is the right one) against the
// light surface: worst pair 15.6 delta-E under normal vision and 8.3 under
// deuteranopia, with lightness inside the band and chroma above the floor.
//
// Two of the eleven sit below 3:1 contrast on the surface, which obliges relief
// rather than being ignorable: every one of them is named in the numbered
// legend, listed in the topic table, and numbered again in the matrix columns,
// so topic identity is never carried by hue alone.
const TOPIC_COLORS = [
    '#884117', // 0  brown      Biology, Chemistry & Environmental Science
    '#c56b23', // 1  orange     Advanced Placement, Credit & Electives
    '#70c170', // 2  green      China & Asia
    '#1c8f6e', // 3  teal       Course Prerequisites
    '#5cb6e6', // 4  light blue Media, Film & Visual Arts
    '#2e5794', // 5  navy       Interdisciplinary Seminars & Learning Goals
    '#336cfa', // 6  blue       History, Religion & Society
    '#7a31ca', // 7  violet     Institutional & Transfer Credit
    '#a07cdb', // 8  lilac      Public Policy & Economics
    '#eb47a9', // 9  pink       Academic Standing, Leave & Withdrawal
    '#991469', // 10 magenta    Computer Science, Math & Data Science
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape for interpolation into .html().  Six of the eleven topic labels
 *  contain "&" and 31 passages do, so this is load-bearing, not decoration. */
function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

function blankLabel(value, fallback) {
    const text = String(value ?? '').trim();
    return text === '' ? fallback : text;
}

/** Shannon entropy of a share vector - how mixed a section's topics are. */
function entropy(counts) {
    const total = d3.sum(counts);
    if (!total) return 0;
    return -d3.sum(counts.filter(c => c > 0).map(c => (c / total) * Math.log(c / total)));
}

// ---------------------------------------------------------------------------
// Draw
// ---------------------------------------------------------------------------

async function draw() {
    const base = import.meta.env.BASE_URL;

    const [rows, matrixRows, topicTerms, kRows] = await Promise.all([
        d3.csv(`${base}data/lab8_embedding_map.csv`, d => ({
            ...d,
            page: +d.page,
            cluster: +d.cluster,
            x: +d.x,
            y: +d.y,
            word_count: +d.word_count,
            chapter: blankLabel(d.chapter, '(no chapter)'),
            section: blankLabel(d.section, NO_SECTION),
            subsection: blankLabel(d.subsection, '(no subsection)'),
            nn: d.nn ? d.nn.split(' ').filter(Boolean) : [],
            nn_sim: d.nn_sim ? d.nn_sim.split(' ').map(Number) : [],
        })),
        d3.csv(`${base}data/lab8_topic_section_matrix.csv`, d => ({
            ...d,
            cluster: +d.cluster,
            count: +d.count,
            n_section: +d.n_section,
            prop_of_section: +d.prop_of_section,
            prop_of_topic: +d.prop_of_topic,
        })),
        d3.csv(`${base}data/lab8_cluster_terms.csv`, d => ({
            ...d,
            cluster: +d.cluster,
            n_passages: +d.n_passages,
        })),
        d3.csv(`${base}data/lab8_kmeans_k.csv`, d => ({
            k: +d.k,
            inertia: +d.inertia,
            drop_pct: +d.drop_pct,
            explained_pct: +d.explained_pct,
            silhouette: +d.silhouette,
        })),
    ]);

    rows.sort((a, b) => d3.ascending(a.passage_id, b.passage_id));

    // -----------------------------------------------------------------------
    // Indices
    // -----------------------------------------------------------------------

    const byId = new Map(rows.map(d => [d.passage_id, d]));
    const TOPICS = [...topicTerms].sort((a, b) => d3.ascending(a.cluster, b.cluster));
    const CHAPTERS = [...new Set(rows.map(d => d.chapter))].sort(d3.ascending);

    // Sections in descending size.  "(no section)" is kept: it is the only home
    // for the eleven passages filed under no heading, and dropping it would
    // make the matrix totals silently disagree with the topic table.
    const nBySection = d3.rollup(rows, v => v.length, d => d.section);
    const SECTIONS = [...nBySection.entries()]
        .sort((a, b) => d3.descending(a[1], b[1]) || d3.ascending(a[0], b[0]))
        .map(([section]) => section);
    const NAMED_SECTIONS = SECTIONS.filter(s => s !== NO_SECTION);

    const TOP_SECTIONS = SECTIONS.slice(0, 12);
    const BAR_ROWS = [...TOP_SECTIONS, 'Other'];

    // Formal sections only, for the chapter column of the filter.  "(no section)"
    // is offered separately so it never reads as a section name.
    const byTopic = new Map(TOPICS.map(t => [t.cluster, t]));
    const colorScale = d3.scaleOrdinal()
        .domain(TOPICS.map(t => t.cluster))
        .range(TOPIC_COLORS)
        .unknown('#999999');

    const rScale = d3.scaleSqrt()
        .domain(d3.extent(rows, d => d.word_count))
        .range([R_MIN, R_MAX]);

    const cellByKey = new Map(matrixRows.map(r => [`${r.section}\u0000${r.cluster}`, r]));

    const tooltip = d3.select('#tooltip');

    function showTip(event, html) {
        tooltip.html(html)
            .style('left', `${event.pageX + 14}px`)
            .style('top', `${event.pageY - 30}px`)
            .style('opacity', 1);
    }

    function hideTip() {
        tooltip.style('opacity', 0);
    }

    // -----------------------------------------------------------------------
    // Part B - corpus overview
    // -----------------------------------------------------------------------

    const stats = [
        ['passages', d3.format(',')(rows.length)],
        ['chapters', CHAPTERS.length],
        ['named sections', NAMED_SECTIONS.length],
        ['subsections', new Set(rows.map(d => d.subsection)).size],
        ['semantic topics', TOPICS.length],
        ['mean length', `${d3.mean(rows, d => d.word_count).toFixed(1)} words`],
    ];

    d3.select('#corpus-stats').selectAll('span')
        .data(stats)
        .join('span')
        .html(d => `<strong>${esc(d[1])}</strong> ${esc(d[0])}`);

    // Both bar panels use the same categories in the same order, so a section's
    // count and its mean length can be read straight across.
    function sectionValue(section, field) {
        const subset = section === 'Other'
            ? rows.filter(d => !TOP_SECTIONS.includes(d.section))
            : rows.filter(d => d.section === section);
        return field === 'count'
            ? subset.length
            : d3.mean(subset, d => d.word_count);
    }

    function drawSectionBars(field, title, valueFormat) {
        const height = BAR_PAD.top + BAR_ROWS.length * BAR_ROW + BAR_PAD.bottom;
        const svg = d3.select('#overview')
            .append('svg')
            .attr('width', BAR_W)
            .attr('height', height);

        const y = d3.scaleBand()
            .domain(BAR_ROWS)
            .range([BAR_PAD.top, height - BAR_PAD.bottom])
            .paddingInner(0.25);

        const values = BAR_ROWS.map(s => sectionValue(s, field));
        const x = d3.scaleLinear()
            .domain([0, d3.max(values)])
            .nice()
            .range([BAR_PAD.left, BAR_W - BAR_PAD.right]);

        svg.append('text')
            .attr('x', BAR_PAD.left - 12)
            .attr('y', 18)
            .attr('text-anchor', 'start')
            .attr('fill', INK)
            .attr('font-size', 13)
            .attr('font-weight', 'bold')
            .text(title);

        // Recessive vertical gridlines, behind the bars.
        svg.append('g')
            .attr('transform', `translate(0,${height - BAR_PAD.bottom})`)
            .call(d3.axisBottom(x).ticks(5).tickSize(-(height - BAR_PAD.top - BAR_PAD.bottom)).tickFormat(''))
            .call(g => g.select('.domain').remove())
            .call(g => g.selectAll('.tick line').attr('stroke', GRID))
            .call(g => g.selectAll('.tick text').attr('fill', MUTED).attr('font-size', 10));

        svg.append('g')
            .attr('transform', `translate(0,${height - BAR_PAD.bottom})`)
            .call(d3.axisBottom(x).ticks(5))
            .call(g => g.select('.domain').attr('stroke', GRID))
            .call(g => g.selectAll('.tick text').attr('fill', MUTED).attr('font-size', 10).attr('dy', '0.8em'));

        const bar = svg.append('g')
            .selectAll('g')
            .data(BAR_ROWS)
            .join('g')
            .attr('transform', d => `translate(0,${y(d)})`)
            .attr('cursor', 'pointer')
            .on('click', (event, d) => {
                if (d === 'Other') return;
                d3.select('#section-filter').property('value', d);
                state.section = d;
                updateStyles();
            })
            .on('mousemove', (event, d) => {
                const subset = d === 'Other'
                    ? rows.filter(r => !TOP_SECTIONS.includes(r.section))
                    : rows.filter(r => r.section === d);
                const top = d3.rollup(subset, v => v.length, r => r.cluster_short);
                const topList = [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
                    .map(([k, v]) => `${esc(k)} ${v}`).join(' · ');
                showTip(event,
                    `<strong>${esc(d)}</strong><br>${subset.length} passages` +
                    `${d === 'Other' ? ` across ${new Set(subset.map(r => r.section)).size} sections` : ''}` +
                    (field === 'mean' ? `<br>mean ${d3.mean(subset, r => r.word_count).toFixed(1)} words` : '') +
                    `<br>${topList}`);
            })
            .on('mouseleave', hideTip);

        bar.append('rect')
            .attr('x', BAR_PAD.left)
            .attr('y', 0)
            .attr('height', y.bandwidth())
            .attr('width', d => Math.max(0, x(sectionValue(d, field)) - BAR_PAD.left))
            .attr('rx', 3)
            // One series, one hue.  Colouring these bars by the section's
            // dominant topic would put the topic palette on a chart about
            // section size and imply an encoding that is not what is plotted.
            .attr('fill', d => (d === NO_SECTION || d === 'Other') ? OTHER_COLOR : BAR_COLOR);

        bar.append('text')
            .attr('x', BAR_PAD.left - 10)
            .attr('y', y.bandwidth() / 2)
            .attr('dy', '0.35em')
            .attr('text-anchor', 'end')
            .attr('fill', INK_2)
            .attr('font-size', 11)
            .text(d => truncate(d === 'Other' ? `Other (${SECTIONS.length - TOP_SECTIONS.length} sections)` : d, 48));

        bar.append('text')
            .attr('x', d => x(sectionValue(d, field)) + 7)
            .attr('y', y.bandwidth() / 2)
            .attr('dy', '0.35em')
            .attr('fill', MUTED)
            .attr('font-size', 11)
            .text(d => valueFormat(sectionValue(d, field)));
    }

    drawSectionBars('count', 'Passages per section', d => d3.format(',')(d));
    drawSectionBars('mean', 'Mean passage length by section (words)', d => d.toFixed(0));

    // Computed, not written out: these numbers move if the corpus or the top-12
    // cut ever changes, and a stale caption is worse than no caption.
    const otherSections = SECTIONS.length - TOP_SECTIONS.length;
    const otherPassages = rows.filter(d => !TOP_SECTIONS.includes(d.section)).length;
    const biggest = d3.max(rows, d => nBySection.get(d.section));

    d3.select('#overview').append('p')
        .attr('class', 'caption')
        .text(`The largest section alone holds ${((biggest / rows.length) * 100).toFixed(0)}% of the `
            + `corpus, and the ${otherSections} sections behind "Other" share the remaining `
            + `${otherPassages} passages. Clicking a bar filters the map below.`);

    // Topic table: the eleven labels and the TF-IDF terms they were read off.
    const topicTable = d3.select('#data-table');
    topicTable.select('thead').append('tr')
        .selectAll('th')
        .data(['#', 'Semantic topic', 'Passages', 'Share', 'Passage length (mean)', 'Characteristic terms'])
        .join('th')
        .text(d => d);

    topicTable.select('tbody')
        .selectAll('tr')
        .data(TOPICS)
        .join('tr')
        .html(d => {
            const subset = rows.filter(r => r.cluster === d.cluster);
            return `<td><span class="swatch" style="background:${colorScale(d.cluster)}"></span>${d.cluster}</td>`
                + `<td>${esc(d.label)}</td>`
                + `<td>${d.n_passages}</td>`
                + `<td>${((d.n_passages / rows.length) * 100).toFixed(1)}%</td>`
                + `<td>${d3.mean(subset, r => r.word_count).toFixed(1)}</td>`
                + `<td class="terms">${esc(d.top_words)}</td>`;
        });

    // Semantic diversity by section.  This is what the "which sections are most
    // mixed?" finding reads, so it is computed here rather than asserted, and
    // the ten-passage cut is stated in the table itself.
    const MIN_FOR_ENTROPY = 10;
    const diversity = SECTIONS
        .filter(section => nBySection.get(section) >= MIN_FOR_ENTROPY)
        .map(section => {
            const counts = d3.rollup(
                rows.filter(d => d.section === section),
                v => v.length,
                d => d.cluster);
            return { section, n: nBySection.get(section), h: entropy([...counts.values()]) };
        })
        .sort((a, b) => d3.descending(a.h, b.h));

    const divTable = d3.select('#diversity-table');
    divTable.append('caption')
        .text(`Semantic diversity by section (sections with at least ${MIN_FOR_ENTROPY} passages)`);
    divTable.append('thead').append('tr')
        .selectAll('th')
        .data(['Section', 'Passages', 'Topic entropy', 'Topics present'])
        .join('th')
        .text(d => d);
    divTable.append('tbody')
        .selectAll('tr')
        .data(diversity)
        .join('tr')
        .html(d => `<td>${esc(d.section)}</td>`
            + `<td>${d.n}</td>`
            + `<td>${d.h.toFixed(2)}</td>`
            + `<td>${new Set(rows.filter(r => r.section === d.section).map(r => r.cluster)).size}</td>`);

    // k table, with the chosen k and both diagnostics marked.
    const chosenK = 11;
    const elbowK = 6;
    const kTable = d3.select('#k-table');
    kTable.append('caption')
        .text('Inertia and cosine silhouette against k. The chosen k is marked; '
            + 'the inertia chord rule and the silhouette peak disagree.');
    kTable.append('thead').append('tr')
        .selectAll('th')
        .data(['k', 'Inertia', 'Drop', 'Explained', 'Silhouette (cosine)', ''])
        .join('th')
        .text(d => d);
    kTable.append('tbody')
        .selectAll('tr')
        .data(kRows)
        .join('tr')
        .attr('class', d => (d.k === chosenK ? 'k-chosen' : null))
        .html(d => `<td>${d.k}</td>`
            + `<td>${d3.format(',.1f')(d.inertia)}</td>`
            + `<td>${Number.isNaN(d.drop_pct) ? '—' : `${d.drop_pct.toFixed(1)}%`}</td>`
            + `<td>${d.explained_pct.toFixed(1)}%</td>`
            + `<td>${d.silhouette.toFixed(4)}</td>`
            + `<td>${d.k === chosenK ? 'chosen' : d.k === elbowK ? 'inertia elbow' : ''}</td>`);

    // -----------------------------------------------------------------------
    // Part D - the semantic map
    // -----------------------------------------------------------------------

    const xScale = d3.scaleLinear()
        .domain(d3.extent(rows, d => d.x))
        .range([MAP_M.left, MAP_W - MAP_M.right]);
    const yScale = d3.scaleLinear()
        .domain(d3.extent(rows, d => d.y))
        .range([MAP_H - MAP_M.bottom, MAP_M.top]);

    const svg = d3.select('#chart')
        .append('svg')
        .attr('width', MAP_W)
        .attr('height', MAP_H)
        .attr('cursor', 'grab');

    svg.append('defs')
        .append('filter')
        .attr('id', 'hl-glow')
        .attr('x', '-80%')
        .attr('y', '-80%')
        .attr('width', '260%')
        .attr('height', '260%')
        .append('feGaussianBlur')
        .attr('stdDeviation', GLOW_BLUR);

    // One transformed group holds everything positional, so zoom moves the
    // points and their highlight rings together without any per-mark maths.
    const zoomLayer = svg.append('g');

    zoomLayer.append('rect')
        .attr('x', 0).attr('y', 0)
        .attr('width', MAP_W).attr('height', MAP_H)
        .attr('fill', SURFACE);

    const pointLayer = zoomLayer.append('g');
    // The glow sits above the points and the ink ring above the glow, so the
    // ring is never washed out by a neighbouring halo.
    const glowLayer = zoomLayer.append('g').attr('pointer-events', 'none');
    const ringLayer = zoomLayer.append('g').attr('pointer-events', 'none');

    const pointSel = pointLayer
        .selectAll('circle.pt')
        .data(rows, d => d.passage_id)
        .join('circle')
        .attr('class', 'pt')
        .attr('cx', d => xScale(d.x))
        .attr('cy', d => yScale(d.y))
        .attr('r', d => rScale(d.word_count))
        .attr('fill', d => colorScale(d.cluster))
        .attr('stroke', '#ffffff')
        .attr('stroke-width', 0.6)   // separates points that overlap heavily
        .on('click', (event, d) => {
            event.stopPropagation();   // the background handler clears selection
            selectPassage(d.passage_id);
        })
        .on('mousemove', (event, d) => {
            showTip(event, `<strong>${esc(d.passage_id)}</strong> · page ${d.page}<br>`
                + `${esc(d.cluster_name)}<br>`
                + `<span style="color:${MUTED}">${esc(truncate(d.section, 60))}</span><br>`
                + `${d.word_count} words`);
        })
        .on('mouseleave', hideTip);

    // -----------------------------------------------------------------------
    // Highlight state
    // -----------------------------------------------------------------------

    const state = {
        search: '',
        chapter: 'all',
        section: 'all',
        topic: 'all',
        selected: null,          // passage_id, or null
        neighbors: new Set(),    // only ever non-empty while `selected` is set
        cell: null,              // {section, cluster} from a matrix click
    };

    // Scope: the filters.  Two restrictions on the same question, so they AND.
    const inScope = d =>
        (state.topic === 'all' || d.cluster_name === state.topic)
        && (state.section === 'all' || d.section === state.section);

    // Emphasis: search and the chapter highlight.  ANDed with each other so
    // "search inside this chapter" works instead of one clobbering the other.
    const isFocused = d => {
        const query = state.search.trim().toLowerCase();
        if (query && !d.text.toLowerCase().includes(query)) return false;
        if (state.chapter !== 'all' && d.chapter !== state.chapter) return false;
        return true;
    };

    // Spotlight: what the last click was pointing at.  Selected and cell are
    // mutually exclusive by construction, so this never has to intersect a
    // five-point neighbour set with a whole matrix cell.
    const isLit = d =>
        (state.selected !== null
            && (d.passage_id === state.selected || state.neighbors.has(d.passage_id)))
        || (state.cell !== null
            && d.section === state.cell.section && d.cluster === state.cell.cluster);

    // Whether anything is asking to be pointed at.  These have to be tracked
    // separately from the predicates below: isFocused() is trivially true for
    // every point when no search or chapter is set, so using it alone would let
    // a spotlight dim nothing.
    const hasSpotlight = () => state.selected !== null || state.cell !== null;
    const hasEmphasis = () => state.search.trim() !== '' || state.chapter !== 'all';

    // A filter is a scope declaration, not a preference: nothing can resurrect
    // a passage the filters excluded, so scope is tested first and wins over
    // every highlight below it.
    //
    // Emphasis then sets the base level and the spotlight only ever *raises*
    // from it.  Giving the spotlight precedence instead would make the chapter
    // dropdown a no-op the moment a passage was selected - both would dim to
    // 0.15 - and the point of the two channels is that they hold at once: the
    // chapter stays legible, the selection glows, and a neighbour that sits
    // outside the chapter is a lit hole in the dimmed field.
    const opacityOf = d => {
        if (!inScope(d)) return DIM_FILTER;
        if (isLit(d)) return 1;
        if (hasEmphasis()) return isFocused(d) ? 1 : DIM_FOCUS;
        if (hasSpotlight()) return DIM_FOCUS;
        return 1;
    };

    const zoom = d3.zoom()
        .scaleExtent([1, 8])
        .on('zoom', event => zoomLayer.attr('transform', event.transform));

    svg.call(zoom).on('click', () => clearHighlights());

    /** The only place a visual property of a point is written. */
    function updateStyles() {
        pointSel
            .attr('opacity', opacityOf)
            // Filtered-out points must not answer the mouse, or the tooltip
            // would describe something the reader cannot see.
            .attr('pointer-events', d => (inScope(d) ? 'all' : 'none'));

        // The glow list is capped at the selection plus its five neighbours.
        // Handing this layer all matching points instead would run a blur
        // filter over a large part of the map on every matrix click.
        // The Set holds passage ids, so each one has to be resolved to its row
        // before it can be drawn - spreading the Set directly yields strings,
        // and rScale(undefined) silently yields a radius of NaN.
        const glow = state.selected === null
            ? []
            : [state.selected, ...state.neighbors]
                .map(id => byId.get(id))
                .filter(Boolean)
                .filter(inScope);

        glowLayer.selectAll('circle.glow')
            .data(glow, d => d.passage_id)
            .join('circle')
            .attr('class', 'glow')
            .attr('cx', d => xScale(d.x))
            .attr('cy', d => yScale(d.y))
            .attr('r', d => rScale(d.word_count) + GLOW_PAD)
            .attr('fill', 'none')
            .attr('stroke', GLOW_COLOR)
            .attr('stroke-width', GLOW_W)
            .attr('filter', 'url(#hl-glow)')
            .style('vector-effect', 'non-scaling-stroke');

        const ring = state.selected ? [byId.get(state.selected)] : [];
        ringLayer.selectAll('circle.sel-ring')
            .data(ring, d => d.passage_id)
            .join('circle')
            .attr('class', 'sel-ring')
            .attr('cx', d => xScale(d.x))
            .attr('cy', d => yScale(d.y))
            .attr('r', d => rScale(d.word_count) + RING_PAD)
            .attr('fill', 'none')
            .attr('stroke', RING_COLOR)
            .attr('stroke-width', RING_W)
            .style('vector-effect', 'non-scaling-stroke');

        const shown = rows.filter(inScope).length;
        d3.select('#show-count').text(
            shown === rows.length
                ? `Showing all ${rows.length} passages`
                : `Showing ${shown} of ${rows.length} passages`);

        highlightMatrixCell(
            state.cell
            ?? (state.selected
                ? { section: byId.get(state.selected).section, cluster: byId.get(state.selected).cluster }
                : null));
    }

    // -----------------------------------------------------------------------
    // Detail panel and neighbours
    // -----------------------------------------------------------------------

    const detailPanel = d3.select('#detail-panel');
    const neighborBox = d3.select('#neighbors');

    function clearDetail() {
        detailPanel.html('<p class="placeholder">Click a passage on the map, or a cell in the '
            + 'matrix, to see its details here.</p>');
        neighborBox.html('');
    }

    function renderDetail(d) {
        detailPanel.html(
            `<h3>${esc(d.passage_id)} — ${esc(d.cluster_name)}</h3>`
            + `<p class="detail-meta">`
            + `<strong>Chapter:</strong> ${esc(d.chapter)}<br>`
            + `<strong>Section:</strong> ${esc(d.section)}<br>`
            + `<strong>Subsection:</strong> ${esc(d.subsection)}<br>`
            + `<strong>Page:</strong> ${d.page} · <strong>Length:</strong> ${d.word_count} words`
            + `</p>`
            + `<p>${esc(d.text)}</p>`);
    }

    function renderNeighbors(d) {
        const items = d.nn.map((id, i) => ({ passage: byId.get(id), sim: d.nn_sim[i] }))
            .filter(item => item.passage);

        neighborBox.html(
            `<strong>${N_NEIGHBOURS_SHOWN} most semantically similar passages</strong>`
            + `<ol>${items.map(item => {
                const other = item.passage;
                const crosses = other.section !== d.section;
                return `<li data-id="${esc(other.passage_id)}">`
                    + `${esc(other.passage_id)} · <span class="nn-section">${esc(truncate(other.section, 46))}</span>`
                    + ` · <span class="nn-sim">${item.sim.toFixed(3)}</span>`
                    + `${crosses ? ' · <em>different section</em>' : ''}`
                    + `<div class="nn-text">${esc(truncate(other.text, SNIPPET_CHARS))}</div>`
                    + `</li>`;
            }).join('')}</ol>`
            + '<p class="caption">Similarity is cosine distance between the 384-dimensional '
            + 'embeddings. Neighbours marked <em>different section</em> are passages the '
            + "bulletin's own hierarchy places elsewhere.</p>");

        neighborBox.selectAll('li')
            .on('click', (event, i) => selectPassage(event.currentTarget.dataset.id))
            .on('mousemove', (event, i) => {
                const other = byId.get(event.currentTarget.dataset.id);
                showTip(event, `<strong>${esc(other.passage_id)}</strong><br>${esc(other.cluster_name)}<br>`
                    + `<span style="color:${MUTED}">${esc(truncate(other.section, 60))}</span>`);
            })
            .on('mouseleave', hideTip);
    }

    function renderCellSummary(section, cluster) {
        const cell = cellByKey.get(`${section}\u0000${cluster}`);
        const count = cell ? cell.count : 0;
        const nSection = cell ? cell.n_section : 0;
        detailPanel.html(
            `<h3>${esc(section)} × ${esc(byTopic.get(cluster)?.label ?? '')}</h3>`
            + `<p class="detail-meta">`
            + `<strong>${count}</strong> passage${count === 1 ? '' : 's'} at this intersection`
            + (cell ? ` · ${(cell.prop_of_section * 100).toFixed(1)}% of the section`
                + ` · ${(cell.prop_of_topic * 100).toFixed(1)}% of the topic` : '')
            + `<br>the section holds ${nSection} passages in total`
            + `</p>`
            + `<p class="placeholder">The matching passages are highlighted on the map above.</p>`);
    }

    function selectPassage(id) {
        const d = byId.get(id);
        if (!d) return;

        // The compact matrix can be hiding this passage's row, in which case
        // there would be no cell to outline.  Expand rather than silently
        // dropping the coordination.
        if (matrixState.rows === 'compact' && !activeSections().includes(d.section)) {
            setMatrixRows('all');
        }

        state.selected = id;
        state.neighbors = new Set(d.nn);
        state.cell = null;                  // one highlight at a time
        renderDetail(d);
        renderNeighbors(d);
        updateStyles();
    }

    function selectCell(section, cluster) {
        state.cell = { section, cluster };
        state.selected = null;
        state.neighbors = new Set();
        renderCellSummary(section, cluster);
        neighborBox.html('');
        updateStyles();
    }

    function clearHighlights() {
        state.selected = null;
        state.neighbors = new Set();
        state.cell = null;
        state.search = '';
        state.chapter = 'all';
        state.section = 'all';
        state.topic = 'all';
        d3.select('#search').property('value', '');
        d3.select('#chapter-filter').property('value', 'all');
        d3.select('#section-filter').property('value', 'all');
        d3.select('#topic-filter').property('value', 'all');
        d3.select('#search-summary').text('');
        clearDetail();
        updateStyles();
    }

    // -----------------------------------------------------------------------
    // Controls
    // -----------------------------------------------------------------------

    const controls = d3.select('#controls');

    const row1 = controls.append('div').attr('class', 'controls-row');
    row1.append('label').attr('for', 'search').text('Search passage text');
    row1.append('input')
        .attr('type', 'text')
        .attr('id', 'search')
        .attr('placeholder', 'credit, graduation, academic integrity…')
        .on('input', function () {
            state.search = this.value;
            const query = state.search.trim().toLowerCase();
            const matches = query ? rows.filter(d => d.text.toLowerCase().includes(query)) : [];
            const summary = d3.select('#search-summary');
            if (!query) {
                summary.text('');
            } else if (!matches.length) {
                summary.text('no matches');
            } else {
                const byTopicCount = [...d3.rollup(matches, v => v.length, d => d.cluster_name).entries()]
                    .sort((a, b) => b[1] - a[1]);
                summary.text(`${matches.length} match${matches.length === 1 ? '' : 'es'} across `
                    + `${byTopicCount.length} topic${byTopicCount.length === 1 ? '' : 's'} · mostly `
                    + byTopicCount.slice(0, 3).map(([k, v]) => `${k} (${v})`).join(', '));
            }
            updateStyles();
        });
    row1.append('span').attr('class', 'summary').attr('id', 'search-summary').text('');

    const row2 = controls.append('div').attr('class', 'controls-row');

    row2.append('label').attr('for', 'topic-filter').text('Topic');
    row2.append('select')
        .attr('id', 'topic-filter')
        .on('change', function () {
            state.topic = this.value;
            updateStyles();
        })
        .selectAll('option')
        .data([{ value: 'all', label: `All topics (${rows.length})` }].concat(
            TOPICS.map(t => ({ value: t.label, label: `${t.cluster} · ${t.label} (${t.n_passages})` }))))
        .join('option')
        .attr('value', d => d.value)
        .text(d => d.label);

    // 79 sections will not fit a flat dropdown, so the ten largest are lifted
    // out and "(no section)" is fenced off with a label saying what it is.
    row2.append('label').attr('for', 'section-filter').text('Section');
    const topTen = NAMED_SECTIONS.slice(0, 10);
    const sectionSelect = row2.append('select')
        .attr('id', 'section-filter')
        .on('change', function () {
            state.section = this.value;
            updateStyles();
        });

    sectionSelect.append('option').attr('value', 'all').text(`All sections (${rows.length})`);
    sectionSelect.append('optgroup').attr('label', 'Largest sections')
        .selectAll('option')
        .data(topTen)
        .join('option')
        .attr('value', d => d)
        .text(d => `${truncate(d, 52)} (${nBySection.get(d)})`);
    sectionSelect.append('optgroup').attr('label', 'All sections (A–Z)')
        .selectAll('option')
        .data(NAMED_SECTIONS.slice(10).sort(d3.ascending))
        .join('option')
        .attr('value', d => d)
        .text(d => `${truncate(d, 52)} (${nBySection.get(d)})`);
    sectionSelect.append('optgroup').attr('label', 'Unassigned (not a formal section)')
        .append('option')
        .attr('value', NO_SECTION)
        .text(`${NO_SECTION} (${nBySection.get(NO_SECTION)})`);

    row2.append('label').attr('for', 'chapter-filter').text('Chapter');
    row2.append('select')
        .attr('id', 'chapter-filter')
        .on('change', function () {
            state.chapter = this.value;
            updateStyles();
        })
        .selectAll('option')
        .data([{ value: 'all', label: `All chapters (${CHAPTERS.length})` }].concat(
            CHAPTERS.map(c => ({ value: c, label: `${c} (${rows.filter(d => d.chapter === c).length})` }))))
        .join('option')
        .attr('value', d => d.value)
        .text(d => d.label);

    const row3 = controls.append('div').attr('class', 'controls-row');
    row3.append('button')
        .text('Clear highlights')
        .on('click', clearHighlights);
    row3.append('button')
        .text('Reset zoom')
        .on('click', () => svg.transition().duration(300).call(zoom.transform, d3.zoomIdentity));
    row3.append('span').attr('class', 'summary').attr('id', 'show-count').text('');

    // Legend: topic identity is carried by number and name, not by hue alone -
    // which is also the relief the two low-contrast swatches require.
    const legend = d3.select('#legend');

    const topicLegend = legend.append('div').attr('class', 'legend-block');
    topicLegend.append('div').attr('class', 'legend-title').text('Semantic topic');
    topicLegend.append('ul').attr('class', 'legend-topics')
        .selectAll('li')
        .data(TOPICS)
        .join('li')
        .html(d => `<span class="swatch" style="background:${colorScale(d.cluster)}"></span>`
            + `<span class="legend-num">${d.cluster}</span> ${esc(d.label)}`
            + ` <span class="legend-n">(${d.n_passages})</span>`);

    const sizeLegend = legend.append('div').attr('class', 'legend-block');
    sizeLegend.append('div').attr('class', 'legend-title').text('Passage length');
    const sizeSvg = sizeLegend.append('svg')
        .attr('width', 232).attr('height', 48).attr('class', 'legend-svg');
    [30, 100, 300].forEach((words, i) => {
        const cx = 30 + i * 74;
        sizeSvg.append('circle')
            .attr('cx', cx).attr('cy', 22)
            .attr('r', rScale(words))
            .attr('fill', MUTED).attr('opacity', 0.5)
            .attr('stroke', INK_2).attr('stroke-width', 0.8);
        sizeSvg.append('text')
            .attr('x', cx).attr('y', 43)
            .attr('text-anchor', 'middle')
            .attr('fill', MUTED).attr('font-size', 10)
            .text(`${words} words`);
    });

    const marksLegend = legend.append('div').attr('class', 'legend-block');
    marksLegend.append('div').attr('class', 'legend-title').text('Highlighting');
    const marksSvg = marksLegend.append('svg')
        .attr('width', 300).attr('height', 72).attr('class', 'legend-svg');
    const marks = [
        ['glow', GLOW_COLOR, `${N_NEIGHBOURS_SHOWN} nearest neighbours of the selected passage`],
        ['ring', RING_COLOR, 'the selected passage'],
        ['dim', null, 'dimmed by a filter (5%) or by search / chapter (15%)'],
    ];
    marks.forEach(([kind, color, label], i) => {
        const cy = 12 + i * 22;
        marksSvg.append('circle')
            .attr('cx', 12).attr('cy', cy).attr('r', 6)
            .attr('fill', kind === 'dim' ? MUTED : 'none')
            .attr('opacity', kind === 'dim' ? 0.25 : 1)
            .attr('stroke', color ?? 'none')
            .attr('stroke-width', kind === 'glow' ? GLOW_W : RING_W);
        marksSvg.append('text')
            .attr('x', 26).attr('y', cy)
            .attr('dy', '0.35em')
            .attr('fill', INK_2).attr('font-size', 11)
            .text(label);
    });

    // -----------------------------------------------------------------------
    // Part E - the Topic x Section matrix
    // -----------------------------------------------------------------------

    const matrixHost = d3.select('#matrix');

    d3.select('#matrix-topic-key')
        .selectAll('li')
        .data(TOPICS)
        .join('li')
        .html(d => `<span class="swatch" style="background:${colorScale(d.cluster)}"></span>`
            + `<span class="legend-num">${d.cluster}</span> ${esc(d.label)}`
            + ` — ${d.n_passages} passages`);

    const matrixState = { mode: 'share', rows: 'all' };

    const matrixSvg = matrixHost.append('svg').attr('width', MAT_W);
    const matrixG = matrixSvg.append('g');
    const cellLayer = matrixG.append('g');
    const cellRingLayer = matrixG.append('g').attr('pointer-events', 'none');

    // The Blues ramp opens at near-white (#f7fbff), which leaves a cell holding
    // 1% of its section indistinguishable from an empty one.  Entering the ramp
    // part-way in keeps every non-zero cell visibly blue, while the darkest
    // step still means "this is all of that section".
    const BLUES_FLOOR = 0.25;
    const blues = t => d3.interpolateBlues(BLUES_FLOOR + (1 - BLUES_FLOOR) * t);

    // A fuller cell must read as heavier.  The domain runs low-to-high so that
    // 100% takes the darkest step; reversing it here would make the cells
    // disagree with the colour bar, which is drawn from the same ramp.
    const shareScale = d3.scaleSequential(blues).domain([0, 1]);
    const countScale = d3.scaleSequential(blues).domain([0, 160]);

    // One declaration shared by drawMatrix() and highlightMatrixCell(), so the
    // cell ring can never drift from the grid it is drawn on.
    const colW = MAT_GRID_W / TOPICS.length;

    function activeSections() {
        return matrixState.rows === 'compact' ? SECTIONS.slice(0, MAT_COMPACT_N) : SECTIONS;
    }

    function drawMatrix() {
        const sections = activeSections();
        const height = MAT_HEAD_H + sections.length * MAT_ROW_H + MAT_BOTTOM;
        matrixSvg.attr('height', height);

        const y = d3.scaleBand()
            .domain(sections)
            .range([MAT_HEAD_H, MAT_HEAD_H + sections.length * MAT_ROW_H])
            .paddingInner(0.12);

        // --- column headers: swatch, cluster number, short label -------------
        const head = matrixG.selectAll('g.mat-head')
            .data([null])
            .join('g')
            .attr('class', 'mat-head');

        const cols = head.selectAll('g.mat-col')
            .data(TOPICS, d => d.cluster)
            .join('g')
            .attr('class', 'mat-col')
            .attr('transform', (d, i) => `translate(${MAT_LABEL_W + i * colW + colW / 2},0)`);

        cols.selectAll('rect.swatch')
            .data(d => [d])
            .join('rect')
            .attr('class', 'swatch')
            .attr('x', -6).attr('y', 8)
            .attr('width', 12).attr('height', 12)
            .attr('fill', d => colorScale(d.cluster));

        cols.selectAll('text.num')
            .data(d => [d])
            .join('text')
            .attr('class', 'num')
            .attr('y', 16)
            .attr('x', 10)
            .attr('fill', INK_2).attr('font-size', 10)
            .text(d => d.cluster);

        cols.selectAll('text.short')
            .data(d => [d])
            .join('text')
            .attr('class', 'short')
            .attr('y', 34)
            .attr('text-anchor', 'middle')
            .attr('fill', INK_2).attr('font-size', 9.5)
            .each(function (d) {
                // Two lines under a narrow header; the full name lives in the key above.
                const parts = d.short_label.split(' ');
                const mid = Math.ceil(parts.length / 2);
                const lines = [parts.slice(0, mid).join(' '), parts.slice(mid).join(' ')].filter(Boolean);
                d3.select(this).selectAll('tspan')
                    .data(lines)
                    .join('tspan')
                    .attr('x', 0)
                    .attr('dy', (l, i) => (i === 0 ? 0 : 10))
                    .text(l => l);
            });

        // --- rows ------------------------------------------------------------
        const rowG = matrixG.selectAll('g.mat-row')
            .data(sections, d => d)
            .join('g')
            .attr('class', 'mat-row')
            .attr('transform', d => `translate(0,${y(d)})`);

        rowG.selectAll('text.label')
            .data(d => [d])
            .join('text')
            .attr('class', 'label')
            .attr('x', MAT_LABEL_W - MAT_N_W - 11)
            .attr('y', y.bandwidth() / 2)
            .attr('dy', '0.35em')
            .attr('text-anchor', 'end')
            .attr('fill', d => (d === NO_SECTION ? MUTED : INK_2))
            .attr('font-size', 9.5)
            // 40 characters right-aligned in the gutter; longer names would run
            // off the left edge of the SVG.  The full name is in the title and
            // in the cell tooltip.
            .text(d => truncate(d, 40))
            .append('title')
            .text(d => d);

        // The n= is always on screen: under the share fill a one-passage
        // section is a full-intensity cell, and this is what stops it being
        // read as a heavily-weighted row.
        rowG.selectAll('text.n')
            .data(d => [d])
            .join('text')
            .attr('class', 'n')
            .attr('x', MAT_LABEL_W - 6)
            .attr('y', y.bandwidth() / 2)
            .attr('dy', '0.35em')
            .attr('text-anchor', 'end')
            .attr('fill', MUTED).attr('font-size', 9)
            .text(d => d3.format(',')(nBySection.get(d)));

        rowG.selectAll('rect.cell')
            .data(d => TOPICS.map(t => ({ section: d, cluster: t.cluster, topic: t })))
            .join('rect')
            .attr('class', 'cell')
            .attr('x', (d, i) => MAT_LABEL_W + i * colW + 0.5)
            .attr('y', 0)
            .attr('width', Math.max(1, colW - 1))
            .attr('height', y.bandwidth())
            .attr('fill', d => {
                const cell = cellByKey.get(`${d.section}\u0000${d.cluster}`);
                if (!cell) return ZERO_CELL;
                return matrixState.mode === 'share'
                    ? shareScale(cell.prop_of_section)
                    : countScale(cell.count);
            })
            // The shared cursor tooltip, as on the map and the bars - the same
            // interaction should not report itself in a different place per
            // chart.  The full topic name is spelled out here because the
            // column header only has room for the short label.
            .on('mousemove', (event, d) => {
                const cell = cellByKey.get(`${d.section}\u0000${d.cluster}`);
                showTip(event,
                    `<strong>${esc(d.section)}</strong><br>`
                    + `${esc(d.topic.label)} <span style="color:${MUTED}">(topic ${d.cluster})</span><br>`
                    + `${cell ? cell.count : 0} of ${nBySection.get(d.section)} passages`
                    + (cell
                        ? `<br>${(cell.prop_of_section * 100).toFixed(1)}% of the section`
                        + ` · ${(cell.prop_of_topic * 100).toFixed(1)}% of the topic`
                        : ''));
            })
            .on('mouseleave', hideTip)
            .on('click', (event, d) => {
                event.stopPropagation();
                selectCell(d.section, d.cluster);
            });

        // --- colour bar ------------------------------------------------------
        const barScale = matrixState.mode === 'share' ? shareScale : countScale;
        const barMax = matrixState.mode === 'share' ? 1 : 160;
        const barH = height - MAT_HEAD_H - MAT_BOTTOM;
        const bar = matrixG.selectAll('g.colorbar')
            .data([null])
            .join('g')
            .attr('class', 'colorbar')
            .attr('transform', `translate(${MAT_BAR_X},${MAT_HEAD_H})`);

        // Generated top-down from the maximum, because the stops are stacked
        // top-down too.  Stepping the value *upwards* while stacking
        // *downwards* is what put the palest colour under the "100%" tick and
        // left the bar reading as the exact inverse of the cells beside it.
        const N_STOPS = 40;
        const stops = d3.range(N_STOPS + 1).map(i => barScale(barMax * (1 - i / N_STOPS)));

        bar.selectAll('rect')
            .data(stops)
            .join('rect')
            .attr('x', 0)
            .attr('y', (d, i) => (i / (N_STOPS + 1)) * barH)
            .attr('width', 12)
            .attr('height', barH / (N_STOPS + 1) + 1)
            .attr('fill', d => d);

        bar.selectAll('text')
            .data([{ v: barMax, y: 0 }, { v: barMax / 2, y: barH / 2 }, { v: 0, y: barH }])
            .join('text')
            .attr('x', 16)
            .attr('y', d => d.y)
            .attr('dy', '0.35em')
            .attr('fill', MUTED).attr('font-size', 9)
            .text(d => matrixState.mode === 'share'
                ? `${(d.v * 100).toFixed(0)}%`
                : d3.format(',')(d.v));

        matrixG.selectAll('text.bar-title')
            .data([null])
            .join('text')
            .attr('class', 'bar-title')
            // Right-aligned into the gutter rather than centred on the bar, so
            // a long title cannot reach back over the last topic column.
            .attr('x', MAT_W - 4)
            .attr('y', MAT_HEAD_H - 10)
            .attr('text-anchor', 'end')
            .attr('fill', INK_2).attr('font-size', 9.5)
            .text(matrixState.mode === 'share' ? '% of section' : 'passages');

        highlightMatrixCell(state.cell
            ?? (state.selected
                ? { section: byId.get(state.selected).section, cluster: byId.get(state.selected).cluster }
                : null));
    }

    /** One overlay rect moved to the active cell.  Never a stroke on the base
     *  cells: hover also wants stroke, and one channel with two writers is the
     *  bug the whole highlight model exists to avoid. */
    function highlightMatrixCell(key) {
        const sections = activeSections();
        if (!key || !sections.includes(key.section)) {
            cellRingLayer.selectAll('rect.cell-ring').remove();
            return;
        }
        const col = TOPICS.findIndex(t => t.cluster === key.cluster);
        const row = sections.indexOf(key.section);
        if (col < 0) return;

        cellRingLayer.selectAll('rect.cell-ring')
            .data([key])
            .join('rect')
            .attr('class', 'cell-ring')
            .attr('x', MAT_LABEL_W + col * colW + 0.5)
            .attr('y', MAT_HEAD_H + row * MAT_ROW_H)
            .attr('width', Math.max(1, colW - 1))
            .attr('height', MAT_ROW_H)
            .attr('fill', 'none')
            .attr('stroke', INK)
            .attr('stroke-width', 1.6);
    }

    /** Both toggles relabel themselves from the state, so the expansion that
     *  selectPassage() can trigger cannot leave a stale label behind. */
    function setMatrixMode(mode) {
        matrixState.mode = mode;
        matrixHost.select('button.mode').text(mode === 'share' ? 'Show counts' : 'Show % of section');
        drawMatrix();
    }

    function setMatrixRows(rowsMode) {
        matrixState.rows = rowsMode;
        matrixHost.select('button.rows').text(rowsMode === 'all'
            ? `Compact — top ${MAT_COMPACT_N}`
            : `Show all ${SECTIONS.length}`);
        drawMatrix();
    }

    const matrixControls = matrixHost.insert('div', 'svg').attr('class', 'controls-row');
    matrixControls.append('button')
        .attr('class', 'mode')
        .text('Show counts')
        .on('click', () => setMatrixMode(matrixState.mode === 'share' ? 'count' : 'share'));
    matrixControls.append('button')
        .attr('class', 'rows')
        .text(`Compact — top ${MAT_COMPACT_N}`)
        .on('click', () => setMatrixRows(matrixState.rows === 'all' ? 'compact' : 'all'));
    // The hover affordance lives here rather than in a readout under the grid:
    // it has to survive the tooltip replacing that readout.
    matrixControls.append('span').attr('class', 'summary')
        .text(`${SECTIONS.length} sections × ${TOPICS.length} topics · sorted by size`
            + ' · hover a cell for its section, topic and share');

    // -----------------------------------------------------------------------
    // Start
    // -----------------------------------------------------------------------

    drawMatrix();
    clearDetail();
    updateStyles();
}

draw();
