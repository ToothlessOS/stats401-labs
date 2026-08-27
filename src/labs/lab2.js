// Lab 2 placeholder. Lab-specific code is added in src/labs/lab2.js
// during the corresponding lab session; for now this only mounts the
// shared navigation bar.

import * as d3 from 'd3';
import { mountNav } from './nav.js';
import '../styles/main.css';

mountNav('#nav');

const width = 1000;
const height = 500;

const margin = {
    top: 50,
    right: 270,
    bottom: 70,
    left: 100
}

async function visDataExample() {

    // Load dataset
    const data = await d3.csv('../data/students_multivariate.csv', d => ({
        name: d.name,
        study_hours: +d.study_hours,
        score: +d.score,
        major: d.major,
        year: d.year
    }))

    // D3 scales - mapping a data domain to a visual range
    const xScale = d3.scaleLinear()
        .domain(d3.extent(data, d => d.study_hours))
        .nice()
        .range([margin.left, width - margin.right])

    const yScale = d3.scaleLinear()
        .domain(d3.extent(data, d => d.score))
        .nice()
        .range([height - margin.bottom, margin.top])

    // Create Axes
    const svg = d3.select('#chart')
        .append('svg')
        .attr("width", width)
        .attr("height", height)

    svg.append("g")
        .attr("transform", `translate(0, ${height - margin.bottom})`)
        .call(d3.axisBottom(xScale))
        .attr("font-size", '14px');

    svg.append("g")
        .attr("transform", `translate(${margin.left}, 0)`)
        .call(d3.axisLeft(yScale))
        .attr("font-size", '14px');

    svg.append("text")
        .attr("x", width / 2)
        .attr("y", height - 20)
        .attr("text-anchor", "middle")
        .text("Study Hours");

    svg.append("text")
        .attr("transform", "rotate(-90)")
        .attr("x", -height / 2)
        .attr("y", 20)
        .attr("text-anchor", "middle")
        .text("Exam Score")

    // Encode major with color
    const major = Array.from(
        new Set(data.map(d => d.major))
    );

    const colorScale = d3.scaleOrdinal()
        .domain(major)
        .range(d3.schemeTableau10);

    // Encode year with size
    const sizeScale = d3.scaleOrdinal()
        .domain(["Freshman", "Sophomore", "Junior", "Senior"])
        .range([5, 7, 9, 11]);

    svg.selectAll("circle")
        .data(data)
        .join("circle")
        .attr("cx", d => xScale(d.study_hours))
        .attr("cy", d => yScale(d.score))
        .attr("r", d => sizeScale(d.year))
        .attr("fill", d => colorScale(d.major))
        .on("mouseover", (event, d) => {
            
            console.log("page:", event.pageX, event.pageY);
            console.log(d)

            tooltip
                .style("opacity", 1)
                .html(
                    `<strong>${d.name}</strong><br>
                    Study Hours: ${d.study_hours}<br>
                    Score: ${d.score}<br>
                    Major: ${d.major}<br>
                    Year: ${d.year}`
                )

        })
        .on("mousemove", (event) => {

            tooltip
                .style("left", `${event.pageX + 10}px`)
                .style("top", `${event.pageY + 10}px`);

        }) 
        .on("mouseout", () => {
            
            tooltip
                .style("opacity", 0);

        })

    const legend = svg.append("g")
        .attr(
            "transform",
            `translate(${width - margin.right + 25}, 60)`
        );

    const legendItems = legend
        .selectAll(".legend-item")
        .data(major)
        .join("g")
        .attr("class", "legend-item")
        .attr(
            "transform",
            (d, i) => `translate(50, ${i * 28})`
    );

    legendItems.append("circle")
        .attr("r", 6)
        .attr("fill", d => colorScale(d));

    legendItems.append("text")
        .attr("x", 12)
        .attr("y", 4)
        .text(d => d);

    // Tooltips
    const tooltip = d3.select("#tooltip");
}

