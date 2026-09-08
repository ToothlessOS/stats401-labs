import { mountNav } from './nav.js';
import '../styles/main.css';

import * as d3 from 'd3';

mountNav('#nav');

// Load data
const [nodes, links] = await Promise.all([
    d3.csv(
        "../data/lab5_assignment_stations.csv",
        d => ({
            id: d.id,
            station_name: d.station_name,
            district: d.district,
            daily_passengers: +d.daily_passengers,
            station_type: d.station_type
        })
    ),
    d3.csv(
        "../data/lab5_assignment_routes.csv",
        d => ({
            source: d.source,
            target: d.target,
            travel_time_min: +d.travel_time_min,
            route_type: d.route_type
        })
    )
])

// Estimate passengers per route as the average of its endpoint stations
const stationById = new Map(nodes.map(n => [n.id, n]));
links.forEach(link => {
    const source = stationById.get(link.source);
    const target = stationById.get(link.target);
    link.weight = (source.daily_passengers + target.daily_passengers) / 2;
});

// SVG Canvas
const width = 800;
const height = 800;

const svg = d3.select("#chart")
    .append("svg")
    .attr("width", width)
    .attr("height", height)

// Map travel time to link distance
const timeToLink = d3.scaleLinear()
    .domain(
        d3.extent(
            links,
            d => d.travel_time_min
        )
    )
    .range([5, 25])

// Force Simulation Setup
const simulation = d3.forceSimulation(nodes)
    .force(
        "link",
        d3.forceLink(links)
            .id(d => d.id)
            .distance(link => timeToLink(link.travel_time_min))
    )
    .force(
        "charge",
        d3.forceManyBody()
            .strength(-125)
    )
    .force(
        "center",
        d3.forceCenter(
            width / 2,
            height / 2
        )
    )
    .force(
        "collision",
        d3.forceCollide()
            .radius(25)
    )
    .force("x", d3.forceX(width / 2).strength(0.04))
    .force("y", d3.forceY(height / 2).strength(0.04));

const link = svg.append("g")
    .attr("class", "links")
    .selectAll("line")
    .data(links)
    .join("line")
    .attr("stroke", "#999")
    .attr("stroke-opacity", 0.6);

// Map daily passengers to a node radius. The radius is pre-computed
// onto each node so the cross arms in Transfer stations can be sized
// in the same pass as the circle.
const sizeScale = d3.scaleSqrt()
    .domain(
        [0, d3.max(nodes,d => d.daily_passengers)] 
    )
    .range([0, 18]);

nodes.forEach(n => { n.__r = sizeScale(n.daily_passengers); });

// Each node is a <g class="node"> containing a circle plus, for
// Transfer stations, two short lines forming a "+".
const node = svg.append("g")
    .attr("class", "nodes")
    .selectAll("g.node")
    .data(nodes)
    .join("g")
    .attr("class", d => `node node--${(d.station_type || "unknown").toLowerCase()}`)
    .attr("stroke", "#222")
    .attr("stroke-width", 1.5);

node.append("circle")
    .attr("r", d => d.__r);

// Cross arms (±60% of radius). Rendered on every node and toggled
// visible only for Transfer stations (see per-type styling below).
const crossLenFrac = 0.6;
node.append("line")
    .attr("class", "cross cross--h")
    .attr("x1", d => -d.__r * crossLenFrac)
    .attr("x2", d =>  d.__r * crossLenFrac)
    .attr("y1", 0)
    .attr("y2", 0);
node.append("line")
    .attr("class", "cross cross--v")
    .attr("x1", 0)
    .attr("x2", 0)
    .attr("y1", d => -d.__r * crossLenFrac)
    .attr("y2", d =>  d.__r * crossLenFrac);

simulation.on(
    "tick",
    () => {

        link
            .attr("x1", d => d.source.x)
            .attr("y1", d => d.source.y)
            .attr("x2", d => d.target.x)
            .attr("y2", d => d.target.y);

        node
            .attr("transform", d => `translate(${d.x}, ${d.y})`);
    }
);

const district = Array.from(
    new Set(
        nodes.map(d => d.district)
    )
);

// Use district for node color scale
const colorScale = d3.scaleOrdinal()
    .domain(district)
    .range(d3.schemeTableau10)

