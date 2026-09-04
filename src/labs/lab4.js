// Lab 4 — Sentiment by weekday (stacked bar chart).
// Renders public/data/sentiment_by_weekdays.json as a D3 stacked bar chart
// with a legend and per-rect tooltips. Edit the constants in the
// "CONFIG" block below to change dimensions, weekday order, colors,
// or tooltip wording.

import * as d3 from 'd3';
import { mountNav } from './nav.js';
import '../styles/main.css';

mountNav('#nav');

// ---------- CONFIG (edit these to change the chart) ----------
const width  = 900;
const height = 500;
const margin = { top: 60, right: 180, bottom: 70, left: 70 };

const weekdays = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const sentiments = ['Negative', 'Neutral', 'Positive'];

// Negative / Neutral / Positive → red / grey / green. Edit here to recolor.
const colorScale = d3.scaleOrdinal()
    .domain(sentiments)
    .range(['#c0392b', '#7f8c8d', '#27ae60']);

const titleText = 'Tweet Sentiment by Day of Week';
const xLabel = 'Day of week';
const yLabel = 'Tweet count (out of 250 per day)';
// -----------------------------------------------------------

const svg = d3.select('#chart')
    .append('svg')
    .attr('width', width)
    .attr('height', height);

const tooltip = d3.select('#tooltip');

async function draw() {
    // 1) Load
    const raw = await d3.json(
        `${import.meta.env.BASE_URL}data/sentiment_by_weekdays.json`
    );

    // 2) Reshape nested JSON → array of rows (one per weekday).
    //    Input:  { Negative: {Monday:79,...}, Neutral:{...}, Positive:{...} }
    //    Output: [{weekday:'Monday', Negative:79, Neutral:63, Positive:108}, ...]
    const rows = weekdays.map(d => ({
        weekday:  d,
        Negative: raw.Negative[d],
        Neutral:  raw.Neutral[d],
        Positive: raw.Positive[d],
    }));

    // 3) Compute weekday totals for the tooltip.
    rows.forEach(r => { r.total = r.Negative + r.Neutral + r.Positive; });

    // 4) Stack the rows. d3.stack() returns one array per key; each
    //    datapoint gets [y0, y1] pixel offsets. Order in `sentiments`
    //    sets stacking order (Negative at the base).
    const series = d3.stack().keys(sentiments)(rows);

    // 5) Scales.
    const xScale = d3.scaleBand()
        .domain(weekdays)
        .range([margin.left, width - margin.right])
        .padding(0.2);

    const yScale = d3.scaleLinear()
        .domain([0, 260])   // each weekday sums to 250; pad slightly
        .range([height - margin.bottom, margin.top]);

    // 6) Title.
    svg.append('text')
        .attr('class', 'chart-title')
        .attr('x', width / 2)
        .attr('y', margin.top / 2 + 6)
        .attr('text-anchor', 'middle')
        .style('font-size', '20px')
        .style('font-weight', 'bold')
        .text(titleText);

    // 7) Axes.
    svg.append('g')
        .attr('transform', `translate(0, ${height - margin.bottom})`)
        .call(d3.axisBottom(xScale))
        .attr('font-size', '13px');

    svg.append('g')
        .attr('transform', `translate(${margin.left}, 0)`)
        .call(d3.axisLeft(yScale).ticks(5))
        .attr('font-size', '13px');

    // 8) Axis labels.
    svg.append('text')
        .attr('x', (margin.left + (width - margin.right)) / 2)
        .attr('y', height - 18)
        .attr('text-anchor', 'middle')
        .text(xLabel);

    svg.append('text')
        .attr('transform', 'rotate(-90)')
        .attr('x', -(margin.top + (height - margin.bottom)) / 2)
        .attr('y', 18)
        .attr('text-anchor', 'middle')
        .text(yLabel);

    // 9) Stacked bars: one <g class="layer"> per sentiment, then <rect>
    //    per weekday. Color comes from the same scale used in the legend.
    svg.append('g')
        .attr('class', 'layers')
        .selectAll('g.layer')
        .data(series)
        .join('g')
            .attr('class', 'layer')
            .attr('fill', d => colorScale(d.key))
        .selectAll('rect')
        .data(d => d.map(item => ({ ...item, key: d.key })))   // carry key onto each rect
        .join('rect')
            .attr('x', d => xScale(d.data.weekday))
            .attr('y', d => yScale(d[1]))
            .attr('height', d => yScale(d[0]) - yScale(d[1]))
            .attr('width', xScale.bandwidth())
            .attr('stroke', '#fff')
            .attr('stroke-width', 0.5)
            .on('mouseover', (_event, d) => {
                const pct = (100 * (d[1] - d[0]) / d.data.total).toFixed(1);
                tooltip
                    .style('opacity', 1)
                    .html(
                        `<strong>${d.data.weekday} — ${d.key}</strong><br>` +
                        `Count: ${d[1] - d[0]}<br>` +
                        `Share of day: ${pct}%<br>` +
                        `Day total: ${d.data.total}`
                    );
            })
            .on('mousemove', (event) => {
                tooltip
                    .style('left', `${event.pageX + 12}px`)
                    .style('top',  `${event.pageY + 12}px`);
            })
            .on('mouseout', () => tooltip.style('opacity', 0));

    // 10) Legend (right side, same colors as the bars).
    const legend = svg.append('g')
        .attr('class', 'legend')
        .attr('transform', `translate(${width - margin.right + 25}, ${margin.top})`);

    legend.append('text')
        .attr('class', 'legend-title')
        .attr('x', 0).attr('y', -10)
        .attr('font-size', '13px')
        .attr('font-weight', 'bold')
        .text('Sentiment');

    legend.selectAll('g.legend-item')
        .data(sentiments)
        .join('g')
            .attr('class', 'legend-item')
            .attr('transform', (_d, i) => `translate(0, ${i * 24})`)
        .each(function(d) {
            d3.select(this).append('rect')
                .attr('x', 0).attr('y', 0)
                .attr('width', 14).attr('height', 14)
                .attr('fill', colorScale(d));
            d3.select(this).append('text')
                .attr('x', 22).attr('y', 12)
                .attr('font-size', '13px')
                .text(d);
        });
}

draw();
