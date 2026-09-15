// Lab 6 placeholder.

import { mountNav } from './nav.js';
import '../styles/main.css';

import * as d3 from 'd3';

mountNav('#nav');

async function draw(){
    const data = await d3.json(
        "../data/lab6_gdp_hierarchy.json"
    )

    // Create hierarchy
    const root = d3.hierarchy(data);

    // Sum the GDP. Only leaf nodes carry `values`; internal nodes have
    // just `name` + `children`, so the accessor must tolerate both.
    root.sum(d => d.values?.gdp_billion_usd ?? 0)
        .sort((a, b) => b.value - a.value)
    const root2 = root.copy(); // Get a copy for the root for different layout

    // Create layout
    const treemapWidth = 1000;
    const treemapHeight = 800;

    const treemapLayout = 
        d3.treemap()
        .size([treemapWidth, treemapHeight])
        .paddingInner(2)
        .paddingOuter(4);

    // `d3.treemapSliceDice` is a *tiling function*, not a layout factory
    // like `d3.treemap()`. It must be handed to `.tile()`; calling it
    // directly runs it with no node and throws on `parent.depth`.
    const treemapLayoutSliceDice =
        d3.treemap()
        .tile(d3.treemapBinary)
        .size([treemapWidth, treemapHeight])
        .paddingInner(2)
        .paddingOuter(4);

    treemapLayout(root);
    treemapLayoutSliceDice(root2);
    
    // Colors: one categorical hue per continent. `getContinent` walks up
    // from a leaf (depth 3: country) to its continent (depth 1).
    function getContinent(d) {
        let current = d;
        while (
            current.depth > 1
        ) {
            current = current.parent;
        }
        return current.data.name;
    }

    const leaves = root.leaves();
    const leaves2 = root2.leaves();

    // Build the domain from the exact values the fill accessor will
    // produce, so the scale can never be missing a continent. Sorted, so a
    // continent's colour follows the continent itself rather than the rank
    // of whichever country inside it happens to be largest.
    const continents = Array.from(
        new Set(leaves.map(getContinent))
    ).sort();

    // ---------- CONFIG (edit these to retune the chart) ----------

    // Validated categorical palette, in fixed order. Slots 1 (blue) and 8
    // (red) are RESERVED for the trend channel below, so continents take
    // the contiguous run 2-7. Reserving the hues that carry meaning is the
    // palette's own collision rule; keeping the run contiguous keeps every
    // adjacent pair on the already-validated colour-vision gate.
    const CATEGORICAL = [
        "#2a78d6", // 1 blue     reserved for "Increase"
        "#eb6834", // 2 orange
        "#1baf7a", // 3 aqua
        "#eda100", // 4 yellow
        "#e87ba4", // 5 magenta
        "#008300", // 6 green
        "#4a3aa7", // 7 violet
        "#e34948", // 8 red      reserved for "Decrease"
    ];
    const CONTINENT_COLORS = CATEGORICAL.slice(1, 7);

    // Trend is a DIVERGING encoding (polarity around a baseline), not a
    // categorical one: two poles plus a neutral midpoint. "Unchanged" uses
    // muted ink rather than a paler grey because the glyph is a mark
    // sitting on a saturated fill, where a light midtone disappears.
    const TREND_COLORS = {
        Increase: "#2a78d6",
        Unchanged: "#898781",
        Decrease: "#e34948",
    };

    // One ink for every label, whatever the continent. The white halo below
    // carries that ink over the dark fills, so a single rule beats picking a
    // text colour per continent.
    const LABEL_INK = "#0b0b0b";
    const HALO = "#ffffff";
    const HALO_W = 3;

    // Responsive thresholds. Both treemaps are a fixed size, so every cell
    // box is known at render time and no measuring pass is needed.
    const MAX_FS = 20;    // px: largest country label
    const MIN_FS = 9;     // px: below this, the label is hidden
    const MIN_GLYPH = 18; // px: smallest cell edge that still shows a glyph

    // Must be defined before the rects below: d3 calls `.attr("fill", fn)`
    // immediately, so a later `const` would be a TDZ ReferenceError.
    const colorScale =
        d3.scaleOrdinal()
        .domain(continents)
        .range(CONTINENT_COLORS);

    const cellW = d => d.x1 - d.x0;
    const cellH = d => d.y1 - d.y0;
    const trendOf = d => d.data.values.gdp_status;

    // The glyph outlives the label: it carries the encoding this chart is
    // for, so it is the last thing to disappear.
    const glyphShown = d => Math.min(cellW(d), cellH(d)) >= MIN_GLYPH;
    const glyphSize = d =>
        Math.max(8, Math.min(16, Math.min(cellW(d), cellH(d)) * 0.42));

    // Label size is limited by BOTH axes, not by area. The layout produces
    // slivers -- Colombia is 14px wide, Kenya 10px tall -- where an
    // area-based rule would happily try to fit text into a 14px slot.
    //
    // It is also limited by the room left beside the glyph. The two share
    // the cell's top row, and the glyph is sized from the cell while the
    // label is sized from the font, so on a tall narrow cell the glyph can
    // be far the larger of the two and would otherwise run through the
    // text. Treating the label as fitting only when BOTH fit is what makes
    // that impossible by construction.
    const CHAR_W = 0.58;  // Arial average glyph width, in em
    const GLYPH_W = 1.16; // glyph width as a multiple of its height
    const PAD = 5;
    const GAP = 6;
    const labelSize = d => {
        const avail = cellW(d) - PAD
            - (glyphShown(d) ? glyphSize(d) * GLYPH_W + GAP : PAD);
        return Math.min(
            MAX_FS,
            avail / (d.data.name.length * CHAR_W),
            cellH(d) / 2.2
        );
    };

    // Shared centre line for a cell's contents, so the glyph and the label
    // are centred on each other rather than on the cell.
    const contentCy = d =>
        glyphShown(d)
            ? Math.max(glyphSize(d) * 0.85, labelSize(d) * 0.8)
            : labelSize(d) * 0.8;

    // d3 sizes a symbol by AREA: a triangle of area A is 1.316*sqrt(A) tall.
    // This converts a wanted height in px back into a symbol size.
    const TRI_H = 1.316;

    function glyphPathFor(status, size) {
        if (status === "Unchanged") {
            // A flat bar, written in the same centred-origin convention as
            // the d3 symbols so one halo rule covers all three states.
            const w = size * 1.16;
            const h = Math.max(2.5, size * 0.28);
            return `M${-w / 2},${-h / 2}h${w}v${h}h${-w}Z`;
        }
        return d3.symbol()
            .type(d3.symbolTriangle)
            .size((size / TRI_H) ** 2)();
    }

    const glyphPath = d => glyphPathFor(trendOf(d), glyphSize(d));

    // Draw SVG
    function createTreemap(selector, leaves, treemapWidth, treemapHeight, colorScale){
        const treemapSvg =
            d3.select(selector)
            .append("svg")
            .attr("width", treemapWidth)
            .attr("height", treemapHeight);

        const clipId = `${selector.slice(1)}-clip`;

        // One clip per cell: the guarantee that a label can never spill onto
        // a neighbour if the width estimate above turns out optimistic.
        treemapSvg.append("defs")
            .selectAll("clipPath")
            .data(leaves)
            .join("clipPath")
            .attr("id", (d, i) => `${clipId}-${i}`)
            .append("rect")
            .attr("width", d => cellW(d))
            .attr("height", d => cellH(d));

        const cell =
            treemapSvg
            .selectAll(".cell")
            .data(leaves)
            .join("g")
            .attr("class", "cell")
            .attr("transform", d => `translate(${d.x0}, ${d.y0})`);

        // The clip sits on an untransformed inner group, so its user space is
        // unambiguously the cell's own and (0, 0) is the cell's top-left.
        // Putting clip-path on the translated group instead would depend on
        // whether the browser resolves the clip before or after that
        // transform.
        const inner = cell.append("g")
            .attr("class", "cell-inner")
            .attr("clip-path", (d, i) => `url(#${clipId}-${i})`);

        inner.append("rect")
            .attr("width", d => cellW(d))
            .attr("height", d => cellH(d))
            .attr("fill", d => colorScale(getContinent(d)));

        // Glyph first, label second, so the label paints on top. The halo
        // under both is load-bearing, not decoration: measured contrast
        // between a trend colour and the continent fills is 1.1-1.5:1, so
        // without it the glyphs are effectively invisible.
        inner.filter(glyphShown)
            .append("path")
            .attr("class", "glyph")
            .attr("d", glyphPath)
            .attr("fill", d => TREND_COLORS[trendOf(d)])
            .attr("stroke", HALO)
            .attr("stroke-width", HALO_W)
            .attr("stroke-linejoin", "round")
            .attr("paint-order", "stroke fill")
            .attr("transform", d => {
                const cx = labelSize(d) >= MIN_FS
                    ? cellW(d) - glyphSize(d) * 0.9   // top-right, beside the name
                    : cellW(d) / 2;                   // alone, so centred
                return `translate(${cx}, ${contentCy(d)})`
                    + ` rotate(${trendOf(d) === "Decrease" ? 180 : 0})`;
            });

        inner.filter(d => labelSize(d) >= MIN_FS)
            .append("text")
            .attr("x", 5)
            .attr("y", d => contentCy(d) + labelSize(d) * 0.35)
            .attr("font-size", d => labelSize(d))
            .attr("fill", LABEL_INK)
            .attr("stroke", HALO)
            .attr("stroke-width", HALO_W)
            .attr("stroke-linejoin", "round")
            .attr("paint-order", "stroke fill")
            .text(d => d.data.name);

        return cell;
    }
    
    // Legend: a standalone SVG in #legend, stacked top-to-bottom with a
    // running y-cursor so adding a section never means recomputing the
    // offsets of the sections after it.
    function createLegend(continents, colorScale){
        const LEGEND_W = 400;
        const SECTION_HEADER = 16;  // gap from a section top to its first row
        const SECTION_GAP = 20;     // gap between sections
        const TREND_ROW_H = 22;
        const CONT_ROW_H = 18;
        const NOTE_LINE_H = 15;

        const TREND_ROWS = [
            { label: "Increase",  status: "Increase"  },
            { label: "Unchanged", status: "Unchanged" },
            { label: "Decrease",  status: "Decrease"  },
        ];

        const NOTE_LINES = [
            "Hover any cell for the country, area, GDP and trend.",
            "In cells too small to hold them, the name and glyph",
            "hide automatically — hover to read them.",
        ];

        const legendSvg = d3.select("#legend")
            .append("svg")
            .attr("class", "legend-svg");

        const legend = legendSvg.append("g")
            .attr("class", "legend")
            .attr("transform", "translate(10, 25)");

        let legendY = 6;

        // 1) Trend: glyph shape and colour together, drawn the way it
        // appears in a cell -- haloed, on a sample fill.
        const trendY = legendY;
        legendY += SECTION_HEADER + TREND_ROWS.length * TREND_ROW_H;

        const trendSection = legend.append("g")
            .attr("class", "legend-trend")
            .attr("transform", `translate(0, ${trendY})`);

        trendSection.append("text")
            .attr("x", 0)
            .attr("y", 0)
            .attr("font-size", 11)
            .attr("font-weight", "bold")
            .text("GDP trend — glyph & color");

        trendSection.selectAll("g.legend-trend-row")
            .data(TREND_ROWS)
            .join("g")
            .attr("class", "legend-trend-row")
            .attr("transform", (d, i) => `translate(0, ${i * TREND_ROW_H + 12})`)
            .each(function(d) {
                const row = d3.select(this);

                // A sample cell, so the swatch shows the halo and the
                // background the glyph actually sits on.
                row.append("rect")
                    .attr("x", 0).attr("y", -8)
                    .attr("width", 26).attr("height", 16)
                    .attr("rx", 3)
                    .attr("fill", "#f0efec")
                    .attr("stroke", "#c3c2b7")
                    .attr("stroke-width", 0.5);

                row.append("path")
                    .attr("d", glyphPathFor(d.status, 12))
                    .attr("transform",
                        `translate(13, 0) rotate(${d.status === "Decrease" ? 180 : 0})`)
                    .attr("fill", TREND_COLORS[d.status])
                    .attr("stroke", HALO)
                    .attr("stroke-width", 2)
                    .attr("stroke-linejoin", "round")
                    .attr("paint-order", "stroke fill");

                row.append("text")
                    .attr("x", 36)
                    .attr("y", 4)
                    .attr("font-size", 11)
                    .text(d.label);
            });

        // 2) The continent fills.
        const contY = legendY + SECTION_GAP;
        legendY = contY + SECTION_HEADER + continents.length * CONT_ROW_H;

        const contSection = legend.append("g")
            .attr("class", "legend-continents")
            .attr("transform", `translate(0, ${contY})`);

        contSection.append("text")
            .attr("x", 0)
            .attr("y", 0)
            .attr("font-size", 11)
            .attr("font-weight", "bold")
            .text("Continent — cell fill");

        contSection.selectAll("g.legend-continent-row")
            .data(continents)
            .join("g")
            .attr("class", "legend-continent-row")
            .attr("transform", (d, i) => `translate(0, ${i * CONT_ROW_H + 14})`)
            .each(function(d) {
                const row = d3.select(this);

                row.append("rect")
                    .attr("x", 0).attr("y", -7)
                    .attr("width", 14).attr("height", 14)
                    .attr("fill", colorScale(d));

                row.append("text")
                    .attr("x", 22)
                    .attr("y", 4)
                    .attr("font-size", 11)
                    .text(d);
            });

        // 3) Hover for info -- carrying the note that explains why a small
        // cell shows nothing, so the gap isn't read as missing data.
        const noteY = legendY + SECTION_GAP;
        const contentBottom = noteY + SECTION_HEADER + NOTE_LINES.length * NOTE_LINE_H;

        const noteSection = legend.append("g")
            .attr("class", "legend-note")
            .attr("transform", `translate(0, ${noteY})`);

        noteSection.append("text")
            .attr("x", 0)
            .attr("y", 0)
            .attr("font-size", 11)
            .attr("font-weight", "bold")
            .text("Hover for info");

        noteSection.selectAll("text.legend-note-line")
            .data(NOTE_LINES)
            .join("text")
            .attr("class", "legend-note-line")
            .attr("x", 0)
            .attr("y", (d, i) => i * NOTE_LINE_H + 14)
            .attr("font-size", 11)
            .attr("fill", "#52514e")
            .text(d => d);

        // White background so the legend reads cleanly. Inserted as the
        // first child so it sits behind every section, and sized from the
        // final cursor now that the height is known.
        legend.insert("rect", ":first-child")
            .attr("x", -10)
            .attr("y", -25)
            .attr("width", LEGEND_W)
            .attr("height", contentBottom + 35)
            .attr("fill", "#ffffff")
            .attr("stroke", "#bbb")
            .attr("stroke-width", 0.5)
            .attr("rx", 4);

        legendSvg
            .attr("width", LEGEND_W + 20)
            .attr("height", contentBottom + 45)
            .attr("viewBox", `0 0 ${LEGEND_W + 20} ${contentBottom + 45}`);

        // Title appended last so it sits on top of the background.
        legend.append("text")
            .attr("class", "legend-title")
            .attr("x", 0)
            .attr("y", -8)
            .attr("font-size", 13)
            .attr("font-weight", "bold")
            .text("Legend");
    }

    // Treemap 1 (default)
    const cell = createTreemap("#treemap1", leaves, treemapWidth, treemapHeight, colorScale);
    const cell2 = createTreemap("#treemap2", leaves2, treemapWidth, treemapHeight, colorScale);

    createLegend(continents, colorScale);

    // Tooltips
    function createTooltip(cell, tooltip){
        cell
        .on(
            "mouseover",
            function(event, d) {

                tooltip
                    .style(
                        "opacity",
                        1
                    )
                    .html(`
                        <strong>
                            ${d.data.name}
                        </strong>
                        <br>
                        ${d.parent.parent.data.name} / ${d.parent.data.name}
                        <br>
                        GDP:
                        ${d.value}
                        billion $
                        <br>
                        Trend:
                        ${d.data.values.gdp_status}
                    `);
            }
        )
        .on(
            "mousemove",
            function(event) {

                tooltip
                    .style(
                        "left",
                        `${event.pageX + 10}px`
                    )
                    .style(
                        "top",
                        `${event.pageY + 10}px`
                    );
            }
        )
        .on(
            "mouseout",
            function() {

                tooltip.style(
                    "opacity",
                    0
                );
            }
        );
    }

    const toolTip = d3.select("#tooltip")
    createTooltip(cell, toolTip);
    createTooltip(cell2, toolTip);

}

draw();