node.attr(
    "fill",
    d => colorScale(d.district)
)

// Type-based shape:
//   Terminal -> solid disc (district color, no stroke)
//   Transfer -> hollow circle + visible "+"
//   Local    -> hollow circle
//   anything else -> fall back to the Local look.
node.select("circle")
    .attr("fill", d => d.station_type === "Terminal" ? colorScale(d.district) : "#ffffff")
    .attr("stroke", d => d.station_type === "Terminal" ? "none" : colorScale(d.district))
    .attr("stroke-width", d => d.station_type === "Terminal" ? 0 : 3);

node.selectAll("line.cross")
    .attr("display", d => d.station_type === "Transfer" ? null : "none")
    .attr("stroke", d => d.station_type === "Terminal" ? "none" : colorScale(d.district))

// Use link width to encode travel time: shorter travel = thicker
// edge. Range is reversed so the smallest travel_time maps to the
// largest stroke width.
const travelTimeToWidth = function (link) {
    return linkWidthScale(link.travel_time_min);
}

const linkWidthScale = d3.scaleLinear()
    .domain(d3.extent(links, d => d.travel_time_min))
    .range([7, 2]);

link.attr(
    "stroke-width",
    d => travelTimeToWidth(d)
)

const linkTypes = Array.from(
    new Set(
        links.map(d => d.route_type)
    )
)

const linkColorScale = d3.scaleOrdinal()
    .domain(linkTypes)
    .range(d3.schemeTableau10.slice(5,8))

link.attr(
    "stroke",
    d => linkColorScale(d.route_type)
)

// Legend: lives in a separate SVG sibling to the chart so its
// background never blocks nodes in the chart's drawing area.
const legendSvg = d3.select("#chart").append("svg")
    .attr("class", "legend-svg");

const legend = legendSvg.append("g")
    .attr("class", "legend")
    .attr("transform", "translate(10, 25)");

// Layout constants for the four sections.
const ROW_H = 18;             // district row height
const SECTION_ROW_H = 22;     // station-type / link-color / width row height
const SECTION_GAP = 18;       // vertical gap between sections
const SECTION_HEADER = 14;    // offset from section top to first row
const STATION_TYPES = ["Terminal", "Transfer", "Local"];

// Track the next y-offset as we stack sections top-to-bottom so
// adding/removing a section doesn't require recomputing chains.
let legendY = 12;

// 1) District (node fill color)
const districtY = legendY;
legendY += SECTION_HEADER + district.length * ROW_H + SECTION_GAP;

const legendDistricts = legend.append("g")
    .attr("class", "legend-districts")
    .attr("transform", `translate(0, ${districtY})`);

legendDistricts.append("text")
    .attr("x", 0)
    .attr("y", 0)
    .attr("font-size", 11)
    .attr("font-weight", "bold")
    .text("District");

legendDistricts.selectAll("g.legend-district-row")
    .data(district)
    .join("g")
    .attr("class", "legend-district-row")
    .attr("transform", (_, i) => `translate(0, ${SECTION_HEADER + i * ROW_H})`)
    .each(function(d) {
        const row = d3.select(this);
        row.append("circle")
            .attr("cx", 7)
            .attr("cy", 6)
            .attr("r", 5)
            .attr("fill", colorScale(d));
        row.append("text")
            .attr("x", 18)
            .attr("y", 9)
            .attr("font-size", 11)
            .text(d);
    });

// 2) Station type (node shape)
const typesY = legendY;
legendY += SECTION_HEADER + STATION_TYPES.length * SECTION_ROW_H + SECTION_GAP;

const legendTypes = legend.append("g")
    .attr("class", "legend-types")
    .attr("transform", `translate(0, ${typesY})`);

legendTypes.append("text")
    .attr("x", 0)
    .attr("y", 0)
    .attr("font-size", 11)
    .attr("font-weight", "bold")
    .text("Station type");

