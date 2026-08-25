// Lab 1: Getting Started with D3.js
//
// Migrated from the original vanilla lab1/js/main.js. D3 is now
// imported as an ES module from npm (no more CDN <script> tag), and
// the lab-specific code lives under src/ so Vite bundles it cleanly.
//
// The corresponding lab1/index.html still provides the #author,
// #numbers, and #svg-demo elements that this module selects.

import * as d3 from 'd3';
import { mountNav } from './nav.js';
import '../styles/main.css';

mountNav('#nav');

async function loadData() {

    // Load dataset using d3
    const data = await d3.csv('../data/students.csv', d => ({name: d.name, score: +d.score}));
    console.log(data);

    // Define the margin
    const margin = {top: 40, right: 40, bottom: 40, left: 40};
    const width = 1000 - margin.left - margin.right;
    const height = 600 - margin.top - margin.bottom;

    // Create the visualization
    const svg = d3.select('#svg-figure')
        .append('svg')
        .attr('width', 1000)
        .attr('height', 600);

    const x = d3.scaleBand()
        .domain(d3.range(data.length))
        .range([0, width])
        .paddingInner(0.1);

    const y = d3.scaleLinear()
        .domain([0, 100])
        .range([height, 0]);

    svg.append('g')
        .attr('transform', `translate(${margin.left}, ${margin.top})`)
        .attr('fill', 'steelblue')
        .selectAll('rect')
        .data(data)
        .join('rect')
            .attr('x', (d, i) => x(i))
            .attr('y', d => y(d.score))
                .attr('height', d => y(0) - y(d.score))
                .attr('width', x.bandwidth());

    // Functions to create axes
    function yAxis(g){
        g.attr("transform", `translate(${margin.left},${margin.top})`)
        .call(d3.axisLeft(y).ticks(null, data.format))
        .attr("font-size", '20px');
        }

    function xAxis(g){
        g.attr("transform", `translate(${margin.left},${height + margin.top})`)
        .call(d3.axisBottom(x).tickFormat(i => `${data[i].name}(${data[i].score})`))
        .attr("font-size", '20px');
    }

    svg.append("g").call(xAxis);
    svg.append("g").call(yAxis);
    svg.node();

    // Add title
    svg.append("text")
        .attr("x", margin.left + width / 2)
        .attr("y", margin.top / 2)
        .attr("text-anchor", "middle")
        .style("font-size", "24px")
        .text("Student Scores");

}

loadData();


d3.csv('../data/students.csv')