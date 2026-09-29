// Lab 9 - Geospatial visualization of 2025 nominal GDP.
//
// Both maps are drawn from a single join: the 50 rows of
// lab9_gdp_2025_top50.csv attached to the 258 country features in the world
// topology.  That join is Part A of the assignment, so it lives here on its own
// rather than being inlined into either draw.
//
// Two things about the provided files make it less trivial than a Map lookup,
// and both are handled below:
//
//   1. The topology does not store its identifier under `iso3`.  The key is the
//      Natural Earth spelling, `ISO3166-1-Alpha-3`.
//
//   2. That key is "-99" for 22 features - Natural Earth's sentinel for
//      territory it assigns no ISO code to.  France and Norway are among them
//      and both are in the top 50, so a plain ISO join would silently drop the
//      world's 7th-largest economy and paint it "no data".  Those two are
//      recovered by country name.
//
// A country that is simply not in the top 50 is a third case again, and must
// read as missing data rather than as zero, so every feature ends up with a
// number or an explicit null.
//
// Geometry note: the maps read public/data/countries.topo.json (454 KB), not
// the 14 MB data/countries.geojson it is built from.  Run `npm run
// build:lab9-topo` to regenerate it; scripts/build-lab9-topo.mjs explains why
// the simplification is necessary and where it can go wrong.
//
// Both maps share one projection and one topology on purpose.  Part D asks the
// reader to recognise the same country in two very different shapes, so the two
// panels have to agree on where things are.

import * as d3 from 'd3';
import { feature as topoFeature } from 'topojson-client';
import { cartogram } from 'topogram';
import { mountNav } from './nav.js';
import '../styles/main.css';

mountNav('#nav');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// import.meta.env.BASE_URL, not a page-relative path: these files live in
// public/data/, which is served from the site root under both the dev server
// and GitHub Pages.
const TOPO_URL = `${import.meta.env.BASE_URL}data/countries.topo.json`;
const GDP_URL = `${import.meta.env.BASE_URL}data/lab9_gdp_2025_top50.csv`;

const GEO_ISO_KEY = 'ISO3166-1-Alpha-3';
const ISO_SENTINEL = '-99';

const MAP_W = 920;
const MAP_H = 430;

// Space reserved above the map for the encoding caption, and the inset that
// keeps the projection off the frame edges.
const MAP_TOP = 30;
const MAP_INSET = 8;

// Antarctica is dropped from the drawing (though not from the join, so the
// match report still describes all 258 features).  It carries no GDP, has no
// permanent economy, and at latitude -90 it would claim the bottom fifth of the
// frame to show nothing.
const EXCLUDED = new Set(['Antarctica']);

// 40 iterations is where Dougenik's algorithm stops earning its keep on this
// data: measured against the 50 outcomes, mean area error is 0.0012 here versus
// 0.0010 at 100 iterations, but it computes in 0.9s instead of 2.2s.  See the
// verification note in the plan if this ever needs re-tuning.
const CARTOGRAM_ITERATIONS = 40;

// The cartogram's area ruler, in billions USD.  Several values rather than one
// so the row spans the same range as the colour ramp's breaks, letting a reader
// place a country between two known quantities instead of only above or below
// one.
const REF_GDP_VALUES = [500, 2000, 5000, 10000];
const REF_GAP = 16;

// Advance per character at the 11px the labels are actually styled at.  This
// has to track .area-reference-label in main.css: SVG text cannot be measured
// before layout, so the row is spaced from this estimate, and underestimating
// it makes neighbouring labels collide.
const REF_CHAR_W = 6.2;

// Log-spaced breaks, but applied as a plain threshold scale.  The values span
// two orders of magnitude ($300B to $30.6T), so equal-width bins would put 46
// of the 50 countries in the first class and say nothing; the bins are chosen
// on a log progression but the scale itself needs no log transform, and the
// legend falls straight out of the boundaries.
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

