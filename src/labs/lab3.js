// Lab 3 placeholder.

import { mountNav } from './nav.js';
import '../styles/main.css';

import * as d3 from 'd3';

mountNav('#nav');

d3.csv('../data/books.csv')
    .then(data => {
        const columns = data.columns;
        let ascending = true;

        const header = d3.select("#data-table thead").append("tr");

        header.selectAll("th")
            .data(columns)
            .join("th")
            .text(d => d)
            .style("cursor", "pointer")
            .on(
                "click",
                (event, column) => {
                    data.sort(
                        (a, b) => 
                            ascending
                            ? d3.ascending(
                                a[column],
                                b[column]
                              )
                            : d3.descending(
                                a[column],
                                b[column]
                            )
                    );

                    ascending = !ascending;

                    updateRows();

                }
            )

        const rows = d3.select("#data-table tbody")
            .selectAll("tr")
            .data(data)
            .join("tr");
        
        rows.selectAll("td")
            .data(row => columns.map(c => row[c]))
            .join("td")
            .text(d => d);

        
        function updateRows() {
            const table = d3.select("#data-table");

            const rows = table
                .select("tbody")
                .selectAll("tr")
                .data(data);

            rows.join("tr")
                .selectAll("td")
                .data(row => columns.map(column => {
                    const value = row[column];
                    return column === "link"
                        ? { column, value: `<a href="${value}" target="_blank" rel="noopener noreferrer">Link</a>` }
                        : { column, value };
                }))
                .join("td")
                .each(function(d) {
                    if (d.column === "link") {
                        d3.select(this).html(d.value);
                    } else {
                        d3.select(this).text(d.value);
                    }
                });
        }

        updateRows();
    })