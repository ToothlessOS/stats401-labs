I extended the Lab 9 visualization on world GDP with choropleth and cartogram.

I implemented two novel interaction features - **gestures** and **voice**. This is to faciliate to user tasks of navigating the visualization on bigger screens and collaborative exploration - gestures and voice allows the users to interact from a distance, and voice also helps to keep everyone on the same page in the collaborative setting. These novel interaction features support all conventional interactions (selecting one, selecting top-k, filtering) except zooming - which is less necessary on large screens and cannot be controlled precisely. The tooltip is adopted so it presents more information - tailored for the user tasks.

One important design is that the voice controls can be easily turned on and off via gestures - so that you won't have the discussions wrongly picked up as commands.

The gesture control is quite good, but the voice control is less accurate - it is easily affected by accent. This is the main limitation of the current visualization.