legendTypes.selectAll("g.legend-type-row")
    .data(STATION_TYPES)
    .join("g")
    .attr("class", "legend-type-row")
    .attr("transform", (_, i) => `translate(0, ${SECTION_HEADER + i * SECTION_ROW_H})`)
    .each(function(type) {
        const row = d3.select(this);
        const cx = 7;
        const cy = 6;
        const r = 6;
        // Mirror the actual node rendering for each type at small scale.
        if (type === "Terminal") {
            row.append("circle")
                .attr("cx", cx)
                .attr("cy", cy)
                .attr("r", r)
                .attr("fill", colorScale(district[0]))
                .attr("stroke", "none");
        } else {
            row.append("circle")
                .attr("cx", cx)
                .attr("cy", cy)
                .attr("r", r)
                .attr("fill", "#ffffff")
                .attr("stroke", "#222")
                .attr("stroke-width", 1.5);
            if (type === "Transfer") {
                const k = r * 0.6;
                row.append("line")
                    .attr("x1", cx - k).attr("x2", cx + k)
                    .attr("y1", cy).attr("y2", cy)
                    .attr("stroke", "#222")
                    .attr("stroke-width", 1.5);
                row.append("line")
                    .attr("x1", cx).attr("x2", cx)
                    .attr("y1", cy - k).attr("y2", cy + k)
                    .attr("stroke", "#222")
                    .attr("stroke-width", 1.5);
            }
        }
        row.append("text")
            .attr("x", 20)
            .attr("y", 10)
            .attr("font-size", 11)
            .text(type);
    });

// 3) Link color (route type)
const linkColorY = legendY;
legendY += SECTION_HEADER + linkTypes.length * SECTION_ROW_H + SECTION_GAP;

const legendLinkColor = legend.append("g")
    .attr("class", "legend-link-color")
    .attr("transform", `translate(0, ${linkColorY})`);

legendLinkColor.append("text")
    .attr("x", 0)
    .attr("y", 0)
    .attr("font-size", 11)
    .attr("font-weight", "bold")
    .text("Route type");

legendLinkColor.selectAll("g.legend-link-color-row")
    .data(linkTypes)
    .join("g")
    .attr("class", "legend-link-color-row")
    .attr("transform", (_, i) => `translate(0, ${SECTION_HEADER + i * SECTION_ROW_H})`)
    .each(function(type) {
        const row = d3.select(this);
        row.append("line")
            .attr("x1", 0)
            .attr("x2", 35)
            .attr("y1", 6)
            .attr("y2", 6)
            .attr("stroke", linkColorScale(type))
            .attr("stroke-width", 3);
        row.append("text")
            .attr("x", 42)
            .attr("y", 10)
            .attr("font-size", 11)
            .text(type);
    });

// 4) Edge width = travel time (shorter travel = thicker edge)
const WIDTH_EXAMPLES = [
    { label: "5 min", width: linkWidthScale(5) },
    { label: "10 min", width: linkWidthScale(10) },
    { label: "15 min", width: linkWidthScale(15) }
];
const widthY = legendY;
const legendHeight = widthY + SECTION_HEADER + WIDTH_EXAMPLES.length * SECTION_ROW_H + 12;

const legendWidth = legend.append("g")
    .attr("class", "legend-width")
    .attr("transform", `translate(0, ${widthY})`);

legendWidth.append("text")
    .attr("x", 0)
    .attr("y", 0)
    .attr("font-size", 11)
    .attr("font-weight", "bold")
    .text("Travel time");

legendWidth.selectAll("g.legend-width-row")
    .data(WIDTH_EXAMPLES)
    .join("g")
    .attr("class", "legend-width-row")
    .attr("transform", (_, i) => `translate(0, ${SECTION_HEADER + i * SECTION_ROW_H})`)
    .each(function(d) {
        const row = d3.select(this);
        row.append("line")
            .attr("x1", 0)
            .attr("x2", 35)
            .attr("y1", 6)
            .attr("y2", 6)
            .attr("stroke", "#999")
            .attr("stroke-width", d.width);
        row.append("text")
            .attr("x", 42)
            .attr("y", 10)
            .attr("font-size", 11)
            .text(d.label);
    });

// White background so the legend reads cleanly. Inserted as the
// first child so it sits behind the title and rows. Width/height
// are set on the SVG now that legendHeight is known.
legend.insert("rect", ":first-child")
    .attr("x", -10)
    .attr("y", -25)
    .attr("width", 195)
    .attr("height", legendHeight)
    .attr("fill", "#ffffff")
    .attr("stroke", "#bbb")
    .attr("stroke-width", 0.5)
    .attr("rx", 4);

