// Lab 10 - Novel interaction with the Lab 9 geospatial visualization.
//
// The assignment is to take one visualization from Labs 1-9 and extend it with
// a novel input modality, without rebuilding it.  The one extended here is
// Lab 9's pair of 2025 GDP maps: the choropleth and the cartogram, which already
// share one linked-highlight state.
//
// The map drawing below is Lab 9's, carried over unchanged in substance - same
// join, same projection, same cartogram pass, same single-writer updateStyles().
// What is new is everything from "Command API" onward:
//
//   1. A command API.  Lab 9 can only set its selection with a mouse click -
//      toggleSelected() is a closure nothing outside draw() can reach.  A voice
//      or gesture layer has nothing to call until that changes, so draw() now
//      returns an object of commands instead of firing and forgetting.
//
//   2. A filter, which Lab 9 had no concept of at all.  Its state was exactly
//      { hovered, selected }, so "show the top 10" and "show the 1,000-2,000
//      class" needed new state and a new branch in the opacity rule.
//
//   3. Two input modalities, voice and hand gesture, plus conventional controls
//      for every action they can perform.
//
// The design constraint that shapes the whole file: an input modality is only
// allowed to *call* the visualization, never to write it.  Every command ends
// in refresh(), which is the same single writer Lab 9 used, so a voice command,
// a gesture and a mouse click cannot disagree about what the map shows.
//
// On the visual rule, one deliberate departure from Lab 9.  There, a pinned
// country dims the other 49.  Here a *filter* - a tier or a top-k - dims what it
// excludes and outlines nothing, because outlining 26 same-tier countries is
// noise while dimming reads instantly.  A *pin* keeps Lab 9's behaviour exactly.
// Pin takes precedence over filter, so selecting a country inside an active
// filter still works and the two compose.
//
// There is no region/continent field in either the topology or the CSV - their
// properties are name plus the two ISO codes - so Lab10.md's filterRegion("Asia")
// example has no data behind it.  GDP classes, which the colour ramp already
// defines, carry the same "compare like-sized economies" task and do have data.

import * as d3 from 'd3';
import { feature as topoFeature } from 'topojson-client';
import { cartogram } from 'topogram';
import { FilesetResolver, GestureRecognizer } from '@mediapipe/tasks-vision';
import { mountNav } from './nav.js';
import '../styles/main.css';

mountNav('#nav');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOPO_URL = `${import.meta.env.BASE_URL}data/countries.topo.json`;
const GDP_URL = `${import.meta.env.BASE_URL}data/lab9_gdp_2025_top50.csv`;

// Vendored by `npm run vendor:mediapipe` into public/, not fetched from a CDN:
// the gesture controls are one of the two graded modalities and should not stop
// working because a third party is slow or the network is down.  Resolved
// against BASE_URL because the site is served from /stats401-labs/ on Pages.
const WASM_PATH = `${import.meta.env.BASE_URL}mediapipe/wasm`;
const MODEL_PATH = `${import.meta.env.BASE_URL}mediapipe/models/gesture_recognizer.task`;

const GEO_ISO_KEY = 'ISO3166-1-Alpha-3';
const ISO_SENTINEL = '-99';

const MAP_W = 920;
const MAP_H = 430;

const MAP_TOP = 30;
const MAP_INSET = 8;

const EXCLUDED = new Set(['Antarctica']);

const CARTOGRAM_ITERATIONS = 40;

const REF_GDP_VALUES = [500, 2000, 5000, 10000];
const REF_GAP = 16;
const REF_CHAR_W = 6.2;

const GDP_BREAKS = [500, 1000, 2000, 4000, 10000];
const GDP_CLASS_LABELS = [
    'under 500',
    '500 – 1,000',
    '1,000 – 2,000',
    '2,000 – 4,000',
    '4,000 – 10,000',
    '10,000+'
];

const INK = '#0b0b0b';
const MUTED = '#898781';
const NO_DATA = '#c3c2b7';
const CARTOGRAM_FILL = '#2a78d6';
const CONTEXT_FILL = '#e8e7e1';
const BORDER = '#ffffff';

const CHOROPLETH_BORDER_W = 0.6;
const CARTOGRAM_BORDER_W = 0.7;
const HOT_BORDER_W = 1.8;

// Lab 9's dim value, kept identical so the two pages read the same.
const DIM = 0.28;

const fmtGdp = d3.format(',.0f');

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

function isoOfProps(props) {
    const raw = props[GEO_ISO_KEY];

    if (raw == null || String(raw).trim() === ISO_SENTINEL) return null;

    return String(raw).trim();
}

function isoOf(feature) {
    return isoOfProps(feature.properties);
}

/** Lowercase alphanumerics only, so accents and punctuation do not decide a
 *  match.  Lab 9 needed this for the join fallback; Lab 10 reuses it to match a
 *  spoken country name against the same spellings. */