const fmtGdp = d3.format(',.0f');

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** ISO-3 code for a feature's properties, or null when Natural Earth left it
 *  unassigned.  The sentinel has to be read as null rather than as a code,
 *  otherwise all 22 of those features would share one bogus key. */
function isoOfProps(props) {
    const raw = props[GEO_ISO_KEY];

    if (raw == null || String(raw).trim() === ISO_SENTINEL) return null;

    return String(raw).trim();
}

function isoOf(feature) {
    return isoOfProps(feature.properties);
}

/**
 * Lowercase alphanumerics only, so that accents and punctuation do not decide
 * a match.  Used only for the name fallback below.
 */
function normalizeName(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

/**
 * Stable identity for a country, for linked highlighting (Part D).
 *
 * Deliberately different from keyOf(): this answers "is this the same country
 * on both maps?", which must hold for all 258 features including the ones with
 * no ISO code and no GDP.  The `name:` prefix keeps a name-derived id from ever
 * colliding with a real ISO code.
 */
function idOf(props) {
    return isoOfProps(props) ?? `name:${normalizeName(props.name)}`;
}

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

/**
 * Attach GDP to `features` in place, on `feature.properties`.
 *
 * Each feature gains:
 *   gdp        2025 nominal GDP in billions USD, or null when not in the top 50
 *   rank       GDP rank, or null
 *   gdpCountry the dataset's own label for the economy, or null.  Kept
 *              alongside `name` because the two disagree for some entries
 *              ("Korea, Republic of" vs "South Korea") and a tooltip may want
 *              either.
 *
 * Mutating `properties` is deliberate: d3 binds the feature itself to each
 * `path`, so the value a draw needs is already on the bound datum.
 *
 * Returns a report describing exactly how each row was matched, which is what
 * the assignment asks you to check.
 */
function joinGDP(features, gdpRows) {
    const byIso = new Map(gdpRows.map(d => [d.iso3, d]));

    // Name is a fallback, never the primary key: the dataset label for several
    // countries does not match the GeoJSON label at all ("Russian Federation",
    // "Türkiye"), so a name-first join would lose far more than it recovers.
    // Collisions are recorded rather than silently resolved, so a later row can
    // never quietly overwrite an earlier one.
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

        // A blank or unparseable figure is missing data, not a zero.
        const gdp = row && Number.isFinite(row.gdp) ? row.gdp : null;

        feature.properties.gdp = gdp;
        feature.properties.rank = row && gdp !== null ? row.rank : null;
        feature.properties.gdpCountry = row && gdp !== null ? row.country : null;

        if (iso === null) report.noIsoCode.push(feature.properties.name);

        if (!row) continue;

        // Two features resolving to one row would mean a duplicated polygon,
        // and one of them would be coloured by a figure that is not its own.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

    // The topology is decoded once, here, and both maps are drawn from the
    // resulting features.  Everything downstream treats them as an ordinary
    // GeoJSON FeatureCollection.
    const features = topoFeature(topo, topo.objects.countries).features;

    const report = joinGDP(features, gdpRows);

    return { topo, features, gdpRows, report };
}

/**
 * Print the match report.  Part A asks you to check that the identifiers line
 * up; this is that check, and it is meant to be read rather than skimmed.
 */
function logReport(report) {
    const list = rows => rows.map(d => d.iso3).join(', ') || 'none';

    console.group('Lab 9 - GDP / topology join');

    console.log(`GeoJSON features        ${report.featureCount}`);
    console.log(`GDP rows                ${report.rowCount}`);
    console.log(`matched by ISO-3        ${report.matchedByIso.length}`);
    console.log(`matched by name         ${report.matchedByName.length}`);
    console.log(`  ${list(report.matchedByName)}`);
    console.log(`GDP rows with no feature ${report.unmatchedRows.length}`);
    console.log(`  ${list(report.unmatchedRows)}`);
    console.log(`features with no ISO-3  ${report.noIsoCode.length}  (shown as no data)`);
    console.log(`key collisions          ${report.collisions.length}`);

    if (report.unmatchedRows.length) {
        console.warn(
            'GDP rows with no matching country - these would be invisible on both maps:',
            report.unmatchedRows
        );
    }

    if (report.collisions.length) {
        console.warn('Identifier collisions:', report.collisions);
    }

    console.groupEnd();
}

// ---------------------------------------------------------------------------
// Draw
// ---------------------------------------------------------------------------

async function draw() {
    const { topo, features, gdpRows, report } = await loadData();

    logReport(report);

    const renderFeatures = features.filter(f => !EXCLUDED.has(f.properties.name));

    // -----------------------------------------------------------------------
    // GDP lookup
    // -----------------------------------------------------------------------

    const rowByIso = new Map(gdpRows.map(d => [d.iso3, d]));
    const rowByName = new Map(gdpRows.map(d => [normalizeName(d.country), d]));

    /**
     * The dataset row a feature belongs to, or null.  Mirrors joinGDP's
     * resolution order - ISO first, name only as a fallback - so a country can
     * never be matched one way on the map and another way in the report.
     *
     * This exists because the cartogram is fed bare topology geometries, which
     * carry only the raw Natural Earth properties.  They never pass through
     * joinGDP, so they need their own way back to the data.
     */
    function keyOf(props) {
        const iso = isoOfProps(props);

        if (iso && rowByIso.has(iso)) return iso;

        const row = rowByName.get(normalizeName(props.name));

        return row ? row.iso3 : null;
    }

    // -----------------------------------------------------------------------
    // Scales and projection
    // -----------------------------------------------------------------------

    const colorScale = d3.scaleThreshold()
        .domain(GDP_BREAKS)
        // Started at 0.35 rather than 0 so the lightest class stays clearly
        // blue against the warm grey of NO_DATA - at the far end of the ramp
        // the two are nearly the same lightness and the map stops being
        // readable.
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
    // Linked highlight state (Part D)
    //
    // One record of ids, and one function that writes every visual property
    // that depends on it.  Both maps read the same state, which is what makes
    // the highlight linked; neither map writes styles anywhere else, so the two
    // can never disagree about what is selected.
    // -----------------------------------------------------------------------

    const state = { hovered: null, selected: null };

    const isHot = props => {
        const id = idOf(props);
        return id === state.hovered || id === state.selected;
    };

    // Dimming is tied to the pinned selection rather than to hover: dimming on
    // hover makes the whole map flicker as the pointer crosses it, and on the
    // cartogram - where grown countries overlap their neighbours - it is not
    // obvious which shape is answering the mouse.
    const opacityOf = props => {
        if (!state.selected) return 1;
        return idOf(props) === state.selected ? 1 : 0.28;
    };

    // Declared here, not with the cartogram below, because updateStyles writes
    // to it and is first bound to events before the cartogram exists.
    let cgCountries = null;

    // -----------------------------------------------------------------------
    // Part B - choropleth
    // -----------------------------------------------------------------------

    const svg = d3.select('#choropleth')
        .append('svg')
        .attr('width', MAP_W)
        .attr('height', MAP_H);

    // Document order is z-order.  The map layer holds only the countries, so
    // the zoom transform applies to them and their borders together; the
    // caption sits outside it so it does not scale with the map.
    const mapLayer = svg.append('g').attr('class', 'map-layer');

    const countries = mapLayer.selectAll('.country')
        .data(renderFeatures)
        .join('path')
        .attr('class', 'country')
        .attr('d', path)
        .attr('fill', d => fillOf(d.properties));

    // -----------------------------------------------------------------------
    // Part C - cartogram
    //
    // Countries with GDP, and only those.  topogram sizes each shape by
    // `totalArea * value / totalValue`, so a country passed in with a null
    // value would contribute 0 to the total and demand an area of 0 - which
    // makes its size error infinite, drives the whole step size to zero, and
    // freezes every shape including the ones with real data.
    // -----------------------------------------------------------------------

    const gdpFeatures = renderFeatures.filter(f => f.properties.gdp != null);

    // A feature with no projected area gives path.centroid() a [NaN, NaN], and
    // topogram sums one force per feature onto every point - so one degenerate
    // shape would turn all 50 countries' coordinates into NaN in a single pass
    // and the map would render as nothing at all.
    //
    // The build script keeps this from happening (see MIN_ARC_POINTS in
    // scripts/build-lab9-topo.mjs), so this filter should never drop anything.
    // It is here because the failure mode is silent and total: better a country
    // missing with a loud warning than a blank map with no explanation.
    const cartogramInput = gdpFeatures.filter(f => path.area(f) > 0);

    if (cartogramInput.length !== gdpFeatures.length) {
        console.warn(
            'Lab 9: these GDP countries have no projected area and are omitted ' +
            'from the cartogram (regenerate the topology?):',
            gdpFeatures.filter(f => path.area(f) === 0).map(f => f.properties.name)
        );
    }

    const cartogramKeys = new Set(cartogramInput.map(f => keyOf(f.properties)));

    // The topology's own geometries, not the decoded features: topogram works
    // on shared arcs, which is what lets it move a border once instead of
    // tearing it into two independently-moving copies.
    const cartogramGeometries = topo.objects.countries.geometries
        .filter(g => cartogramKeys.has(keyOf(g.properties)));

    const cgSvg = d3.select('#cartogram')
        .append('svg')
        .attr('width', MAP_W)
        .attr('height', MAP_H);

    // The undistorted world, faint, underneath.  A cartogram moves countries
    // away from where they actually are, so without this the reader has no way
    // to tell what grew and what merely moved.
    cgSvg.append('g')
        .attr('class', 'cartogram-context')
        .selectAll('path')
        .data(renderFeatures)
        .join('path')
        .attr('d', path)
        .attr('fill', CONTEXT_FILL)
        .attr('stroke', 'none');

    // The backdrop is scenery, not data - it must not answer the mouse, or a
    // hover near any border would fall through to a country that is not the one
    // under the pointer.
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

            // Raise the hot shape so its outline is never buried under a
            // neighbour - on the cartogram, growth pushes countries over each
            // other and the selected one is often the one underneath.
            selection.filter(d => isHot(d.properties)).raise();
        }
    }

    function setHovered(props) {
        state.hovered = props ? idOf(props) : null;
        updateStyles();
    }

    function toggleSelected(props) {
        const id = idOf(props);
        state.selected = state.selected === id ? null : id;
        updateStyles();
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
    // Zoom (choropleth only)
    //
    // Not shared with the cartogram: that map's geometry is distorted, so the
    // same transform would land on a different place in each panel and the two
    // would stop corresponding - which is the one thing Part D relies on.
    // -----------------------------------------------------------------------

    const zoom = d3.zoom()
        .scaleExtent([1, 8])
        .on('zoom', event => mapLayer.attr('transform', event.transform));

    svg.call(zoom);

    // Clicking the ocean clears a pinned selection.  Country clicks stop
    // propagation, so this only fires on the background of either map.
    function clearSelection() {
        state.selected = null;
        updateStyles();
    }

    svg.on('click', clearSelection);
    cgSvg.on('click', clearSelection);

    const controls = d3.select('#controls');

    controls.append('button')
        .attr('type', 'button')
        .text('Reset zoom')
        .on('click', () => {
            svg.transition().duration(450).call(zoom.transform, d3.zoomIdentity);
        });

    // Pinning a country dims the other 49 on both maps; without this the only
    // way back is to click the exact patch of ocean the reader clicked last.
    controls.append('button')
        .attr('type', 'button')
        .text('Reset selection')
        .on('click', clearSelection);

    d3.select(window).on('keydown.lab9', event => {
        if (event.key !== 'Escape') return;
        state.selected = null;
        updateStyles();
    });

    // -----------------------------------------------------------------------
    // Legend
    // -----------------------------------------------------------------------

    // Laid out horizontally under the map rather than beside it.  The page is
    // 1000px wide and the map takes 920 of them, so a side legend gets pushed
    // off the right edge and its labels are cut off mid-word - which is worse
    // than no legend, because the reader cannot tell what is missing.
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
            noData: false
        })),
        // The qualitative entry reads as a further step in the ramp unless it is
        // set apart, so it is last, dashed, and labelled in full.
        { label: 'not in top 50', fill: NO_DATA, noData: true }
    ];

    // SVG text has no measurable advance before layout, so widths are estimated
    // from the character count - the same approach lab7's legend uses.  Being a
    // few pixels out only changes the spacing, never the reading order.
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
    //
    // Deferred by a frame so the choropleth paints first.  The algorithm is a
    // tight synchronous loop over ~50k points x 50 countries; at 40 iterations
    // that is roughly a second of blocked main thread, and without this the
    // page would sit blank for it.
    // -----------------------------------------------------------------------

    const status = d3.select('#cartogram')
        .insert('p', 'svg')
        .attr('class', 'caption')
        .text('Computing cartogram…');

    function drawCartogram() {
        const value = cartogram()
            .projection(projection)
            // topogram calls this per geometry to decide what a shape's
            // properties are.  Spread the topology's own properties, then
            // overlay the dataset fields, so the result is indistinguishable
            // from a joined feature and idOf()/fillOf() work on it unchanged.
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

        // Null projection: topogram returns coordinates already in screen
        // space, matching its own internal cartogram.path.  Projecting them a
        // second time would put the map somewhere else entirely.
        const plainPath = d3.geoPath();

        cgCountries = cgLayer.selectAll('.cartogram-country')
            .data(distorted)
            .join('path')
            .attr('class', 'cartogram-country')
            .attr('d', plainPath)
            .attr('fill', CARTOGRAM_FILL);

        bindInteraction(cgCountries);
        updateStyles();
        status.remove();

        // -------------------------------------------------------------------
        // Area references
        //
        // The one thing a cartogram cannot do on its own is tell you how big
        // anything is.  Squares of known value give the reader a ruler: each
        // one's area is the same fraction of the drawn total that its value is
        // of the drawn GDP, so a country can be held against them.
        // -------------------------------------------------------------------

        const drawnArea = d3.sum(distorted, f => plainPath.area(f));
        const totalGdp = d3.sum(gdpRows, d => d.gdp);

        const refs = REF_GDP_VALUES.map(value => {
            const side = Math.sqrt(drawnArea * (value / totalGdp));
            const label = `$${fmtGdp(value)}B`;

            return {
                side,
                label,
                // The 500B square is narrower than its own label, so the row has
                // to advance by whichever is wider or the labels collide.
                width: Math.max(side, label.length * REF_CHAR_W)
            };
        });

        const rowW = d3.sum(refs, r => r.width) + REF_GAP * (refs.length - 1);

        // Labels sit on one line BELOW the squares.  Under each square's own
        // base, they would stagger with the square heights and read as belonging
        // to different things; on a shared line they read as one scale.
        const maxSide = d3.max(refs, r => r.side);
        const labelY = MAP_H - MAP_INSET - 9;
        const rowBottom = labelY - 15;
        const rowTop = rowBottom - maxSide;

        const ref = cgSvg.append('g').attr('class', 'area-reference');

        // A plate behind the row, so the ruler stays readable wherever the
        // distorted shapes happen to reach.
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

        // Bases aligned on a common line, so the row reads as a progression of
        // areas rather than four unrelated boxes.
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

    // One frame, so the choropleth above is on screen before the loop starts.
    requestAnimationFrame(() => {
        try {
            drawCartogram();
        } catch (error) {
            status.text('The cartogram could not be computed — see the console.');
            console.error('Lab 9: cartogram failed', error);
        }
    });
}

draw();