legendSvg
    .attr("width", 215)
    .attr("height", legendHeight + 30)
    .attr("viewBox", `0 0 215 ${legendHeight + 30}`);

// Title appended last so it sits on top of the background.
legend.append("text")
    .attr("class", "legend-title")
    .attr("x", 0)
    .attr("y", -8)
    .attr("font-size", 13)
    .attr("font-weight", "bold")
    .text("Legend");

simulation.on(
    "tick",
    () => {

        link
            .attr("x1", d => d.source.x)
            .attr("y1", d => d.source.y)
            .attr("x2", d => d.target.x)
            .attr("y2", d => d.target.y);

        node
            .attr("transform", d => `translate(${d.x}, ${d.y})`);
    }
);

function dragStarted(
    event,
    d
) {

    if (!event.active) {
        simulation
            .alphaTarget(0.3)
            .restart();
    }

    d.fx = d.x;
    d.fy = d.y;
}

function dragged(
    event,
    d
) {

    d.fx = event.x;
    d.fy = event.y;
}

function dragEnded(
    event,
    d
) {

    if (!event.active) {
        simulation
            .alphaTarget(0);
    }

    d.fx = null;
    d.fy = null;
}

node.call(
    d3.drag()
        .on("start", dragStarted)
        .on("drag", dragged)
        .on("end", dragEnded)
);

// Highlight connected nodes
function isConnected(
    nodeA,
    nodeB
) {

    return links.some(
        link =>
            (
                link.source.id === nodeA.id &&
                link.target.id === nodeB.id
            )
            ||
            (
                link.source.id === nodeB.id &&
                link.target.id === nodeA.id
            )
    );
}

// Tooltip helpers — #tooltip is the absolute-positioned div in
// index.html, styled by .tooltip in main.css. We just populate it
// and position it near the cursor.
const tooltip = d3.select("#tooltip");

const showTooltip = (event, html) => {
    tooltip
        .html(html)
        .style("left", `${event.pageX + 12}px`)
        .style("top", `${event.pageY + 12}px`)
        .style("opacity", 1);
};

const moveTooltip = (event) => {
    tooltip
        .style("left", `${event.pageX + 12}px`)
        .style("top", `${event.pageY + 12}px`);
};

const hideTooltip = () => {
    tooltip.style("opacity", 0);
};

const nodeTooltipHtml = (d) =>
    `<strong>${d.station_name}</strong><br>` +
    `Type: ${d.station_type}<br>` +
    `District: ${d.district}<br>` +
    `Daily passengers: ${d.daily_passengers.toLocaleString()}`;

node.on(
    "mouseover",
    function(event, d) {

        node.attr(
            "opacity",
            other =>
                (
                    other.id === d.id ||
                    isConnected(d, other)
                )
                ? 1
                : 0.3
        );

        link.attr(
            "opacity",
            l =>
                (
                    l.source.id === d.id ||
                    l.target.id === d.id
                )
                ? 1
                : 0.2
        );

        showTooltip(event, nodeTooltipHtml(d));
    }
);

node.on("mousemove", moveTooltip);

node.on(
    "mouseout",
    function() {

        node.attr("opacity", 1);
        link.attr("opacity", 0.6);
        hideTooltip();
    }
);

// Highlight links
function connectedToLink(link, n) {
    return n.id === link.source.id || n.id === link.target.id;
}

const linkTooltipHtml = (d) =>
    `<strong>${d.source.station_name} <=> ${d.target.station_name}</strong><br>` +
    `Route type: ${d.route_type}<br>` +
    `Travel time: ${d.travel_time_min} min<br>` ;

link.on("mouseover", function(event, d) {
    node.attr("opacity", n => connectedToLink(d, n) ? 1 : 0.3);
    link.attr("opacity", l => l === d ? 1 : 0.6);
    showTooltip(event, linkTooltipHtml(d));
});

link.on("mousemove", moveTooltip);

link.on("mouseout", function() {
    node.attr("opacity", 1);
    link.attr("opacity", 0.6);
    hideTooltip();
});