// The real assignment!
async function visData() {
    
    // Load dataset
    const data = await d3.csv('../data/cities_multivariate.csv', d => ({
        city: d.city,
        population: +d.population,
        temp_c: +d.temp_c,
        development_level: d.development_level,
        region: d.region
    }))

    // D3 scales
    // xScale: population
    // yScale: development_level
    const xScale = d3.scaleLinear()
        .domain(d3.extent(data, d => d.population))
        .nice()
        .range([margin.left, width - margin.right])

    const yOffset = 30;
    
    const yScale = d3.scalePoint()
        .domain(Array.from(new Set(data.map(d => d.development_level))))
        .range([margin.top, height - margin.bottom - yOffset]);

    // Create Axes
    const svg = d3.select('#chart')
        .append('svg')
        .attr("width", width)
        .attr("height", height)

    svg.append("g")
        .attr("transform", `translate(0, ${height - margin.bottom})`)
        .call(d3.axisBottom(xScale))
        .attr("font-size", '14px');

    svg.append("g")
        .attr("transform", `translate(${margin.left}, 0)`)
        .call(d3.axisLeft(yScale))
        .attr("font-size", '14px');

    svg.append("text")
    .attr("x", width / 2 - 75)
    .attr("y", height - 20)
    .attr("text-anchor", "middle")
    .text("Population (millions)");

    svg.append("text")
        .attr("transform", "rotate(-90)")
        .attr("x", -height / 2 + 20)
        .attr("y", 20)
        .attr("text-anchor", "middle")
        .text("Development Level")


    // Encode region with shape
    const regions = Array.from(
        new Set(data.map(d => d.region))
    ).sort();

    const symbolScale = d3.scaleOrdinal()
        .domain(regions)
        .range([
            d3.symbolCircle,
            d3.symbolSquare,
            d3.symbolTriangle,
            d3.symbolDiamond
        ]);

    // Encode temp_c with color
    const colorScale = d3.scaleSequential()
        .domain(d3.extent(data, d => d.temp_c))
        .interpolator(t => {
            const c = d3.hsl(d3.interpolateRdBu(1 - t));

            c.s = Math.min(1, c.s * 1.35); // Increase saturation
            c.l = Math.max(0, c.l - 0.075); // Optional: slightly darker / more contrast

            return c.formatHex();
        });

    const tooltip = d3.select("#tooltip");

    svg.selectAll("path.point")
        .data(data)
        .join("path")
        .attr("class", "point")
        .attr("transform", d =>
         `translate(${xScale(d.population)}, ${yScale(d.development_level)})`)
        .attr("d", d => d3.symbol().type(symbolScale(d.region)).size(90)())
        .attr("fill", d => colorScale(d.temp_c))
        .attr("stroke", "#333")
        .attr("stroke-width", 0.4)
        .on("mouseover", (event, d) => {
            
            console.log("page:", event.pageX, event.pageY);
            console.log(d)

            tooltip
                .style("opacity", 1)
                .html(
                    `<strong>${d.city}</strong><br>
                    Population: ${d.population}<br>
                    Development Level: ${d.development_level}<br>
                    Temperature: ${d.temp_c}<br>
                    Region: ${d.region}`
                )

        })
        .on("mousemove", (event) => {

            tooltip
                .style("left", `${event.pageX + 10}px`)
                .style("top", `${event.pageY + 10}px`);

        }) 
        .on("mouseout", () => {
            
            tooltip
                .style("opacity", 0);

        });

    const legend = svg.append("g")
        .attr("class", "legend")
        .attr("transform", `translate(${width - margin.right + 60}, 60)`);

    legend.append("text")
        .attr("class", "legend-title")
        .attr("x", 0)
        .attr("y", -10)
        .attr("font-size", 14)
        .attr("font-weight", "bold")
        .text("Region");

    legend.selectAll(".legend-item")
        .data(regions)
        .join("g")
        .attr("class", "legend-item")
        .attr("transform", (d, i) => `translate(0, ${i * 26})`)
        .each(function(d) {
            d3.select(this).append("path")
                .attr("d", d3.symbol().type(symbolScale(d)).size(90)())
                .attr("transform", "translate(8, 8)")
                .attr("fill", "#555");

            d3.select(this).append("text")
                .attr("x", 24)
                .attr("y", 12)
                .attr("font-size", 14)
                .text(d);
        });

    // Add title
    svg.append("text")
        .attr("x", margin.left + width / 2 - 160)
        .attr("y", margin.top / 2 - 8)
        .attr("text-anchor", "middle")
        .style("font-size", "24px")
        .text("Cities: Population, Development Level, Temperature, and Region");
}

// visDataExample();
visData();