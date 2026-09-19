import { mountNav } from './nav.js';
import '../styles/main.css';

import * as d3 from 'd3';

mountNav('#nav');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Full content width of the page (body is max-width 1000px with 20px side
// padding), kept a little under 960 so a scrollbar cannot force the page to
// scroll sideways.
const WIDTH = 920;
const HEIGHT = 700;

// Every region gets a fixed anchor, arranged as a triangle: Asia on top, the
// two western regions below it. Nodes are pulled toward their own region's
// anchor, and that is what collects the four companies of a region into a
// cluster instead of letting them spread across the whole canvas.
const REGION_ANCHORS = {
    "Asia":          { x: 460, y: 165 },
    "North America": { x: 185, y: 525 },
    "Europe":        { x: 735, y: 525 }
};

// Deliberately unhurried. After each day's links change the force layout needs
// a moment to drift into place, and the viewer needs longer still to register
// which relationships appeared or vanished before the next frame replaces them.
// The baseline (Normal) is the default selection.
const SPEEDS = [
    { label: "Slow",   ms: 1800 },
    { label: "Normal", ms: 1000 },
    { label: "Fast",   ms: 400 }
];

const DEFAULT_SPEED_MS = 1000;

const HALO = "#ffffff";   // label outline, so names stay readable over links
const HALO_W = 3;

const HULL_PAD = 30;      // px the dashed hull is pushed out past the nodes
// Cool blue, so that grey is left free for the connected-cluster hulls below.
const HULL_INK = "#6b8cae";
const HULL_LABEL_INK = "#4f7096";

// Connected-cluster hulls: one per connected component of the day's graph,
// which always splits into 2-4 pieces. Shades are handed out largest cluster
// first, so the biggest cluster is always the darkest.
const CLUSTER_GREYS = ["#4d4d4d", "#6e6e6e", "#8f8f8f", "#b0b0b0"];
const CLUSTER_PAD = 10;    // px the hull clears the node circles by
const CLUSTER_RING = 16;   // points sampled around each node
const CLUSTER_FILL = 0.10;
const CLUSTER_STROKE = 0.85;

const HIT_W = 12;         // invisible hover width for the 1-6px link lines

const ENTER_MS = 350;
// Must stay below the fastest frame interval (Fast, 400ms). An exit transition
// that is still running when the next frame joins gets cancelled and restarted,
// so the line would never actually reach removal.
const EXIT_MS = 150;

const LINK_OPACITY = 0.75;

// Streak channel: a company that traded both yesterday and today gets a yellow
// glow. Bright yellow, deliberately lighter than schemeDark2's #e6ab02, which
// is the fill of one of the sectors.
const STREAK_MIN_DAYS = 5; // consecutive days of trading before the glow appears
const STREAK_COLOR = "#ffd60a";
const STREAK_W = 6;        // glow ring stroke width
const STREAK_PAD = 3;      // how far the ring sits outside the node
const STREAK_OPACITY = 0.9;
const STREAK_BLUR = 3.5;

// Link colour encodes transaction type. The five hues match the ones shown in
// the agreed design; none of them is a light yellow, which would be unreadable
// as a 2px stroke.
const TRANSACTION_TYPES = ["goods", "shipping", "components", "materials", "services"];
const TYPE_COLORS = ["#4e79a7", "#f28e2c", "#59a14f", "#e15759", "#b07aa1"];

async function draw() {
    const [companies, transactions] = await Promise.all([
        d3.csv(
            "../data/lab7_assignment_companies.csv",
            d => ({
                id: d.id,
                company_name: d.company_name,
                sector: d.sector,
                region: d.region
            })
        ),
        d3.csv(
            "../data/lab7_assignment_transactions_60days.csv",
            d => ({
                date: d.date,
                day: +d.day,
                source: d.source,
                target: d.target,
                amount_usd: +d.amount_usd,
                transaction_type: d.transaction_type,
                transaction_count: +d.transaction_count
            })
        )]
    );

    // -----------------------------------------------------------------------
    // Derived values
    // -----------------------------------------------------------------------

    const regions = Array.from(new Set(companies.map(d => d.region)));
    const sectors = Array.from(new Set(companies.map(d => d.sector)));

    const FIRST_DAY = d3.min(transactions, d => d.day);
    const LAST_DAY = d3.max(transactions, d => d.day);

    // Day -> ISO date, read from the data rather than recomputed, so the
    // readout can never drift from the file.
    const DATE_BY_DAY = new Map(transactions.map(d => [d.day, d.date]));

    const companyById = new Map(companies.map(d => [d.id, d]));

    // A link endpoint is an id string until d3.forceLink() hands the link to the
    // simulation, at which point it is swapped for a node reference. Some readers
    // run before that swap (the volume sum) and some after (the tooltip), so
    // every reader has to tolerate both shapes.
    const idOf = end => (typeof end === "object" ? end.id : end);
    const companyOf = end => (typeof end === "object" ? end : companyById.get(end));

    // Largest per-company daily transaction volume across all 60 days. The node
    // size scale is pinned to this global maximum rather than recomputed each
    // day: with a per-day domain the busiest company of every day would be drawn
    // at the same size, which would hide the assignment's "who becomes more
    // active over time?" and make the legend's size swatches meaningless.
    let maxVolume = 0;
    for (const dayLinks of d3.group(transactions, d => d.day).values()) {
        const byCompany = new Map(companies.map(c => [c.id, 0]));
        for (const l of dayLinks) {
            byCompany.set(l.source, byCompany.get(l.source) + l.amount_usd);
            byCompany.set(l.target, byCompany.get(l.target) + l.amount_usd);
        }
        maxVolume = Math.max(maxVolume, d3.max(byCompany.values()));
    }

    // Streak length per company per day: the number of consecutive days ending
    // on that day in which the company traded, as either source or target.
    //
    // Built for the whole 60 days up front rather than carried along during
    // playback, because a streak is a property of the calendar and not of the
    // order the user happened to watch. Scrubbing from day 30 back to day 5 has
    // to give the same answer as playing forwards to day 5.
    const linksByDay = d3.group(transactions, d => d.day);
    const streakByDay = new Map();

    for (let day = FIRST_DAY; day <= LAST_DAY; day++) {
        const active = new Set();

        for (const l of linksByDay.get(day) ?? []) {
            active.add(l.source);
            active.add(l.target);
        }

        const yesterday = streakByDay.get(day - 1) ?? new Map();
        const streak = new Map();

        // Only companies that traded today appear here, so a company that
        // skipped today drops out and its run restarts at 1 if it returns.
        for (const id of active) {
            streak.set(id, (yesterday.get(id) ?? 0) + 1);
        }

        streakByDay.set(day, streak);
    }

    // -----------------------------------------------------------------------
    // Visual channels
    // -----------------------------------------------------------------------

    // Node fill encodes sector (7 values). schemeDark2 is chosen over
    // schemeTableau10 because a node is a small filled disc carrying a label:
    // Tableau10's light yellow is close to invisible at that size.
    const colorScale = d3.scaleOrdinal()
        .domain(sectors)
        .range(d3.schemeDark2);

    const linkColorScale = d3.scaleOrdinal()
        .domain(TRANSACTION_TYPES)
        .range(TYPE_COLORS)
        .unknown("#bbbbbb");

    // Node radius encodes the day's transaction volume, as area.
    const sizeScale = d3.scaleSqrt()
        .domain([0, maxVolume])
        .range([4, 18]);

    // Link width encodes the transaction amount.
    const widthScale = d3.scaleSqrt()
        .domain([0, d3.max(transactions, d => d.amount_usd)])
        .range([1, 6]);

    // -----------------------------------------------------------------------
    // SVG canvas and layers
    // -----------------------------------------------------------------------

    const svg = d3.select("#chart")
        .append("svg")
        .attr("width", WIDTH)
        .attr("height", HEIGHT);

    // A blurred stroke is what makes the streak ring read as a glow rather than
    // as a second outline. The filter region is widened because the default
    // (-10% to 120% of the bounding box) would clip the blurred stroke.
    svg.append("defs")
        .append("filter")
        .attr("id", "streak-glow")
        .attr("x", "-80%")
        .attr("y", "-80%")
        .attr("width", "260%")
        .attr("height", "260%")
        .append("feGaussianBlur")
        .attr("stdDeviation", STREAK_BLUR);

    // Layers are created once and re-joined by updateNetwork(), so changing the
    // day updates the marks already on screen rather than stacking another <g>
    // on top of every previous frame. Document order is z-order: hulls sit
    // behind the links, the invisible hit lines sit above the visible ones, and
    // nodes and their labels paint last. The glow sits directly under the nodes
    // so the fill covers its inner edge and only the halo shows.
    const hullLayer = svg.append("g")
        .attr("class", "hulls");

    // Above the region hulls but below the links, so the grey washes never get
    // between a link and the reader.
    const clusterLayer = svg.append("g")
        .attr("class", "clusters")
        .attr("pointer-events", "none");

    const linkLayer = svg.append("g")
        .attr("class", "links");

    const linkHitLayer = svg.append("g")
        .attr("class", "link-hits");

    const glowLayer = svg.append("g")
        .attr("class", "streaks")
        .attr("pointer-events", "none");

    const nodeLayer = svg.append("g")
        .attr("class", "nodes");

    const labelLayer = svg.append("g")
        .attr("class", "labels")
        .attr("pointer-events", "none");

    // -----------------------------------------------------------------------
    // Simulation
    // -----------------------------------------------------------------------

    // One simulation for the whole page. Node positions carry over from one day
    // to the next, which is what lets the layout drift instead of restarting
    // cold each frame.
    const simulation = d3.forceSimulation(companies)
        .alphaDecay(0.1);

    const linkForce = d3.forceLink()
        .id(d => d.id)
        // Shorter links inside a region make a region actually look like a
        // cluster; longer ones across regions leave a visible corridor between
        // hulls. The accessor runs after forceLink has resolved the endpoints,
        // so d.source is a node here, not an id.
        .distance(d => d.source.region === d.target.region ? 80 : 170);

    simulation
        .force("link", linkForce)
        .force(
            "charge",
            d3.forceManyBody()
                .strength(-120)
                // Without a cutoff the two far-apart clusters repel each other,
                // stretching the cross-region links and fighting the anchors.
                .distanceMax(300)
        )
        .force("x", d3.forceX(d => REGION_ANCHORS[d.region].x).strength(0.15))
        .force("y", d3.forceY(d => REGION_ANCHORS[d.region].y).strength(0.15))
        // Flat radius, not an accessor on node size: this radius exists to keep
        // the *labels* apart, and label width depends on the name, not on the
        // node's volume.
        .force("collision", d3.forceCollide().radius(34).strength(0.9).iterations(2));

    // forceCenter is deliberately absent. It applies a rigid translation every
    // tick to centre the node cloud, which fights the three region anchors and
    // leaves the layout permanently jittering. The anchors already keep the
    // graph on-canvas, more precisely than a single centre point would.

    // -----------------------------------------------------------------------
    // Region hulls
    // -----------------------------------------------------------------------

    // Shared by the region hulls and the connected-cluster hulls.
    const hullOutline = d3.line()
        .x(p => p[0])
        .y(p => p[1])
        // Catmull-Rom passes through every point, so the padding below is
        // honoured exactly where the nodes are. curveBasisClosed would shrink
        // the polygon inward and clip the circles.
        .curve(d3.curveCatmullRomClosed);

    // Given a region name, return the dashed outline around that region's nodes
    // plus where to put the region's label.
    function hullFor(regionName) {
        const pts = companies
            .filter(d => d.region === regionName)
            .filter(d => Number.isFinite(d.x) && Number.isFinite(d.y))
            .map(d => [d.x, d.y]);

        // Mean, not d3.polygonCentroid: the centroid divides by the polygon's
        // area and returns NaN for a degenerate one.
        const cx = d3.mean(pts, p => p[0]);
        const cy = d3.mean(pts, p => p[1]);

        if (!pts.length) return { cx: 0, top: 0, d: null };

        const hull = d3.polygonHull(pts);

        // polygonHull returns null for fewer than three points, and a degenerate
        // two-point array when the points are collinear. Both are reachable while
        // the layout settles, so the fallback keeps the region visible as a
        // circle rather than dropping it or drawing a nonsense blob.
        if (!hull || hull.length < 3) {
            const r = (d3.max(pts, p => Math.hypot(p[0] - cx, p[1] - cy)) || 0) + HULL_PAD;
            return {
                cx,
                top: cy - r,
                d: d3.arc()({ innerRadius: r, outerRadius: r })
            };
        }

        // Push every hull vertex outward from the cluster's centre. A true
        // polygon offset would be geometrically tidier, but scaling is one line,
        // always encloses the points, and reads naturally on a 3- or 4-point
        // hull. Clearance at an edge midpoint is roughly half HULL_PAD.
        const meanR = d3.mean(hull, p => Math.hypot(p[0] - cx, p[1] - cy)) || 1;
        const k = (meanR + HULL_PAD) / meanR;
        const padded = hull.map(p => [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k]);

        return { cx, top: d3.min(padded, p => p[1]), d: hullOutline(padded) };
    }

    // Regions are fixed, so the three groups are created once here.
    const hullGroup = hullLayer.selectAll("g.hull")
        .data(regions)
        .join("g")
        .attr("class", "hull")
        // The faint fill must never intercept a hover meant for a link.
        .attr("pointer-events", "none");

    hullGroup.append("path")
        .attr("fill", HULL_INK)
        .attr("fill-opacity", 0.06)
        .attr("stroke", HULL_INK)
        .attr("stroke-opacity", 0.9)
        .attr("stroke-width", 1.5)
        .attr("stroke-dasharray", "6,4")
        .attr("stroke-linejoin", "round");

    hullGroup.append("text")
        .attr("text-anchor", "middle")
        .attr("font-size", 12)
        .attr("font-weight", "bold")
        .attr("fill", HULL_LABEL_INK)
        .attr("stroke", HALO)
        .attr("stroke-width", HALO_W)
        .attr("stroke-linejoin", "round")
        .attr("paint-order", "stroke fill")
        .text(d => d);

    // Path strings are memoised so a tick that does not move a region writes
    // nothing to the DOM.
    const lastHullPath = new Map();

    function updateHulls() {
        hullGroup.each(function(regionName) {
            const { cx, top, d } = hullFor(regionName);
            const g = d3.select(this);

            if (lastHullPath.get(regionName) !== d) {
                g.select("path").attr("d", d);
                lastHullPath.set(regionName, d);
            }

            // x comes from the centroid rather than from whichever vertex is
            // topmost: the topmost vertex's x flips discontinuously between
            // ticks, which would make the label jump sideways.
            g.select("text").attr("transform", `translate(${cx}, ${top - 8})`);
        });
    }

    // -----------------------------------------------------------------------
    // Connected-cluster hulls
    // -----------------------------------------------------------------------

    // The connected components of one day's links, as arrays of company ids.
    // Breadth-first over an adjacency map built from the day's transactions.
    function connectedComponents(currentLinks) {
        const adjacency = new Map();
        const touch = id => {
            if (!adjacency.has(id)) adjacency.set(id, new Set());
            return adjacency.get(id);
        };

        // idOf, because an endpoint is still an id string here -- forceLink has
        // not been handed this array yet.
        currentLinks.forEach(l => {
            const s = idOf(l.source);
            const t = idOf(l.target);
            touch(s).add(t);
            touch(t).add(s);
        });

        const seen = new Set();
        const groups = [];

        for (const start of adjacency.keys()) {
            if (seen.has(start)) continue;

            const stack = [start];
            const group = [];
            seen.add(start);

            while (stack.length) {
                const id = stack.pop();
                group.push(id);
                for (const next of adjacency.get(id)) {
                    if (!seen.has(next)) {
                        seen.add(next);
                        stack.push(next);
                    }
                }
            }

            groups.push(group);
        }

        return groups;
    }

    // Outline of one cluster. Rather than hulling the node centres and then
    // padding the result, this samples a ring around every node and hulls the
    // lot -- which encloses the circles themselves and, more importantly, works
    // for a cluster of two nodes. Those are the most common kind in this
    // dataset, and d3.polygonHull returns null for so few points, so the
    // centre-based approach would need a special case.
    function clusterPath(nodes) {
        const pts = [];

        for (const n of nodes) {
            const r = sizeScale(n.volume ?? 0) + CLUSTER_PAD;
            for (let i = 0; i < CLUSTER_RING; i++) {
                const a = 2 * Math.PI * i / CLUSTER_RING;
                pts.push([n.x + Math.cos(a) * r, n.y + Math.sin(a) * r]);
            }
        }

        const hull = d3.polygonHull(pts);
        return (hull && hull.length >= 3) ? hullOutline(hull) : null;
    }


    // -----------------------------------------------------------------------
    // Nodes and labels
    // -----------------------------------------------------------------------

    // The companies are the same every day, so this join runs once and only the
    // radius and fill are recomputed per day.
    const node = nodeLayer.selectAll("circle")
        .data(companies, d => d.id)
        .join("circle")
        .attr("r", 4)
        .attr("stroke", "#ffffff")
        .attr("stroke-width", 1.5);

    // The streak glow: one halo per company, joined once like the nodes, and
    // faded in and out by updateNetwork() as the streak starts and breaks.
    const glow = glowLayer.selectAll("circle")
        .data(companies, d => d.id)
        .join("circle")
        .attr("fill", "none")
        .attr("stroke", STREAK_COLOR)
        .attr("stroke-width", STREAK_W)
        .attr("opacity", 0)
        .attr("filter", "url(#streak-glow)");

    // One <g> per company holding its name, split over two lines. Every name in
    // the dataset is exactly two words, so first-word / rest is enough and no
    // general wrapping is needed; two short lines also keep the labels narrow
    // enough to clear the collision radius.
    const label = labelLayer.selectAll("g.node-label")
        .data(companies, d => d.id)
        .join("g")
        .attr("class", "node-label")
        .attr("pointer-events", "none");

    label.each(function(d) {
        const g = d3.select(this);
        const words = d.company_name.split(" ");
        const lines = [words[0], words.slice(1).join(" ")];

        lines.forEach((line, i) => {
            g.append("text")
                .attr("text-anchor", "middle")
                .attr("x", 0)
                .attr("y", i * 11)
                .attr("font-size", 10)
                .attr("fill", "#333333")
                .attr("stroke", HALO)
                .attr("stroke-width", HALO_W)
                .attr("stroke-linejoin", "round")
                .attr("paint-order", "stroke fill")
                .text(line);
        });
    });

    // -----------------------------------------------------------------------
    // Tooltips
    // -----------------------------------------------------------------------

    const tooltip = d3.select("#tooltip");

    const showTooltip = (event, html) => tooltip
        .html(html)
        .style("left", `${event.pageX + 10}px`)
        .style("top", `${event.pageY + 10}px`)
        .style("opacity", 1);

    const moveTooltip = event => tooltip
        .style("left", `${event.pageX + 10}px`)
        .style("top", `${event.pageY + 10}px`);

    const hideTooltip = () => tooltip.style("opacity", 0);

    function nodeTooltipHtml(d) {
        // The glow only says "traded yesterday and today"; the tooltip is where
        // the length of the run behind it is readable.
        const streakLine = d.streak >= STREAK_MIN_DAYS
            ? `<br>Streak: ${d.streak} days in a row`
            : "";

        return `
            <strong>${d.company_name}</strong><br>
            Sector: ${d.sector}<br>
            Region: ${d.region}<br>
            Volume: $${(d.volume ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}${streakLine}
        `;
    }

    function linkTooltipHtml(d) {
        const s = companyOf(d.source);
        const t = companyOf(d.target);

        return `
            <strong>${s.company_name} → ${t.company_name}</strong><br>
            Type: ${d.transaction_type}<br>
            Amount: $${d.amount_usd.toLocaleString(undefined, { maximumFractionDigits: 2 })}<br>
            Transactions: ${d.transaction_count}<br>
            Day ${d.day} · ${d.date}
        `;
    }

    // Safe to bind once: `node` is joined a single time over an array that never
    // changes, so these elements are never replaced.
    function createTooltip(selection) {
        selection
            .on("mouseover", (event, d) => showTooltip(event, nodeTooltipHtml(d)))
            .on("mousemove", event => moveTooltip(event))
            .on("mouseout", () => hideTooltip());
    }

    // The link handlers live on the layer rather than on the individual lines,
    // because the layer survives every re-join while updateNetwork() replaces
    // its children on every frame. Binding to the `link` selection itself would
    // attach to a selection that is reassigned moments later, and nothing would
    // ever fire. mouseleave (which does not bubble) also avoids the flicker a
    // per-line mouseout produces when the cursor passes straight from one line
    // onto another.
    function createLinkTooltip(layer) {
        layer
            .on("mouseover", function(event) {
                const d = d3.select(event.target).datum();
                if (d) showTooltip(event, linkTooltipHtml(d));
            })
            .on("mousemove", event => moveTooltip(event))
            .on("mouseleave", () => hideTooltip());
    }

    createTooltip(node);
    createLinkTooltip(linkHitLayer);

    // -----------------------------------------------------------------------
    // Tick
    // -----------------------------------------------------------------------

    // Reassigned by every updateNetwork() call. The tick handler below closes
    // over these bindings and reads them when it runs, so it always draws the
    // most recent join.
    let link = linkLayer.selectAll("line");
    let hit = linkHitLayer.selectAll("line");
    let clusterHull = clusterLayer.selectAll("path.cluster");
    let clusters = [];

    function onTick() {
        updateHulls();

        // Exited cluster hulls are not in clusterHull, so like the links they
        // freeze in place while fading rather than following their old nodes.
        clusterHull.attr("d", d => clusterPath(d.nodes));

        link
            .attr("x1", d => d.source.x)
            .attr("y1", d => d.source.y)
            .attr("x2", d => d.target.x)
            .attr("y2", d => d.target.y);

        hit
            .attr("x1", d => d.source.x)
            .attr("y1", d => d.source.y)
            .attr("x2", d => d.target.x)
            .attr("y2", d => d.target.y);

        node
            .attr("cx", d => d.x)
            .attr("cy", d => d.y);

        // The glow tracks the node exactly, offset so the ring sits just
        // outside the circle at whatever radius that day's volume gave it.
        glow
            .attr("cx", d => d.x)
            .attr("cy", d => d.y)
            .attr("r", d => sizeScale(d.volume ?? 0) + STREAK_PAD);

        // The label sits below its node, so the offset depends on the radius
        // that day's volume produced.
        label.attr("transform", d =>
            `translate(${d.x}, ${d.y + sizeScale(d.volume ?? 0) + 8})`);
    }

    simulation.on("tick", onTick);

    // -----------------------------------------------------------------------
    // Frame pipeline
    // -----------------------------------------------------------------------

    function filterTransactions(day) {
        // Fresh objects per call. d3.forceLink() mutates the links it is handed,
        // replacing the source/target id strings with node references, so the
        // parsed csv rows are never passed to it directly.
        //
        // The join key is deliberately day-free and sorted. Day-free, because a
        // relationship that trades on consecutive days is the same line updated
        // in place -- with the day in the key every link would enter and exit on
        // every frame, and the enter/exit transitions would show nothing but
        // flicker. Sorted, because the assignment treats a link as an undirected
        // commercial relationship, so c03-c05 and c05-c03 are one line rather
        // than two drawn on top of each other.
        return transactions
            .filter(d => d.day === day)
            .map(d => {
                const [a, b] = [d.source, d.target].sort();
                return { ...d, key: `${a}-${b}-${d.transaction_type}` };
            });
    }

    function computeVolume(currentLinks) {
        const volumeById = new Map(companies.map(c => [c.id, 0]));

        currentLinks.forEach(l => {
            // A link contributes its amount to both of its endpoints.
            const s = idOf(l.source);
            const t = idOf(l.target);
            if (volumeById.has(s)) volumeById.set(s, volumeById.get(s) + l.amount_usd);
            if (volumeById.has(t)) volumeById.set(t, volumeById.get(t) + l.amount_usd);
        });

        return volumeById;
    }

    let lastSignature = null;
    let isFirstRender = true;

    function updateNetwork(currentLinks, day) {
        const volumeById = computeVolume(currentLinks);

        // A company is on a streak when it traded on the previous day too, so a
        // run of 2 or more. Day 1 has no previous day, so nobody is highlighted.
        const streaks = streakByDay.get(day) ?? new Map();
        const onStreak = id => (streaks.get(id) ?? 0) >= STREAK_MIN_DAYS;

        // Node radius encodes the company's transaction volume for this day.
        node.attr("r", d => sizeScale(volumeById.get(d.id) ?? 0));
        node.attr("fill", d => colorScale(d.sector));

        // Stashed on the datum so the tooltip and the tick handler can read the
        // current volume and streak without recomputing them.
        companies.forEach(c => {
            c.volume = volumeById.get(c.id) ?? 0;
            c.streak = streaks.get(c.id) ?? 0;
        });

        // Faded rather than snapped, so the glow arrives as a highlight instead
        // of appearing between two frames.
        glow.transition().duration(ENTER_MS)
            .attr("opacity", d => onStreak(d.id) ? STREAK_OPACITY : 0);

        // One hull per connected component of today's graph. Keyed by the sorted
        // member ids, so a cluster that survives into the next day is updated in
        // place -- keeping its shade -- while a cluster that splits or merges
        // exits and re-enters.
        clusters = connectedComponents(currentLinks)
            .map(ids => ({
                key: ids.slice().sort().join("|"),
                nodes: ids.map(id => companyById.get(id)).filter(Boolean)
            }))
            .sort((a, b) =>
                b.nodes.length - a.nodes.length || d3.ascending(a.key, b.key))
            .map((c, i) => ({ ...c, shade: CLUSTER_GREYS[i % CLUSTER_GREYS.length] }));

        clusterHull = clusterLayer.selectAll("path.cluster")
            .data(clusters, d => d.key)
            .join(
                enter => enter.append("path")
                    .attr("class", "cluster")
                    .attr("fill", d => d.shade)
                    .attr("fill-opacity", 0)
                    .attr("stroke", d => d.shade)
                    .attr("stroke-opacity", 0)
                    .attr("stroke-width", 1.5)
                    .attr("stroke-linejoin", "round")
                    .call(sel => sel.transition().duration(ENTER_MS)
                        .attr("fill-opacity", CLUSTER_FILL)
                        .attr("stroke-opacity", CLUSTER_STROKE)),
                update => update.call(sel => sel.transition().duration(ENTER_MS)
                    .attr("fill", d => d.shade)
                    .attr("stroke", d => d.shade)
                    .attr("fill-opacity", CLUSTER_FILL)
                    .attr("stroke-opacity", CLUSTER_STROKE)),
                exit => exit.call(sel => sel.transition().duration(EXIT_MS)
                    .attr("fill-opacity", 0)
                    .attr("stroke-opacity", 0)
                    .remove())
            );

        // Keyed join: a relationship that trades again today is updated in
        // place, a new one enters, and one with no trade today exits.
        //
        // The transitions are deliberately unnamed. An unnamed transition
        // cancels any running transition on the same element and attribute,
        // which is what should happen when a line enters on one frame and is
        // updated on the next -- a named one would leave both running and
        // fighting over the same stroke-width.
        link = linkLayer.selectAll("line")
            .data(currentLinks, d => d.key)
            .join(
                enter => enter.append("line")
                    // Start bright and thick and settle to the true encoding.
                    // That overshoot is the "new connection" cue.
                    .attr("stroke", d => d3.color(linkColorScale(d.transaction_type)).brighter(0.9))
                    .attr("stroke-width", d => widthScale(d.amount_usd) * 1.8)
                    .attr("stroke-opacity", 0)
                    .attr("stroke-linecap", "round")
                    .call(sel => sel.transition().duration(ENTER_MS)
                        .attr("stroke", d => linkColorScale(d.transaction_type))
                        .attr("stroke-width", d => widthScale(d.amount_usd))
                        .attr("stroke-opacity", LINK_OPACITY)),
                update => update
                    // Same relationship, different amount -- its type is part of
                    // the key, so only the width can change. Transitioned rather
                    // than snapped, so a pair that trades bigger two days running
                    // grows instead of jumping.
                    .call(sel => sel.transition().duration(ENTER_MS)
                        .attr("stroke-width", d => widthScale(d.amount_usd))
                        .attr("stroke-opacity", LINK_OPACITY)),
                exit => exit
                    .call(sel => sel.transition().duration(EXIT_MS)
                        .attr("stroke-opacity", 0)
                        .remove())
            );

        // Lines that are fading out are not part of the merged selection above,
        // so the tick handler stops moving them and they fade where they stood.
        // That is the behaviour we want -- do not "fix" it by re-selecting
        // linkLayer.selectAll("line") inside onTick, which would resurrect them
        // with stale data.

        // Same relationships, same keys. No transition on exit: the hit line is
        // invisible, so delaying its removal would only let the cursor hover a
        // line that has already started fading.
        hit = linkHitLayer.selectAll("line")
            .data(currentLinks, d => d.key)
            .join(
                enter => enter.append("line")
                    .attr("stroke", "transparent")
                    .attr("stroke-width", HIT_W)
                    .attr("stroke-linecap", "round"),
                update => update,
                exit => exit.remove()
            );

        // Always hand the day's links to the force. forceLink is what replaces
        // the id strings with node references, and the tick handler reads
        // d.source.x -- skipping this would leave them strings and draw every
        // link at NaN.
        linkForce.links(currentLinks);

        // Signature over the relationship set only. If the same relationships
        // are active as last frame the layout already reflects them, and
        // reheating would add motion the viewer has to re-learn for nothing.
        const signature = currentLinks.map(d => d.key).sort().join("|");
        if (signature !== lastSignature) {
            // alpha is the simulation's temperature. Restarting at 1.0 fires a
            // full-strength re-layout every frame and nodes teleport; 0.3 is a
            // nudge gentle enough to follow.
            simulation.alpha(isFirstRender ? 1 : 0.3).restart();
            lastSignature = signature;
        }
        isFirstRender = false;
    }

    function updateSummary(currentLinks) {
        const totalValue = d3.sum(currentLinks, d => d.amount_usd);
        const activeCompanies = new Set(
            currentLinks.flatMap(d => [idOf(d.source), idOf(d.target)])
        ).size;

        ui.summary.html(
            `Active companies: <strong>${activeCompanies}</strong> / ${companies.length}`
            + ` &nbsp;·&nbsp; Active transactions: <strong>${currentLinks.length}</strong>`
            + ` &nbsp;·&nbsp; Total transaction value: `
            + `<strong>$${totalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong>`
        );
    }

    // -----------------------------------------------------------------------
    // Controls
    // -----------------------------------------------------------------------

    function createControls() {
        const controls = d3.select("#controls");

        const row1 = controls.append("div")
            .attr("class", "controls-row");

        row1.append("button")
            .attr("type", "button").attr("id", "play").text("Play");

        row1.append("button")
            .attr("type", "button").attr("id", "pause").text("Pause");

        row1.append("button")
            .attr("type", "button").attr("id", "reset").text("Reset");

        row1.append("label").attr("for", "speed").text("Speed");

        const speedSelect = row1.append("select").attr("id", "speed");

        speedSelect.selectAll("option")
            .data(SPEEDS)
            .join("option")
            .attr("value", d => d.ms)
            .text(d => d.label);

        speedSelect.property("value", DEFAULT_SPEED_MS);

        // The slider shares the button row: the controls sit between the legend
        // and the network, so every row spent here pushes the graph down.
        row1.append("label").attr("for", "time-slider").text("Day");

        const slider = row1.append("input")
            .attr("type", "range")
            .attr("id", "time-slider")
            .attr("min", FIRST_DAY)
            .attr("max", LAST_DAY)
            .attr("step", 1)
            .property("value", FIRST_DAY);

        const readout = row1.append("span")
            .attr("class", "day-readout");

        const summary = controls.append("div")
            .attr("class", "summary");

        return {
            slider,
            speedSelect,
            readout,
            summary,
            speedMs: () => +speedSelect.property("value")
        };
    }

    const ui = createControls();

    // -----------------------------------------------------------------------
    // Playback
    // -----------------------------------------------------------------------

    // Day-based state (1..60), not a 0-based index. The day column, the slider's
    // min/max and the readout all speak in days; an index would need a +1 at
    // every boundary, which is exactly where off-by-one bugs live.
    let currentDay = FIRST_DAY;
    let timer = null;

    function stopTimer() {
        if (timer) {
            timer.stop();
            timer = null;
        }
    }

    function startTimer() {
        stopTimer();
        // d3.interval bakes the delay in when the timer is created and has no
        // setter, so a speed change has to build a new timer.
        timer = d3.interval(() => {
            if (currentDay >= LAST_DAY) {
                stopTimer();
                return;
            }
            showDay(currentDay + 1);
        }, ui.speedMs());
    }

    function play() {
        if (timer) return;
        // Pressing Play at the end replays from the top rather than doing
        // nothing. Stopping at day 60 (rather than wrapping silently) keeps the
        // end of the data visible.
        if (currentDay >= LAST_DAY) showDay(FIRST_DAY);
        startTimer();
    }

    function pause() {
        stopTimer();
    }

    function reset() {
        stopTimer();
        showDay(FIRST_DAY);
    }

    function showDay(day) {
        currentDay = day;

        ui.slider.property("value", currentDay);
        ui.readout.text(`Day ${currentDay} · ${DATE_BY_DAY.get(currentDay) ?? ""}`);

        // The hovered link may not exist on the new day, and the tooltip would
        // otherwise sit there showing the previous day's numbers.
        hideTooltip();

        const currentLinks = filterTransactions(currentDay);
        updateNetwork(currentLinks, currentDay);
        updateSummary(currentLinks);
    }

    d3.select("#play").on("click", play);
    d3.select("#pause").on("click", pause);
    d3.select("#reset").on("click", reset);

    // Scrubbing always takes over from playback: a running timer would fight
    // the drag and yank the thumb away.
    ui.slider.on("input", function() {
        pause();
        showDay(+this.value);
    });

    ui.speedSelect.on("change", () => {
        if (timer) startTimer();
    });

    // -----------------------------------------------------------------------
    // Legend
    // -----------------------------------------------------------------------

    function createLegend() {
        // Spans the full content width, matching the network below it.
        const LEGEND_W = 900;
        const COL_X = [0, 470];
        // Column 2 is narrower than column 1 so its flowed chips cannot run
        // past the white background, which ends 10px short of the SVG edge.
        const COL_W = [430, 410];

        const CHIP_GAP = 16;    // between flowed swatch+label chips
        const CHIP_H = 20;      // height of one flowed row
        const HEADER_H = 17;    // section title to its first row
        const SECTION_GAP = 16;

        const legendSvg = d3.select("#legend")
            .append("svg")
            .attr("class", "legend-svg");

        const legend = legendSvg.append("g")
            .attr("class", "legend")
            .attr("transform", "translate(10, 25)");

        // One cursor per column.
        const cursor = [6, 6];

        function addHeader(section, title) {
            section.append("text")
                .attr("x", 0)
                .attr("y", 0)
                .attr("font-size", 11)
                .attr("font-weight", "bold")
                .text(title);
        }

        // A section whose entries flow left to right and wrap at the column
        // edge, instead of one entry per row. The three categorical encodings
        // hold 15 entries between them, which stacked vertically would be
        // taller on its own than the graph.
        function addFlowSection(col, key, title, items, swatchW, drawSwatch, labelOf = d => d) {
            const section = legend.append("g")
                .attr("class", `legend-${key}`)
                .attr("transform", `translate(${COL_X[col]}, ${cursor[col]})`);

            addHeader(section, title);

            let x = 0;
            let y = HEADER_H;

            items.forEach(d => {
                // Estimated advance width. Measuring would mean laying the text
                // out first; a few pixels of slack costs nothing at this size.
                const w = swatchW + 8 + labelOf(d).length * 6.1 + CHIP_GAP;

                if (x > 0 && x + w > COL_W[col]) {
                    x = 0;
                    y += CHIP_H;
                }

                drawSwatch(
                    section.append("g").attr("transform", `translate(${x}, ${y})`),
                    d
                );

                x += w;
            });

            cursor[col] += y + CHIP_H + SECTION_GAP;
        }

        // -- Column 1: what a mark is --------------------------------------

        addFlowSection(0, "sector", "Sector — node fill", sectors, 14, (g, d) => {
            g.append("circle")
                .attr("cx", 0).attr("cy", -4).attr("r", 5)
                .attr("fill", colorScale(d));

            g.append("text")
                .attr("x", 14).attr("y", 0)
                .attr("font-size", 11)
                .attr("fill", "#333333")
                .text(d);
        });

        // The two hull families share one section, so adding the cluster hulls
        // did not make the legend any taller. Each swatch's stroke style shows
        // which is which.
        const HULL_ROWS = [
            { label: "Region", ink: HULL_INK, dash: "4,3", fill: 0.06 },
            { label: "Connected cluster", ink: CLUSTER_GREYS[0], dash: null, fill: CLUSTER_FILL }
        ];

        addFlowSection(0, "hulls", "Hulls", HULL_ROWS, 30, (g, d) => {
            const swatch = g.append("rect")
                .attr("x", 0).attr("y", -11)
                .attr("width", 22).attr("height", 14).attr("rx", 7)
                .attr("fill", d.ink).attr("fill-opacity", d.fill)
                .attr("stroke", d.ink).attr("stroke-width", 1.5);

            if (d.dash) swatch.attr("stroke-dasharray", d.dash);

            g.append("text")
                .attr("x", 30).attr("y", 0)
                .attr("font-size", 11)
                .attr("fill", "#333333")
                .text(d.label);
        }, d => d.label);

        // Streak. The swatch reproduces the real mark -- a sector-filled node
        // with its white ring and the blurred halo -- rather than showing the
        // glow colour on its own, so it is obvious what gets highlighted.
        const streakSection = legend.append("g")
            .attr("class", "legend-streak")
            .attr("transform", `translate(${COL_X[0]}, ${cursor[0]})`);

        addHeader(streakSection, "Streak — yellow glow");

        streakSection.append("circle")
            .attr("cx", 20).attr("cy", HEADER_H + 5)
            .attr("r", 9)
            .attr("fill", "none")
            .attr("stroke", STREAK_COLOR)
            .attr("stroke-width", STREAK_W)
            .attr("filter", "url(#streak-glow)");

        streakSection.append("circle")
            .attr("cx", 20).attr("cy", HEADER_H + 5)
            .attr("r", 7)
            .attr("fill", "#1b9e77")
            .attr("stroke", "#ffffff")
            .attr("stroke-width", 1.5);

        streakSection.append("text")
            .attr("x", 46).attr("y", HEADER_H + 9)
            .attr("font-size", 11)
            .attr("fill", "#333333")
            .text(`Trading ${STREAK_MIN_DAYS}+ days in a row`);

        cursor[0] += HEADER_H + 20 + SECTION_GAP;

        const noteSection = legend.append("g")
            .attr("class", "legend-note")
            .attr("transform", `translate(${COL_X[0]}, ${cursor[0]})`);

        addHeader(noteSection, "Hover for info");

        [
            "A node shows its sector, region and current volume.",
            "A link shows both companies, its amount and type."
        ].forEach((line, i) => {
            noteSection.append("text")
                .attr("x", 0)
                .attr("y", HEADER_H + i * 15)
                .attr("font-size", 11)
                .attr("fill", "#52514e")
                .text(line);
        });

        cursor[0] += HEADER_H + 2 * 15 + SECTION_GAP;

        // -- Column 2: magnitude, and how links are encoded -----------------

        // Node size. The three sample volumes are real values from the size
        // scale's own domain, so the swatches cannot misrepresent the mapping.
        const volumeTicks = [0, maxVolume / 2, maxVolume];
        const volumeX = [24, 78, 140];

        const sizeSection = legend.append("g")
            .attr("class", "legend-size")
            .attr("transform", `translate(${COL_X[1]}, ${cursor[1]})`);

        addHeader(sizeSection, "Transaction volume — node size");

        volumeTicks.forEach((v, i) => {
            sizeSection.append("circle")
                .attr("cx", volumeX[i]).attr("cy", HEADER_H + 18)
                .attr("r", sizeScale(v))
                .attr("fill", "#ffffff")
                .attr("stroke", "#666666")
                .attr("stroke-width", 1.2);

            sizeSection.append("text")
                .attr("x", volumeX[i]).attr("y", HEADER_H + 50)
                .attr("text-anchor", "middle")
                .attr("font-size", 10)
                .attr("fill", "#52514e")
                .text(`$${Math.round(v).toLocaleString()}`);
        });

        cursor[1] += HEADER_H + 56 + SECTION_GAP;

        // Link width.
        const amountTicks = [
            d3.min(transactions, d => d.amount_usd),
            d3.max(transactions, d => d.amount_usd) / 2,
            d3.max(transactions, d => d.amount_usd)
        ];
        const widthX = [0, 86, 172];

        const widthSection = legend.append("g")
            .attr("class", "legend-width")
            .attr("transform", `translate(${COL_X[1]}, ${cursor[1]})`);

        addHeader(widthSection, "Transaction amount — link width");

        amountTicks.forEach((v, i) => {
            widthSection.append("line")
                .attr("x1", widthX[i]).attr("x2", widthX[i] + 34)
                .attr("y1", HEADER_H + 10).attr("y2", HEADER_H + 10)
                .attr("stroke", "#666666")
                .attr("stroke-width", widthScale(v))
                .attr("stroke-linecap", "round");

            widthSection.append("text")
                .attr("x", widthX[i] + 42).attr("y", HEADER_H + 14)
                .attr("font-size", 10)
                .attr("fill", "#52514e")
                .text(`$${Math.round(v).toLocaleString()}`);
        });

        cursor[1] += HEADER_H + 22 + SECTION_GAP;

        // Link colour. Flows last, so the two fixed-height sections above it
        // keep their positions whatever the wrapping does.
        addFlowSection(1, "type", "Transaction type — link color", TRANSACTION_TYPES, 30, (g, d) => {
            g.append("line")
                .attr("x1", 0).attr("x2", 24)
                .attr("y1", -4).attr("y2", -4)
                .attr("stroke", linkColorScale(d))
                .attr("stroke-width", 3)
                .attr("stroke-linecap", "round");

            g.append("text")
                .attr("x", 30).attr("y", 0)
                .attr("font-size", 11)
                .attr("fill", "#333333")
                .text(d);
        });

        const contentBottom = d3.max(cursor) - SECTION_GAP;

        // White background, inserted as the first child so it sits behind every
        // section, and sized now that the final height is known.
        legend.insert("rect", ":first-child")
            .attr("x", -10).attr("y", -25)
            .attr("width", LEGEND_W)
            .attr("height", contentBottom + 35)
            .attr("fill", "#ffffff")
            .attr("stroke", "#bbbbbb")
            .attr("stroke-width", 0.5)
            .attr("rx", 4);

        legendSvg
            .attr("width", LEGEND_W + 20)
            .attr("height", contentBottom + 45)
            .attr("viewBox", `0 0 ${LEGEND_W + 20} ${contentBottom + 45}`);

        // Appended last so the title paints on top of the background.
        legend.append("text")
            .attr("class", "legend-title")
            .attr("x", 0).attr("y", -8)
            .attr("font-size", 13)
            .attr("font-weight", "bold")
            .text("Legend");
    }

    createLegend();

    // -----------------------------------------------------------------------
    // First frame
    // -----------------------------------------------------------------------

    showDay(FIRST_DAY);

    // Bake the opening layout synchronously, so the first thing on screen is a
    // settled graph rather than the initial spiral settling in view.
    // simulation.tick() dispatches no "tick" events of its own, so the marks
    // have to be painted once by hand afterwards -- without that the nodes and
    // links would never reach the DOM.
    simulation.stop();
    simulation.tick(300);
    onTick();
}

draw();
