For lab10 (See requirements in `Lab10`), I will add voice interaction and gesture interaction to the geospatial visualization in lab9. Here are the steps for the implementation:

1. Extract the graph components (both the choropleth and the cartogram) to the lab 10 page.
2. Add a button for recording voice and recognize commands (with Web Speech API). The following is the list of commands that we should support:
    - Select `country` (Using the existing on-click function)
    - Filter `top-k`
    - Reset selection / filter
3. Add hand gestures controls (with @mediapipe/tasks-vision, which is already installed into the env):
    - A pair of gestures to start / stop voice recognition
    - A pair of gestures the switch between countries with different GDP tiers
4. All of the actions should also be available with conventional interactions. Add documentation on the page.