function normalizeName(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

function idOf(props) {
    return isoOfProps(props) ?? `name:${normalizeName(props.name)}`;
}

/** Escape for interpolation into .html().  Country names are safe here, but the
 *  dataset labels come from a CSV and one of them contains a comma-quoted
 *  "Korea, Republic of", so this is cheap insurance rather than decoration. */
function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Index of the GDP class `gdp` falls in, as an index into GDP_CLASS_LABELS.
 *
 * bisectRight, not bisectLeft: d3.scaleThreshold resolves a value with
 * bisectRight internally, so this has to agree with it exactly.  Get it wrong
 * and a gesture highlights one class while the legend and the fill colour show
 * another - a bug that only shows up on the 50 values that sit near a break.
 */
function classIndexOf(gdp) {
    return d3.bisectRight(GDP_BREAKS, gdp);
}

// ---------------------------------------------------------------------------
// Join  (Lab 9 Part A, carried over)
// ---------------------------------------------------------------------------

function joinGDP(features, gdpRows) {
    const byIso = new Map(gdpRows.map(d => [d.iso3, d]));

    const byName = new Map();
    const collisions = [];

    for (const row of gdpRows) {
        const key = normalizeName(row.country);

        if (byName.has(key)) collisions.push(key);
        else byName.set(key, row);
    }

    const report = {
        featureCount: features.length,
        rowCount: gdpRows.length,
        matchedByIso: [],
        matchedByName: [],
        unmatchedRows: [],
        noIsoCode: [],
        collisions
    };

    const claimed = new Set();

    for (const feature of features) {
        const iso = isoOf(feature);

        let row = iso ? byIso.get(iso) : undefined;
        let how = 'iso';

        if (!row) {
            row = byName.get(normalizeName(feature.properties.name));
            how = 'name';
        }

        const gdp = row && Number.isFinite(row.gdp) ? row.gdp : null;

        feature.properties.gdp = gdp;
        feature.properties.rank = row && gdp !== null ? row.rank : null;
        feature.properties.gdpCountry = row && gdp !== null ? row.country : null;

        if (iso === null) report.noIsoCode.push(feature.properties.name);

        if (!row) continue;

        if (claimed.has(row.iso3)) {
            report.collisions.push(`duplicate feature for ${row.iso3}`);
            continue;
        }

        claimed.add(row.iso3);
        (how === 'iso' ? report.matchedByIso : report.matchedByName).push(row);
    }

    report.unmatchedRows = gdpRows.filter(d => !claimed.has(d.iso3));

    return report;
}

function logReport(report) {
    const list = rows => rows.map(d => d.iso3).join(', ') || 'none';

    console.group('Lab 10 - GDP / topology join');

    console.log(`GeoJSON features         ${report.featureCount}`);
    console.log(`GDP rows                 ${report.rowCount}`);
    console.log(`matched by ISO-3         ${report.matchedByIso.length}`);
    console.log(`matched by name          ${report.matchedByName.length}`);
    console.log(`  ${list(report.matchedByName)}`);
    console.log(`GDP rows with no feature ${report.unmatchedRows.length}`);
    console.log(`features with no ISO-3   ${report.noIsoCode.length}  (shown as no data)`);

    if (report.unmatchedRows.length) {
        console.warn('GDP rows with no matching country:', report.unmatchedRows);
    }

    console.groupEnd();
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function loadData() {
    const [topo, gdpRows] = await Promise.all([
        d3.json(TOPO_URL),

        d3.csv(GDP_URL, d => ({
            iso3: d.iso3,
            country: d.country,
            gdp: +d.gdp_2025_billion_usd,
            rank: +d.rank
        }))
    ]);

    const features = topoFeature(topo, topo.objects.countries).features;

    const report = joinGDP(features, gdpRows);

    return { topo, features, gdpRows, report };
}

// ---------------------------------------------------------------------------
// Spoken-name resolution
// ---------------------------------------------------------------------------

/**
 * Names speech uses that neither data source does.  Values are ISO-3 codes
 * rather than spellings, because the codes are unique and unambiguous while
 * "korea" is not a country name in either file.
 *
 * This table exists because the recogniser transcribes what people say, and
 * nobody says "Korea, Republic of" or "Türkiye".  Without it those commands
 * fail with "not recognized" even though the words were heard perfectly, which
 * is the most frustrating possible failure: the user is told they were
 * misunderstood when the real problem is a spelling in a CSV.
 */
const ALIASES = new Map(Object.entries({
    america: 'USA',
    'united states of america': 'USA',
    us: 'USA',
    usa: 'USA',
    uk: 'GBR',
    britain: 'GBR',
    'great britain': 'GBR',
    england: 'GBR',
    korea: 'KOR',
    'south korea': 'KOR',
    russia: 'RUS',
    turkey: 'TUR',
    turkiye: 'TUR',
    vietnam: 'VNM',
    czechia: 'CZE',
    'czech republic': 'CZE',
    holland: 'NLD',
    uae: 'ARE',
    'emirates': 'ARE'
}));

/**
 * Match a spoken phrase to a country id.
 *
 * Graded rather than first-hit, because a transcript is noisy in both
 * directions: "show me japan please" is longer than the key it contains, and
 * "the united states of america" is longer than the dataset's "United States".
 * Order: exact key, then alias, then the longest key contained in the phrase.
 *
 * Returns the id and the name to report, or null.  Resolving here rather than
 * in the voice layer keeps gesture and voice on one implementation, and means a
 * spoken country resolves to the same id a mouse click produces.
 */
function makeResolver({ idByName, idByIso, nameById }) {
    function byIso(iso) {
        const id = idByIso.get(iso);
        return id ? { id, name: nameById.get(id) } : null;
    }

    return function resolve(spoken) {
        const key = normalizeName(spoken);
        if (!key) return null;

        if (idByName.has(key)) {
            const id = idByName.get(key);
            return { id, name: nameById.get(id) };
        }

        if (ALIASES.has(key)) return byIso(ALIASES.get(key));

        // Longest contained key wins.  Shortest would be catastrophic: "chad"
        // is a substring of nothing useful, but "india" sits inside "british
        // indian ocean territory", and "niger" inside "nigeria".
        let best = null;

        for (const [name, id] of idByName) {
            if (!key.includes(name)) continue;
            if (!best || name.length > best.name.length) best = { name, id };
        }

        if (!best) return null;

        return { id: best.id, name: nameById.get(best.id) };
    };
}

// ---------------------------------------------------------------------------
// Draw
// ---------------------------------------------------------------------------

/**
 * Draw both maps and return the command API the interaction layers call.
 *
 * Every command returns { ok, message }: `message` is written for a person to
 * read aloud in the feedback log, and `ok` lets a caller fall through to the
 * next interpretation.  Commands never touch the DOM; they set state and call
 * refresh(), exactly as a mouse click does.
 */
async function draw() {
    const { topo, features, gdpRows, report } = await loadData();

    logReport(report);

    const renderFeatures = features.filter(f => !EXCLUDED.has(f.properties.name));

    // -----------------------------------------------------------------------
    // Lookup tables
    // -----------------------------------------------------------------------

    const rowByIso = new Map(gdpRows.map(d => [d.iso3, d]));
    const rowByName = new Map(gdpRows.map(d => [normalizeName(d.country), d]));

    function keyOf(props) {
        const iso = isoOfProps(props);

        if (iso && rowByIso.has(iso)) return iso;

        const row = rowByName.get(normalizeName(props.name));

        return row ? row.iso3 : null;
    }

    const propsById = new Map(renderFeatures.map(f => [idOf(f.properties), f.properties]));
    const nameById = new Map(renderFeatures.map(f => [idOf(f.properties), f.properties.name]));

    const idByIso = new Map();
    const idByName = new Map();

    for (const feature of renderFeatures) {
        const { properties } = feature;
        const iso = isoOfProps(properties);

        if (iso) idByIso.set(iso, idOf(properties));

        idByName.set(normalizeName(properties.name), idOf(properties));
    }

    // The dataset's own labels are a second spelling of the same country and
    // must land on the same id, or saying "Korea, Republic of" would light up a
    // different shape than hovering South Korea does.
    for (const row of gdpRows) {
        const id = idByIso.get(row.iso3);
        if (id) idByName.set(normalizeName(row.country), id);
    }

    const resolveCountry = makeResolver({ idByName, idByIso, nameById });

    // -----------------------------------------------------------------------
    // Scales and projection
    // -----------------------------------------------------------------------

    const colorScale = d3.scaleThreshold()
        .domain(GDP_BREAKS)
        .range(d3.quantize(t => d3.interpolateBlues(0.35 + 0.65 * t), GDP_CLASS_LABELS.length));

    const fillOf = props => (props.gdp == null ? NO_DATA : colorScale(props.gdp));

    const projection = d3.geoNaturalEarth1().fitExtent(
        [[MAP_INSET, MAP_TOP], [MAP_W - MAP_INSET, MAP_H - MAP_INSET]],
        { type: 'FeatureCollection', features: renderFeatures }
    );

    const path = d3.geoPath(projection);

    // -----------------------------------------------------------------------
    // Tooltip
    // -----------------------------------------------------------------------

    const tooltip = d3.select('#tooltip');

    function showTip(event, props) {
        const body = props.gdp == null
            ? `<span style="color:${MUTED}">Not in the top 50 &mdash; no data</span>`
            : `2025 GDP: <strong>$${fmtGdp(props.gdp)}B</strong><br>`
              + `<span style="color:${MUTED}">rank ${props.rank} of 50</span>`;

        tooltip
            .html(`<strong>${esc(props.name)}</strong><br>${body}`)
            .style('left', `${event.pageX + 14}px`)
            .style('top', `${event.pageY - 30}px`)
            .style('opacity', 1);
    }

    function moveTip(event) {
        tooltip
            .style('left', `${event.pageX + 14}px`)
            .style('top', `${event.pageY - 30}px`);
    }

    function hideTip() {
        tooltip.style('opacity', 0);
    }

    // -----------------------------------------------------------------------
    // Shared state
    //
    // Lab 9's two fields plus a filter.  `filter` is null, or one of:
    //   { kind: 'tier', index }  one GDP class, by index into GDP_CLASS_LABELS
    //   { kind: 'topk', k }      the k largest economies by rank
    //
    // One field rather than two, because the two are alternatives the user
    // switches between, not a stack - "show the top 10" after "show 10,000+"
    // should replace that view, not intersect with it.
    // -----------------------------------------------------------------------

    const state = { hovered: null, selected: null, filter: null };

    const isHot = props => {
        const id = idOf(props);
        return id === state.hovered || id === state.selected;
    };

    function inFilter(props) {
        if (!state.filter) return true;

        if (state.filter.kind === 'topk') {
            return props.rank != null && props.rank <= state.filter.k;
        }

        return props.gdp != null && classIndexOf(props.gdp) === state.filter.index;
    }

    const opacityOf = props => {
        // A pin dims everything but one country; a filter dims only what it
        // excludes.  Pin first, so a selected country stays legible inside an
        // active filter instead of being dimmed by it.
        if (state.selected) return idOf(props) === state.selected ? 1 : DIM;
        if (state.filter) return inFilter(props) ? 1 : DIM;
        return 1;
    };

    let cgCountries = null;

    // Filled by the legend below; empty until then, so refresh() is safe to
    // call at any point in the setup.
    const tierSwatches = [];

    // -----------------------------------------------------------------------
    // Part B - choropleth
    // -----------------------------------------------------------------------

    const svg = d3.select('#choropleth')
        .append('svg')
        .attr('width', MAP_W)
        .attr('height', MAP_H);

    const mapLayer = svg.append('g').attr('class', 'map-layer');

    const countries = mapLayer.selectAll('.country')
        .data(renderFeatures)
        .join('path')
        .attr('class', 'country')
        .attr('d', path)
        .attr('fill', d => fillOf(d.properties));

    // -----------------------------------------------------------------------
    // Part C - cartogram
    // -----------------------------------------------------------------------

    const gdpFeatures = renderFeatures.filter(f => f.properties.gdp != null);

    const cartogramInput = gdpFeatures.filter(f => path.area(f) > 0);

    if (cartogramInput.length !== gdpFeatures.length) {
        console.warn(
            'Lab 10: these GDP countries have no projected area and are omitted ' +
            'from the cartogram (regenerate the topology?):',
            gdpFeatures.filter(f => path.area(f) === 0).map(f => f.properties.name)
        );
    }

    const cartogramKeys = new Set(cartogramInput.map(f => keyOf(f.properties)));

    const cartogramGeometries = topo.objects.countries.geometries
        .filter(g => cartogramKeys.has(keyOf(g.properties)));

    const cgSvg = d3.select('#cartogram')
        .append('svg')
        .attr('width', MAP_W)
        .attr('height', MAP_H);

    cgSvg.append('g')
        .attr('class', 'cartogram-context')
        .selectAll('path')
        .data(renderFeatures)
        .join('path')
        .attr('d', path)
        .attr('fill', CONTEXT_FILL)
        .attr('stroke', 'none');

    cgSvg.select('.cartogram-context').attr('pointer-events', 'none');

    const cgLayer = cgSvg.append('g').attr('class', 'cartogram-layer');

    // -----------------------------------------------------------------------
    // The single writer
    // -----------------------------------------------------------------------

    /** The only place a visual property of a country is written. */
    function updateStyles() {
        const maps = [
            [countries, CHOROPLETH_BORDER_W],
            [cgCountries, CARTOGRAM_BORDER_W]
        ];

        for (const [selection, baseW] of maps) {
            if (!selection) continue;

            selection
                .attr('stroke', d => (isHot(d.properties) ? INK : BORDER))
                .attr('stroke-width', d => (isHot(d.properties) ? HOT_BORDER_W : baseW))
                .attr('fill-opacity', d => opacityOf(d.properties));

            selection.filter(d => isHot(d.properties)).raise();
        }
    }

    /**
     * Mark the active class in the legend.
     *
     * Without this a tier filter is only visible as a pattern of dimming, and
     * the reader cannot tell whether the four pale countries are a class of
     * their own or simply countries with no data - the grey no-data swatch and
     * the lightest blue are deliberately close in lightness.
     */
    function updateLegend() {
        for (const { node, index } of tierSwatches) {
            node.classed(
                'legend-active',
                state.filter?.kind === 'tier' && state.filter.index === index
            );
        }
    }

    // Anything that wants to mirror the map's state - currently the details
    // panel - subscribes here rather than polling.  A 250ms poll would also work
    // and is worse: it keeps the page awake forever, and it can lag a gesture by
    // up to a quarter second.
    const listeners = [];

    function refresh() {
        updateStyles();
        updateLegend();

        for (const listener of listeners) listener();
    }

    function setHovered(props) {
        state.hovered = props ? idOf(props) : null;
        refresh();
    }

    function toggleSelected(props) {
        const id = idOf(props);
        const wasSelected = state.selected === id;

        state.selected = wasSelected ? null : id;
        refresh();

        return wasSelected
            ? { ok: true, message: 'selection cleared' }
            : { ok: true, message: `selected ${props.name}` };
    }

    /** Wire one map's shapes to the shared state. */
    function bindInteraction(selection) {
        selection
            .style('cursor', 'pointer')
            .on('mouseover', (event, d) => {
                setHovered(d.properties);
                showTip(event, d.properties);
            })
            .on('mousemove', moveTip)
            .on('mouseout', () => {
                setHovered(null);
                hideTip();
            })
            .on('click', (event, d) => {
                event.stopPropagation();
                toggleSelected(d.properties);
            });
    }

    bindInteraction(countries);

    // -----------------------------------------------------------------------
    // Zoom (choropleth only, as in Lab 9)
    // -----------------------------------------------------------------------

    const zoom = d3.zoom()
        .scaleExtent([1, 8])
        .on('zoom', event => mapLayer.attr('transform', event.transform));

    svg.call(zoom);

    function clearSelection() {
        state.selected = null;
        refresh();
    }

    // Clicking the ocean clears a pinned selection.  Country clicks stop
    // propagation, so this only fires on the background of either map.
    svg.on('click', clearSelection);
    cgSvg.on('click', clearSelection);

    // -----------------------------------------------------------------------
    // Legend
    // -----------------------------------------------------------------------

    const legendSvg = d3.select('#legend')
        .append('svg')
        .attr('class', 'choropleth-legend');

    const SWATCH_W = 16;
    const SWATCH_H = 12;
    const SWATCH_GAP = 8;
    const ITEM_GAP = 18;
    const ROW_Y = 34;

    legendSvg.append('text')
        .attr('class', 'legend-title')
        .attr('x', 0)
        .attr('y', 12)
        .text('2025 nominal GDP (billions of US dollars)');

    const items = [
        ...GDP_CLASS_LABELS.map((label, i) => ({
            label,
            fill: colorScale.range()[i],
            tierIndex: i
        })),
        { label: 'not in top 50', fill: NO_DATA, noData: true }
    ];

    const CHAR_W = 6.2;
    let cursor = 0;

    for (const item of items) {
        const g = legendSvg.append('g').attr('transform', `translate(${cursor}, ${ROW_Y})`);

        g.append('rect')
            .attr('class', item.noData ? 'legend-nodata' : null)
            .attr('width', SWATCH_W)
            .attr('height', SWATCH_H)
            .attr('fill', item.fill)
            .attr('stroke', '#ffffff')
            .attr('stroke-width', 0.6);

        g.append('text')
            .attr('x', SWATCH_W + SWATCH_GAP)
            .attr('y', SWATCH_H - 1)
            .text(item.label);

        if (item.tierIndex !== undefined) {
            tierSwatches.push({ node: g, index: item.tierIndex });
        }

        cursor += SWATCH_W + SWATCH_GAP + item.label.length * CHAR_W + ITEM_GAP;
    }

    const legendW = Math.ceil(cursor);
    const legendH = ROW_Y + SWATCH_H + 4;

    legendSvg
        .attr('width', legendW)
        .attr('height', legendH)
        .attr('viewBox', `0 0 ${legendW} ${legendH}`);

    // -----------------------------------------------------------------------
    // Compute the cartogram
    // -----------------------------------------------------------------------

    const status = d3.select('#cartogram')
        .insert('p', 'svg')
        .attr('class', 'caption')
        .text('Computing cartogram…');

    function drawCartogram() {
        const value = cartogram()
            .projection(projection)
            .properties(geom => {
                const key = keyOf(geom.properties);
                const row = key ? rowByIso.get(key) : null;

                return {
                    ...geom.properties,
                    iso3: key,
                    gdp: row ? row.gdp : null,
                    rank: row ? row.rank : null
                };
            })
            .value(f => f.properties.gdp)
            .iterations(CARTOGRAM_ITERATIONS);

        const { features: distorted } = value(topo, cartogramGeometries);

        const plainPath = d3.geoPath();

        cgCountries = cgLayer.selectAll('.cartogram-country')
            .data(distorted)
            .join('path')
            .attr('class', 'cartogram-country')
            .attr('d', plainPath)
            .attr('fill', CARTOGRAM_FILL);

        bindInteraction(cgCountries);
        refresh();
        status.remove();

        // -------------------------------------------------------------------
        // Area references
        // -------------------------------------------------------------------

        const drawnArea = d3.sum(distorted, f => plainPath.area(f));
        const totalGdp = d3.sum(gdpRows, d => d.gdp);

        const refs = REF_GDP_VALUES.map(value => {
            const side = Math.sqrt(drawnArea * (value / totalGdp));
            const label = `$${fmtGdp(value)}B`;

            return {
                side,
                label,
                width: Math.max(side, label.length * REF_CHAR_W)
            };
        });

        const rowW = d3.sum(refs, r => r.width) + REF_GAP * (refs.length - 1);

        const maxSide = d3.max(refs, r => r.side);
        const labelY = MAP_H - MAP_INSET - 9;
        const rowBottom = labelY - 15;
        const rowTop = rowBottom - maxSide;

        const ref = cgSvg.append('g').attr('class', 'area-reference');

        ref.append('rect')
            .attr('x', MAP_INSET)
            .attr('y', rowTop - 26)
            .attr('width', rowW + 24)
            .attr('height', labelY - rowTop + 34)
            .attr('fill', '#fcfcfb')
            .attr('fill-opacity', 0.9);

        ref.append('text')
            .attr('class', 'area-reference-title')
            .attr('x', MAP_INSET + 6)
            .attr('y', rowTop - 12)
            .text('Area scale');

        let refX = MAP_INSET + 6;

        for (const r of refs) {
            ref.append('rect')
                .attr('x', refX)
                .attr('y', rowBottom - r.side)
                .attr('width', r.side)
                .attr('height', r.side)
                .attr('fill', CARTOGRAM_FILL);

            ref.append('text')
                .attr('class', 'area-reference-label')
                .attr('x', refX)
                .attr('y', labelY)
                .text(r.label);

            refX += r.width + REF_GAP;
        }
    }

    requestAnimationFrame(() => {
        try {
            drawCartogram();
        } catch (error) {
            status.text('The cartogram could not be computed — see the console.');
            console.error('Lab 10: cartogram failed', error);
        }
    });

    // -----------------------------------------------------------------------
    // Command API
    //
    // Everything below is what a modality is allowed to do.  Each command sets
    // state and calls refresh(); none of them touch the DOM directly, which is
    // what keeps a spoken command and a click indistinguishable to the map.
    // -----------------------------------------------------------------------

    function selectById(id) {
        if (!propsById.has(id)) return { ok: false, message: 'unknown country' };

        state.selected = id;
        refresh();

        const props = propsById.get(id);
        const rank = props.rank == null ? 'not in the top 50' : `rank ${props.rank}`;

        return { ok: true, message: `selected ${props.name} (${rank})` };
    }

    function selectByName(spoken) {
        const match = resolveCountry(spoken);

        if (!match) return { ok: false, message: `no country matching "${spoken}"` };

        return selectById(match.id);
    }

    function commandClearSelection() {
        if (!state.selected) return { ok: true, message: 'nothing was selected' };

        const props = propsById.get(state.selected);
        clearSelection();

        return { ok: true, message: `cleared selection (${props?.name ?? 'country'})` };
    }

    function setTierIndex(index) {
        const count = renderFeatures.filter(
            f => f.properties.gdp != null && classIndexOf(f.properties.gdp) === index
        ).length;

        state.filter = { kind: 'tier', index };
        refresh();

        return {
            ok: true,
            message: `GDP class ${index + 1} of ${GDP_CLASS_LABELS.length}: `
                + `${GDP_CLASS_LABELS[index]} — ${count} countries`
        };
    }

    /**
     * Step the tier filter by `delta`, wrapping at both ends.
     *
     * The first press enters at the end it is stepping toward (down from
     * nothing starts at the largest class, up starts at the smallest) rather
     * than always at class 0, so "previous class" does not first jump to the
     * other end of the range.
     */
    function stepTier(delta) {
        const n = GDP_CLASS_LABELS.length;
        const current = state.filter?.kind === 'tier' ? state.filter.index : null;

        let next;

        if (current === null) next = delta > 0 ? 0 : n - 1;
        else next = (current + delta + n) % n;

        return setTierIndex(next);
    }

    function setTopK(k) {
        const max = gdpRows.length;
        const wanted = Math.round(k);
        const clamped = Math.max(1, Math.min(max, wanted));

        state.filter = { kind: 'topk', k: clamped };
        refresh();

        const note = clamped === wanted
            ? ''
            : ` (asked for ${wanted}; only ${max} countries have data)`;

        return {
            ok: true,
            message: `showing the top ${clamped} economies by GDP${note}`
        };
    }

    function clearFilter() {
        if (!state.filter) return { ok: true, message: 'no filter was active' };

        const what = state.filter.kind === 'tier'
            ? `GDP class ${state.filter.index + 1}`
            : `top ${state.filter.k}`;

        state.filter = null;
        refresh();

        return { ok: true, message: `cleared filter (${what})` };
    }

    function resetZoom() {
        svg.transition().duration(450).call(zoom.transform, d3.zoomIdentity);

        return { ok: true, message: 'reset zoom' };
    }

    function resetAll() {
        const had = state.selected || state.filter;

        state.selected = null;
        state.filter = null;
        svg.transition().duration(450).call(zoom.transform, d3.zoomIdentity);
        refresh();

        return {
            ok: true,
            message: had ? 'reset selection, filter and zoom' : 'reset zoom'
        };
    }

    /**
     * What the map is currently showing, as plain data.
     *
     * The details panel is the one place that has to describe a *set* - the map
     * can only say "these shapes are vivid and those are pale", which is not
     * enough to answer "which ten, and how big is each one".  Returning rows
     * rather than a formatted string keeps the wording in the panel, where it
     * can be laid out, instead of here where it can only be a sentence.
     */
    function snapshot() {
        const selected = state.selected ? propsById.get(state.selected) : null;

        let heading = null;
        let rows = [];

        if (state.filter?.kind === 'topk') {
            heading = `Top ${state.filter.k} economies by GDP`;
            rows = gdpRows.filter(d => d.rank <= state.filter.k);
        } else if (state.filter?.kind === 'tier') {
            const index = state.filter.index;
            heading = `GDP class: ${GDP_CLASS_LABELS[index]}`;
            rows = gdpRows.filter(d => classIndexOf(d.gdp) === index);
        }

        return {
            // The raw filter as well as the rows it produced.  A conventional
            // control has to be able to show which filter is active, and a
            // gesture or a spoken command can change that without the control
            // ever being touched - so it reads this rather than trusting what
            // the user last did to it.
            filter: state.filter,
            selected: selected && {
                name: selected.name,
                gdp: selected.gdp,
                rank: selected.rank,
                // Null for a country outside the top 50: it has a shape but no
                // figure, and a class label would be a lie about missing data.
                classLabel: selected.gdp == null
                    ? null
                    : GDP_CLASS_LABELS[classIndexOf(selected.gdp)]
            },
            heading,
            // Rank order, so the list reads the way the bar in the legend does.
            rows: [...rows]
                .sort((a, b) => a.rank - b.rank)
                .map(d => ({ rank: d.rank, country: d.country, gdp: d.gdp }))
        };
    }

    return {
        // commands
        selectById,
        selectByName,
        clearSelection: commandClearSelection,
        setTierIndex,
        stepTier,
        setTopK,
        clearFilter,
        resetAll,
        resetZoom,
        // data a conventional control needs to build itself
        gdpRows: [...gdpRows].sort((a, b) => a.rank - b.rank),
        classLabels: GDP_CLASS_LABELS,
        snapshot,
        onChange(listener) {
            listeners.push(listener);
            listener();
        }
    };
}

// ---------------------------------------------------------------------------
// Feedback log
//
// Part C of the assignment: the user must never have to guess whether the
// system understood them.  Every command, whatever triggered it, lands here.
// ---------------------------------------------------------------------------

function mountLog() {
    const list = d3.select('#lab10-log');

    /** @param {string} source 'voice' | 'gesture' | 'control' */
    function log(source, heard, action) {
        list.select('.log-empty').remove();

        const entry = list.insert('li', ':first-child')
            .attr('class', `log-entry log-${source}`);

        entry.append('span').attr('class', 'log-source').text(source);

        const body = entry.append('span').attr('class', 'log-body');

        if (heard) {
            body.append('span').attr('class', 'log-heard').text(heard);
            body.append('span').attr('class', 'log-arrow').text('→');
        }

        body.append('span').attr('class', 'log-action').text(action);

        // A long demo would otherwise push the page footer off the screen.
        const entries = list.selectAll('li');
        if (entries.size() > 8) entries.filter((d, i) => i >= 8).remove();
    }

    return log;
}

// ---------------------------------------------------------------------------
// Voice  (Lab10.md Part I)
// ---------------------------------------------------------------------------

/**
 * English number words, for "show the top ten".
 *
 * Speech recognition returns "ten" far more often than "10", so a numeric-only
 * parser would reject the phrasing people actually use.
 */
const NUMBER_WORDS = new Map(Object.entries({
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
    fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
    nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50
}));

/** Punctuation out, whitespace collapsed: "Show me Asia!" -> "show me asia". */
function normalizeCommand(text) {
    return String(text ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Read a count out of a token list, as digits or English words.
 *
 * Compound numbers matter here: without the tens+units branch, a spoken
 * "twenty five" parses as 20 and silently filters to the wrong set, which looks
 * like a recognition error but is really a parsing one.
 */
function readCount(tokens) {
    for (let i = 0; i < tokens.length; i++) {
        if (/^\d+$/.test(tokens[i])) return Number(tokens[i]);

        const first = NUMBER_WORDS.get(tokens[i]);
        if (first === undefined) continue;

        const second = NUMBER_WORDS.get(tokens[i + 1]);

        if (first >= 20 && first % 10 === 0 && second !== undefined && second < 10) {
            return first + second;
        }

        return first;
    }

    return null;
}

// Filler that carries no command meaning.  Stripped only when hunting for a
// country name, never before the verb checks above, so "show" is still visible
// as a verb to the patterns that need it.
const FILLER = new Set([
    'select', 'highlight', 'show', 'display', 'choose', 'pick', 'focus', 'find',
    'me', 'the', 'a', 'an', 'please', 'country', 'countries', 'on', 'in', 'map',
    'to', 'for', 'of', 'and', 'it', 'is', 'that'
]);

/**
 * Map one transcript to one command.  Returns { ok, message }.
 *
 * Deliberately ordered most-specific-first: "reset zoom", "clear filter" and
 * the tier commands all contain a bare word that a later, looser rule would
 * otherwise claim.  The country rule is last and is the loosest, because any
 * unrecognised phrase should be tried as a country name before being refused.
 */
function runVoiceCommand(viz, transcript) {
    const text = normalizeCommand(transcript);

    if (!text) return { ok: false, message: 'heard nothing' };

    const tokens = text.split(' ');
    const has = (...words) => words.some(w => new RegExp(`\\b${w}\\b`).test(text));

    if (has('reset')) {
        if (has('zoom')) return viz.resetZoom();
        if (has('filter')) return viz.clearFilter();
        if (has('selection', 'select')) return viz.clearSelection();
        return viz.resetAll();
    }

    if (has('clear', 'remove', 'deselect', 'unselect')) {
        if (has('filter', 'tier', 'class')) return viz.clearFilter();
        if (has('selection', 'select')) return viz.clearSelection();

        return { ok: false, message: 'say "clear filter" or "clear selection"' };
    }

    if (has('tier', 'class', 'group')) {
        if (has('next', 'up', 'higher', 'increase', 'forward', 'bigger')) return viz.stepTier(1);
        if (has('previous', 'prev', 'back', 'down', 'lower', 'decrease', 'smaller')) return viz.stepTier(-1);

        return { ok: false, message: 'say "next tier" or "previous tier"' };
    }

    if (has('top')) {
        const k = readCount(tokens.slice(tokens.indexOf('top') + 1));

        if (k == null) return { ok: false, message: 'say "top ten", with a number' };
        if (k < 1) return { ok: false, message: 'the count has to be at least 1' };

        return viz.setTopK(k);
    }

    // Country last, and tried twice: once with the filler stripped, so "show me
    // japan on the map" reduces to "japan", and once verbatim, so a country
    // whose name contains a filler word still resolves.
    const stripped = tokens.filter(t => !FILLER.has(t)).join(' ');
    const byStripped = stripped ? viz.selectByName(stripped) : { ok: false };

    if (byStripped.ok) return byStripped;

    return viz.selectByName(text);
}

/**
 * How long the engine keeps running after the user asks it to stop.
 *
 * The microphone is capturing continuously, but turning that audio into text
 * lags behind it by a fraction of a second.  Stopping the engine the instant the
 * fist closes therefore throws away the last word - it was captured, but not yet
 * recognised - and "show top ten" arrives as "show top te...".  This grace
 * period lets the engine finish the word it is already holding.
 *
 * It costs that much delay before a command runs, and the failure is asymmetric:
 * too long is a sluggish second, too short silently eats a word from every
 * command and looks like the recogniser is bad at accents.
 */
const TAIL_MS = 600;

/**
 * A ceiling on how long the microphone can stay open.
 *
 * The window is bounded by an explicit stop - the fist, or the button - so this
 * only ever fires when that stop never came: the hand left frame, the gesture
 * was missed, the user walked away.  Without it a missed stop leaves the
 * microphone live indefinitely, which is the one failure of this design that
 * matters beyond the interface.  Long enough that no real command hits it.
 */
const MAX_WINDOW_MS = 20000;

/**
 * Wire up speech recognition as a bounded recording window.
 *
 * Open palm (or the button) opens the window; closed fist closes it and runs
 * whatever was heard.  Nothing is dispatched while the window is open and
 * nothing restarts behind the user's back, so there is exactly one command per
 * window and the microphone is live only between two deliberate gestures.
 *
 * This replaced a continuous session that listened indefinitely and ran a
 * command 800ms after any silence.  That design had the recogniser live the
 * whole time, which meant it also heard everything the user did not mean as a
 * command - conversation, the room, a half-finished thought - and it depended
 * on an endpointing timer to decide when a sentence had ended, which is a guess
 * the user can simply make instead by closing their fist.
 *
 * Returns { start, stop, isActive } so the gesture layer can drive it.
 */
function mountVoice(viz, log) {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;

    const button = document.querySelector('#voice-button');
    const status = d3.select('#voice-status');

    if (!Ctor) {
        // Chrome and Edge only - Firefox and Safari ship no implementation at
        // all.  Disabling the button and saying why is better than a button
        // that does nothing, and it is exactly the case the conventional
        // fallback controls exist for.
        button.disabled = true;
        button.textContent = 'Voice control unavailable';
        status.text('This browser has no Speech Recognition API. Use the controls '
            + 'above the map — every voice command has a button.');

        const unavailable = () => ({
            ok: false,
            message: 'speech recognition is not supported here'
        });

        return { start: unavailable, stop: unavailable, isActive: () => false };
    }

    const recognition = new Ctor();
    recognition.lang = 'en-US';

    // continuous = true, not false.
    //
    // The obvious setting is the wrong one here, and the failure it produces is
    // subtle: with continuous = false the browser treats the first short pause
    // as the end of the utterance, fires onend, and stops listening.  A command
    // spoken with any hesitation at all - "show ... top ten", or a two-word
    // country name - is then cut off after its first word, and the rest of the
    // phrase is spoken into a recogniser that has already stopped.  The symptom
    // is an interface that only ever hears single words, which is exactly the
    // set of commands that need no interface.  Staying continuous means the
    // window captures the whole command however the speaker pauses inside it.
    recognition.continuous = true;

    // Interim results drive the live feedback line, so the user can see the
    // phrase forming and knows the microphone is live before closing their fist.
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    // `open` is the user's intent, `running` is what the engine is doing.  They
    // differ: the engine ends a run on its own long before the user's fist, and
    // one window can span several engine runs.
    let open = false;
    let running = false;
    let restartTimer = null;
    let windowTimer = null;

    // Non-null between stop() and finish(): the window is closed but the engine
    // has not yet handed over the last of the sentence.  Holds the reason, so
    // finish() can report why the window ended.
    let closing = null;

    // The two timers of a close: the grace period before the engine is stopped,
    // and the backstop in case onend never arrives.  Separate from
    // `restartTimer`, which belongs to the engine's own restarts mid-window.
    let tailTimer = null;
    let flushTimer = null;

    // Text heard in earlier engine runs of this window, and the text of the run
    // in progress.  Both are needed because the engine may restart mid-window,
    // and a restart begins a fresh result list - without `settled` the earlier
    // half of a sentence would vanish when that happened.
    let settled = '';
    let live = '';
    let commandStart = 0;

    function setStatus(text, kind = '') {
        status.attr('class', kind).text(text);
    }

    /** Everything heard so far in this window. */
    function heard() {
        return `${settled} ${live}`.replace(/\s+/g, ' ').trim();
    }

    // start/stop deliberately do not log.  They are called both by the button
    // and by the gesture layer, and a caller that also logs would otherwise
    // produce two entries for one action.
    function start() {
        // `closing` counts as busy: a palm shown while the last command is still
        // being flushed must not open a second window on top of it.
        if (open || closing !== null) {
            return { ok: true, message: 'still processing the last one' };
        }

        open = true;
        settled = '';
        live = '';
        commandStart = 0;

        button.textContent = 'Stop and run';
        button.setAttribute('aria-pressed', 'true');

        listen();

        // The only thing that ends the window is a stop, so a stop that never
        // arrives is the one case that needs a backstop.
        windowTimer = setTimeout(
            () => stop('the recording window hit its 20 second limit'),
            MAX_WINDOW_MS
        );

        setStatus('Recording… say your command, then close your fist.', 'is-listening');

        return { ok: true, message: 'recording — say your command, then close your fist' };
    }

    function listen() {
        if (!open || running) return;

        try {
            recognition.start();
        } catch (error) {
            // start() throws if the engine is already running.  Recoverable, so
            // it must not kill the window.
            console.warn('Lab 10: recognition.start() refused', error);
        }
    }

    /**
     * Close the window: stop capturing, then read the transcript.
     *
     * Three things happen in order, and all three matter.
     *
     * 1. The engine is NOT stopped here.  It keeps running for TAIL_MS, because
     *    stop() ends the audio capture at that instant - and the last word is
     *    still being processed at that instant.  Cutting the engine off the
     *    moment the fist closes is what truncated the end of every command: the
     *    trailing audio had been captured but not yet turned into text, so
     *    "show top ten" came back as "show top ten" minus its last word.  The
     *    grace period lets the engine finish the word it is holding.
     *
     * 2. Then the engine is stopped, and the transcript is still NOT read.
     *    SpeechRecognition delivers its final result *after* stop() returns,
     *    asynchronously - so reading here would miss the flush as well, which is
     *    the bug that made commands come back empty.
     *
     * 3. finish() reads it once onend says the engine has handed everything over.
     */
    function stop(reason = 'stopped') {
        if (!open) return { ok: true, message: 'not recording' };

        open = false;
        closing = reason;

        clearTimeout(windowTimer);
        clearTimeout(restartTimer);
        windowTimer = null;

        button.textContent = 'Processing…';
        button.disabled = true;
        button.setAttribute('aria-pressed', 'false');

        setStatus('Processing what you said…', 'is-loading');

        tailTimer = setTimeout(stopEngine, TAIL_MS);

        return { ok: true, message: 'processing' };
    }

    /** The grace period is over; let the engine flush and hand over. */
    function stopEngine() {
        tailTimer = null;

        try {
            recognition.stop();
        } catch {
            // Already stopped; onend will not fire, so the backstop is what
            // finishes the window.
        }

        // onend is the normal path, but it is not guaranteed - if it never
        // arrives the window would stay stuck on "Processing" forever.
        flushTimer = setTimeout(finish, 1500);
    }

    /** Back to idle: no window, no text, no timers, button live again. */
    function reset() {
        open = false;
        closing = null;
        settled = '';
        live = '';
        commandStart = 0;

        clearTimeout(tailTimer);
        clearTimeout(flushTimer);
        clearTimeout(restartTimer);
        clearTimeout(windowTimer);
        tailTimer = null;
        flushTimer = null;
        restartTimer = null;
        windowTimer = null;

        button.textContent = 'Start voice control';
        button.disabled = false;
        button.setAttribute('aria-pressed', 'false');
    }

    function finish() {
        if (closing === null) return { ok: true, message: 'nothing in progress' };

        const reason = closing;

        // Read before reset() clears it: the point of waiting for the flush was
        // to have this text.
        const transcript = heard();

        reset();

        // finish() is the only place that knows the transcript, so it is the
        // only place that logs the close.  Callers must not log again for it.
        if (!transcript) {
            setStatus(`Nothing heard — ${reason}`, 'is-warn');
            log('voice', '', `nothing heard in the recording window (${reason})`);

            return { ok: true, message: `nothing heard — ${reason}` };
        }

        const result = runVoiceCommand(viz, transcript);

        setStatus(
            result.ok
                ? `Heard: "${transcript}" — ${result.message}`
                : `Heard: "${transcript}" — not recognized`,
            result.ok ? 'is-ok' : 'is-warn'
        );

        if (result.ok) {
            log('voice', `"${transcript}"`, result.message);
        } else {
            log('voice', `"${transcript}"`, `${result.message}. Try: "show top ten", `
                + `"select Japan", "next tier", "reset"`);
        }

        return result;
    }

    recognition.onstart = () => {
        running = true;

        // A fresh result list starts at zero, so anything already heard has to
        // be banked in `settled` before `live` is rebuilt from the new list.
        // Without this, an engine restart halfway through a window - which
        // Chrome does on a long silence - would silently drop the first half of
        // the sentence.
        if (live) settled = `${settled} ${live}`.trim();

        commandStart = 0;
        live = '';

        setStatus(`Recording… ${heard()}`, 'is-listening');
    };

    recognition.onresult = event => {
        // Rebuilt from the result list every time, not accumulated from
        // `resultIndex` as results arrive.
        //
        // A result is reported more than once: Chrome reports it again when an
        // interim result turns final, and its `resultIndex` is only guaranteed
        // to point at the first result that *changed*, so a result that has not
        // changed can still be re-reported.  Accumulating deltas would count
        // that text twice and turn "show top ten" into "show top ten top ten".
        // Rebuilding cannot: the same list always produces the same phrase.
        let text = '';

        for (let i = commandStart; i < event.results.length; i++) {
            text += `${event.results[i][0].transcript} `;
        }

        live = text.replace(/\s+/g, ' ').trim();

        // The flush that arrives after stop() lands here too, and its text has
        // to be collected - that is the whole point of waiting for it.  Only the
        // status line is skipped, because the window is no longer recording and
        // saying "Recording…" while it processes would be a lie.
        if (closing !== null) return;

        // Live feedback only.  Nothing runs until the window closes, so the
        // user can watch the phrase form - and see a mishearing - while there is
        // still time to say it again before closing their fist.
        setStatus(`Recording… ${heard()}`, 'is-listening');
    };

    recognition.onerror = event => {
        // 'no-speech' is the normal end of a quiet moment, not a failure, and
        // reporting it would train the user to ignore the status line.
        if (event.error === 'no-speech' || event.error === 'aborted') return;

        const messages = {
            'not-allowed': 'microphone permission was denied — use the controls below',
            'service-not-allowed': 'the browser blocked speech recognition on this page',
            network: 'the speech service is unreachable — check your connection',
            'audio-capture': 'no microphone was found'
        };

        const reason = messages[event.error] ?? `recognition error: ${event.error}`;

        // Terminal for the window: retrying would either fail identically or,
        // for 'network', spin in a retry loop.  Torn down directly rather than
        // through stop(), because there is no flush worth waiting for here and
        // the pending finish() would overwrite this message with "nothing
        // heard" a moment later.
        reset();
        setStatus(`Voice control unavailable — ${reason}`, 'is-warn');
        log('control', 'Speech recognition', reason);
    };

    recognition.onend = () => {
        running = false;

        // onend after stop() means the engine has flushed its last result, so
        // the transcript is finally complete and the window can be settled.
        if (closing !== null) {
            finish();
            return;
        }

        // Otherwise the engine gave up on its own on a long silence, well before
        // the user's fist.  The window is still open, so reopen the engine -
        // otherwise the second half of a slow sentence lands on a dead
        // microphone.  A small delay, because restarting immediately can trip
        // InvalidStateError.
        if (open) restartTimer = setTimeout(listen, 250);
    };

    button.addEventListener('click', () => {
        // While the engine is flushing, a click must not open a new window on
        // top of the one still finishing.  stop() treats it as a no-op, and the
        // window is closed anyway, so this is just a guard against the second
        // click racing the flush.
        if (open || closing !== null) {
            stop('stopped');
            return;
        }

        log('control', 'Voice control', start().message);
    });

    setStatus('Idle — click Start, or show an open palm on camera.', 'is-idle');

    return { start, stop, isActive: () => open };
}

// ---------------------------------------------------------------------------
// Hand gesture  (Lab10.md Part II)
// ---------------------------------------------------------------------------

// A label must survive this many consecutive frames before it counts.  At the
// ~30fps the camera delivers, 8 frames is about a quarter of a second - long
// enough that a single misclassified frame cannot fire a command, short enough
// that a deliberate gesture does not feel like waiting.
const HOLD_FRAMES = 8;

// Frames of "no hand" or "no gesture" needed before the same gesture can fire
// again.  This is what makes holding a palm open fire once instead of once per
// cooldown window.
const RELEASE_FRAMES = 3;

// Lab10.md Task 10's cooldown, between any two firings whatever the gesture.
const COOLDOWN_MS = 1200;

// Each action takes the whole command context rather than a positional pair,
// because no action uses both halves: the voice ones need only `voice`, the
// tier ones only `viz`.
//
// The palm and the fist bracket a recording window rather than toggling a
// always-listening session: whatever is said between them is one command, and
// it runs when the fist closes.  The microphone is therefore live only between
// two gestures the user deliberately made, which is most of the accuracy gain -
// the recogniser never hears the room, the conversation, or the half-sentence
// the speaker thought better of.
// `announce` is false only for the fist: closing the window runs a command, and
// voice.stop() logs that command with the transcript it acted on.  A gesture
// line repeating the same outcome would be one action written down twice.
const GESTURE_ACTIONS = {
    Open_Palm: { label: 'Open palm', announce: true, run: ({ voice }) => voice.start() },
    Closed_Fist: { label: 'Closed fist', announce: false, run: ({ voice }) => voice.stop('recording ended') },
    Thumb_Up: { label: 'Thumb up', announce: true, run: ({ viz }) => viz.stepTier(1) },
    Thumb_Down: { label: 'Thumb down', announce: true, run: ({ viz }) => viz.stepTier(-1) }
};

function mountGesture(viz, voice, log) {
    const button = document.querySelector('#camera-button');
    const status = d3.select('#camera-status');
    const badge = d3.select('#gesture-badge');
    const video = document.querySelector('#camera');
    const canvas = document.querySelector('#lab10-landmarks');
    const context = canvas.getContext('2d');

    let stream = null;
    let recognizer = null;
    let frame = null;
    let lastVideoTime = -1;

    let candidate = null;
    let candidateFrames = 0;
    let armed = null;

    // -Infinity, not 0: the cooldown is measured from this, and 0 would block
    // the very first gesture if the camera ever came up inside the first
    // COOLDOWN_MS of the page's life (performance.now() is not wall-clock time).
    let lastFireTime = -Infinity;

    const setStatus = (text, kind = '') => status.attr('class', kind).text(text);

    // The frame loop calls this every frame, and writing identical text to the
    // DOM 30 times a second is pure waste - so remember what is already there.
    let badgeText = null;

    function setBadge(text, kind = '') {
        const next = `${text}\u0000${kind}`;
        if (next === badgeText) return;

        badgeText = next;
        badge.attr('class', `gesture-badge ${kind}`).text(text);
    }

    /**
     * Build the recogniser once, and only when the camera is actually asked
     * for: it pulls an 8 MB model, which is not a cost to impose on a reader who
     * only wants the maps.
     */
    async function ensureRecognizer() {
        if (recognizer) return recognizer;

        const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);

        const options = delegate => ({
            baseOptions: { modelAssetPath: MODEL_PATH, delegate },
            runningMode: 'VIDEO',
            numHands: 1
        });

        try {
            recognizer = await GestureRecognizer.createFromOptions(fileset, options('GPU'));
        } catch (error) {
            // WebGL is unavailable in some contexts (software rendering, a
            // locked-down GPU).  The CPU delegate is slower but works, and
            // without this fallback the whole modality would be dead there.
            console.warn('Lab 10: GPU delegate unavailable, falling back to CPU', error);
            recognizer = await GestureRecognizer.createFromOptions(fileset, options('CPU'));
        }

        return recognizer;
    }

    function drawLandmarks(landmarks) {
        context.clearRect(0, 0, canvas.width, canvas.height);

        if (!landmarks?.length) return;

        const { width, height } = canvas;

        context.strokeStyle = '#f2f2f2';
        context.lineWidth = Math.max(2, width / 320);

        for (const { start, end } of GestureRecognizer.HAND_CONNECTIONS) {
            const a = landmarks[start];
            const b = landmarks[end];

            context.beginPath();
            context.moveTo(a.x * width, a.y * height);
            context.lineTo(b.x * width, b.y * height);
            context.stroke();
        }

        context.fillStyle = '#2a78d6';

        for (const point of landmarks) {
            context.beginPath();
            context.arc(point.x * width, point.y * height, Math.max(3, width / 200), 0, 2 * Math.PI);
            context.fill();
        }
    }

    /** The hand's strongest gesture this frame, or null if there is none. */
    function topGesture(result) {
        const hand = result.gestures?.[0];
        if (!hand?.length) return null;

        const best = hand.reduce((a, b) => (b.score > a.score ? b : a));

        // The classifier's own "no gesture" class.  Treated as neutral, which
        // is what re-arms the vocabulary.
        if (best.categoryName === 'None') return null;

        return best;
    }

    /**
     * Stability, then release, then cooldown - in that order.
     *
     * Lab10.md Task 10 asks for a cooldown, and a cooldown alone is not enough:
     * it stops a gesture repeating *within* the window but still fires on the
     * first frame of a misclassification, and a held gesture fires again the
     * instant the window expires.  Requiring the label to be stable removes the
     * first problem, and requiring the hand to return to neutral removes the
     * second.
     */
    function onGesture(label, score) {
        if (label === candidate) candidateFrames++;
        else {
            candidate = label;
            candidateFrames = 1;
        }

        if (label === null) {
            if (candidateFrames >= RELEASE_FRAMES) armed = null;
            return;
        }

        if (candidateFrames < HOLD_FRAMES) return;
        if (label === armed) return;

        const now = performance.now();
        if (now - lastFireTime < COOLDOWN_MS) return;

        lastFireTime = now;
        armed = label;

        const action = GESTURE_ACTIONS[label];

        if (!action) {
            // A gesture the recogniser knows but this vocabulary does not use.
            // Reported rather than ignored, so the user is not left wondering
            // whether the camera saw them.
            setBadge(`${label} — not mapped to an action`, 'is-warn');
            return;
        }

        // Confidence is shown to the user because it is the most honest
        // explanation of a wrong action: a command fired at 0.55 was a guess.
        setBadge(`${action.label} (${score.toFixed(2)})`, 'is-detected');

        const result = action.run({ viz, voice });

        if (action.announce && result?.message) {
            log('gesture', action.label, result.message);
        }
    }

    function loop() {
        frame = requestAnimationFrame(loop);

        // readyState < 2 means no frame decoded yet, and recognizeForVideo
        // throws rather than returning empty on a video with no data.
        if (!recognizer || video.readyState < 2) return;

        // The camera runs at its own rate; processing the same frame twice just
        // burns CPU and inflates the frame counters the stability check uses.
        if (video.currentTime === lastVideoTime) return;
        lastVideoTime = video.currentTime;

        try {
            const result = recognizer.recognizeForVideo(video, performance.now());
            const best = topGesture(result);

            drawLandmarks(result.landmarks?.[0]);

            if (best) {
                onGesture(best.categoryName, best.score);
            } else {
                onGesture(null, 0);
                setBadge('No gesture', 'is-idle');
            }
        } catch (error) {
            console.error('Lab 10: gesture frame failed', error);
            stopCamera('the gesture recogniser stopped responding');
        }
    }

    function stopCamera(reason = 'camera off') {
        if (frame) cancelAnimationFrame(frame);
        frame = null;
        lastVideoTime = -1;

        candidate = null;
        candidateFrames = 0;
        armed = null;

        // Releasing the tracks is the part that actually turns the camera light
        // off; dropping the reference alone leaves it recording.
        stream?.getTracks().forEach(track => track.stop());
        stream = null;
        video.srcObject = null;

        context.clearRect(0, 0, canvas.width, canvas.height);
        button.textContent = 'Start camera';

        setBadge('Camera off', 'is-idle');
        setStatus(`Camera off — ${reason}`, 'is-idle');
    }

    async function startCamera() {
        button.disabled = true;
        setStatus('Loading gesture model (~8 MB, first time only)…', 'is-loading');

        try {
            await ensureRecognizer();

            stream = await navigator.mediaDevices.getUserMedia({
                video: { width: 640, height: 480, facingMode: 'user' }
            });

            video.srcObject = stream;
            await video.play();

            canvas.width = video.videoWidth || 640;
            canvas.height = video.videoHeight || 480;

            button.textContent = 'Stop camera';
            setStatus('Camera on — hold a gesture for a moment. Open palm starts listening.', 'is-ok');
            setBadge('No gesture', 'is-idle');

            loop();
        } catch (error) {
            // Separated because the two failures need different advice: one is
            // a permission the user can grant, the other is the network.
            const denied = error?.name === 'NotAllowedError' || error?.name === 'NotFoundError';

            console.error('Lab 10: camera failed', error);

            stopCamera(denied
                ? 'camera permission was denied or no camera was found'
                : `the gesture model could not be loaded (${error?.message ?? error})`);
        } finally {
            button.disabled = false;
        }
    }

    button.addEventListener('click', () => {
        if (stream) stopCamera('stopped');
        else startCamera();
    });

    setBadge('Camera off', 'is-idle');
    setStatus('Camera off — gestures need an explicit click to start.', 'is-idle');
}

// ---------------------------------------------------------------------------
// Conventional controls  (Lab10.md Part C)
//
// Every action a modality can perform is reachable here, because recognition
// fails: speech needs Chrome and a network round trip, and the camera needs a
// permission the user may refuse.  The page has to stay fully usable anyway.
// ---------------------------------------------------------------------------

/**
 * The details panel: what the map is showing, written out.
 *
 * This exists because every modality added in this lab selects a country or a
 * set of countries without a pointer, and a pointer is exactly what the tooltip
 * needs.  A voice command can pin Japan but cannot hover it, so without this the
 * one thing the reader most wants after saying "show top ten" - which ten? - is
 * the one thing the page cannot tell them.
 */
function mountDetails(viz) {
    const body = d3.select('#lab10-details-body');

    const fmt = d3.format(',.0f');

    function render() {
        const { selected, heading, rows } = viz.snapshot();

        body.selectAll('*').remove();

        if (!selected && !heading) {
            body.append('p')
                .attr('class', 'details-empty')
                .text('Nothing selected. Click a country, say "select Japan", or '
                    + 'filter with the controls above.');

            return;
        }

        if (selected) {
            const card = body.append('div').attr('class', 'details-card');

            card.append('div').attr('class', 'details-name').text(selected.name);

            const facts = card.append('dl').attr('class', 'details-facts');

            const add = (term, value) => {
                facts.append('dt').text(term);
                facts.append('dd').text(value);
            };

            add('2025 GDP', selected.gdp == null
                ? 'not in the top 50'
                : `$${fmt(selected.gdp)}B`);
            add('Rank', selected.rank == null ? '—' : `${selected.rank} of 50`);
            add('Class', selected.classLabel ?? 'no data');
        }

        if (heading) {
            body.append('div')
                .attr('class', 'details-heading')
                .text(`${heading} (${rows.length})`);

            // A scroll box rather than a fixed list: "top 50" is a legitimate
            // command and an unconstrained list would push the action log off
            // the bottom of the column.
            const list = body.append('div').attr('class', 'details-list');

            for (const row of rows) {
                const item = list.append('div').attr('class', 'details-row');

                item.append('span').attr('class', 'details-rank').text(row.rank);
                item.append('span').attr('class', 'details-country').text(row.country);
                item.append('span').attr('class', 'details-gdp').text(`$${fmt(row.gdp)}B`);
            }
        }
    }

    viz.onChange(render);
}

function mountFallbacks(viz, log) {
    const controls = d3.select('#controls');

    const run = (source, description, result) => {
        log(source, description, result.message);
    };

    // --- selection ---------------------------------------------------------

    const selectRow = controls.append('div').attr('class', 'controls-row');

    selectRow.append('label')
        .attr('for', 'lab10-country')
        .text('Country');

    const countrySelect = selectRow.append('select')
        .attr('id', 'lab10-country');

    countrySelect.append('option')
        .attr('value', '')
        .text('— choose one of the top 50 —');

    for (const row of viz.gdpRows) {
        countrySelect.append('option')
            .attr('value', row.iso3)
            .text(`${row.rank}. ${row.country}`);
    }

    selectRow.append('button')
        .attr('type', 'button')
        .text('Select')
        .on('click', () => {
            const iso = countrySelect.property('value');
            if (!iso) return;

            // selectById, not selectByName: the dropdown holds exact ISO codes,
            // and routing them through the spoken-name matcher would be asking
            // a fuzzy resolver a question that has a precise answer.
            const result = viz.selectById(iso);
            const label = countrySelect.property('selectedOptions')[0].text;

            run('control', `Select ${label}`, result);
        });

    selectRow.append('button')
        .attr('type', 'button')
        .text('Clear selection')
        .on('click', () => run('control', 'Clear selection', viz.clearSelection()));

    selectRow.append('button')
        .attr('type', 'button')
        .text('Reset')
        .on('click', () => run('control', 'Reset', viz.resetAll()));

    // --- filter ------------------------------------------------------------

    const filterRow = controls.append('div').attr('class', 'controls-row');

    // One dropdown rather than a pair of step buttons plus a clear button.  It
    // is a single control for three jobs - pick a class, move to the next one,
    // and get back to everything - and "All classes" is the clear, which is why
    // there is no separate one.  It also keeps Thumb up/down's conventional
    // fallback alive, which a bare removal would not have.
    filterRow.append('label')
        .attr('for', 'lab10-class')
        .text('GDP class');

    const classSelect = filterRow.append('select')
        .attr('id', 'lab10-class');

    classSelect.append('option').attr('value', '').text('All classes');

    viz.classLabels.forEach((label, index) => {
        classSelect.append('option').attr('value', index).text(label);
    });

    classSelect.on('change', function () {
        const value = this.value;

        if (value === '') {
            run('control', 'All classes', viz.clearFilter());
            return;
        }

        const index = Number(value);
        run('control', `Class ${viz.classLabels[index]}`, viz.setTierIndex(index));
    });

    // Follow the map, rather than only leading it.  Thumb up/down and "next
    // tier" change the class without the dropdown being touched, and a control
    // that then disagrees with the map about which class is showing is worse
    // than no control at all.  Setting .value does not fire 'change', so this
    // cannot loop back into the handler above.
    viz.onChange(() => {
        const { filter } = viz.snapshot();
        const next = filter?.kind === 'tier' ? String(filter.index) : '';

        if (classSelect.property('value') !== next) {
            classSelect.property('value', next);
        }
    });

    filterRow.append('label')
        .attr('for', 'lab10-topk')
        .text('Top');

    filterRow.append('input')
        .attr('type', 'number')
        .attr('id', 'lab10-topk')
        .attr('min', 1)
        .attr('max', viz.gdpRows.length)
        .attr('value', 10);

    filterRow.append('button')
        .attr('type', 'button')
        .text('Apply')
        .on('click', () => {
            const k = Number(document.querySelector('#lab10-topk').value);

            if (!Number.isFinite(k)) return;

            run('control', `Top ${k}`, viz.setTopK(k));
        });

    // The keyboard equivalent of the gesture vocabulary.  Arrows step the same
    // GDP classes, so the gesture modality can be demonstrated without a camera.
    d3.select(window).on('keydown.lab10', event => {
        // Escape works everywhere, including mid-typing, because "get me out of
        // this" should never be swallowed by a focused input.
        if (event.key === 'Escape') {
            run('control', 'Escape', viz.resetAll());
            return;
        }

        const tag = event.target?.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

        if (event.key === 'ArrowRight') run('control', 'ArrowRight', viz.stepTier(1));
        if (event.key === 'ArrowLeft') run('control', 'ArrowLeft', viz.stepTier(-1));
    });

}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// A .then rather than top-level await: the build target does not guarantee it,
// and the map is the only thing this page needs to draw.
draw()
    .then(viz => {
        const log = mountLog();

        // Voice before gesture: the gesture vocabulary includes starting and
        // stopping the listening session, so the gesture layer needs the voice
        // layer's controls to exist first.
        const voice = mountVoice(viz, log);

        mountGesture(viz, voice, log);

        mountFallbacks(viz, log);

        // Subscribes to the map rather than polling it, so the panel follows a
        // click, a spoken command and a gesture alike.
        mountDetails(viz);
    })
    .catch(error => {
        console.error('Lab 10: the maps failed to draw', error);

        d3.select('#choropleth')
            .append('p')
            .attr('class', 'caption')
            .text('The maps could not be drawn — see the console.');
    });
