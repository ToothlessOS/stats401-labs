For visualization crique task, we have to critique and redesign a visualization. I chose the navigraph survey on the flight simulator users - the original survey include visualizations of switch between different flight simulators with Sankey diagrams (see: `critique/ref.png` and `critique/ref2.webp`).

I think the Sankey diagram is the right diagram to use for this visualization. However, there are two problems with the original visualization:

1. Over-plotting: There are too many lines to illustrate the full switch status (as in `critique/ref.png`); This is alleviated in `critique/ref2.webp` by showing only the switch status from MSFS2020. This can be properly addressed with interactive features with `D3.js`: by selecting one simulator on the to / from side, we can highlight / render with color the users switching in / switching out on that simulator. The other colors can simply to plotted in gray. Also, we can add tooltips to display the detailed status below the diagram for detailed stats.
2. Effectiveness: The data can be used to show both the trend of market share changes as well as the switch status - I think we should make full use of it. In the `data/survey_flow_matrix.csv` dataset, I kept the data for all users, include the users who did not switch simulators. (Note: the from side cannot be treated as the market share for last year, but it offers insights about trends of market shares).

The dataset have more categories, but we will only keep popular simulators including MSFS2024, MSFS2020, XP12, XP11, GeoFS and P3D as individal categories and all others will be in the "others" category.

Let's create a first version, than I will give you the feedback on how to tune it.