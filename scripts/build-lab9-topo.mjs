// Build the simplified TopoJSON topology that Lab 9's two maps are drawn from.
//
// Run with `npm run build:lab9-topo`.  The output is committed, so this only
// needs re-running when the source data changes.
//
// Why this exists at all: data/countries.geojson is 14 MB / 548,472 coordinate
// pairs.  The cartogram algorithm in topogram is O(points x features) *per
// iteration*, so feeding it the raw file would freeze the browser for minutes.
// Simplifying to ~18,000 points first brings one iteration down to well under a
// millisecond, and shrinks the download by two orders of magnitude.
//
// The output feeds BOTH maps, not just the cartogram.  Sharing one topology is
// what makes the two panels line up exactly, which matters because Part D asks
// the reader to match a country across the two representations.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import * as d3 from 'd3';
import { topology } from 'topojson-server';
import { feature } from 'topojson-client';
import { presimplify } from 'topojson-simplify';

const SRC = 'data/countries.geojson';
const OUT = 'public/data/countries.topo.json';

// Point budget for the whole world.  Spent mostly on the large landmasses; the
// cartogram's cost is O(points x 50 features) per iteration, so this is the
// number that decides how long the cartogram takes to compute.
const TARGET_POINTS = 50_000;

// Minimum points to keep in ANY arc, whatever the weight cutoff says.
//
// This is load-bearing, not tidiness.  A tiny island round-tripped through a
// plain weight-threshold simplify collapses to its 2 arc endpoints - a ring
// with zero area - and d3's path.centroid() returns [NaN, NaN] for a zero-area
// ring.  topogram sums the force from EVERY feature onto EVERY point, so one
// NaN centroid turns all 50 countries' coordinates into NaN in a single pass
// and the cartogram renders as nothing.
//
// That is not hypothetical: at an 18k budget Singapore (40 points, 0.31 px^2
// projected) and Hong Kong (398 points, 0.66 px^2) both collapsed to 2 points.
// Both are in the top 50, and Singapore is the single most dramatic case in the
// whole assignment - it has to grow ~30x.  Four points rather than three keeps a
// margin against three near-collinear points still rounding to zero area.
const MIN_ARC_POINTS = 4;

// Quantization grid per dimension.  1e4 is ~0.036 degrees, about 4 km at the
// equator - finer than the simplification above, so it never becomes the
// binding constraint on shape.
const QUANTIZATION = 1e4;

/** Total points across every arc.  This, not the feature count, is what drives
 *  both the render cost and the cartogram cost. */
function countPoints(topo) {
    return topo.arcs.reduce((sum, arc) => sum + arc.length, 0);
}

const geo = JSON.parse(readFileSync(SRC, 'utf8'));
console.log(`read ${SRC}: ${geo.features.length} features`);

// ---------------------------------------------------------------------------
// Simplify
// ---------------------------------------------------------------------------

// Pass 1: build the topology, quantized UP FRONT.
//
// The order matters, and getting it wrong is subtle.  Quantization rounds every
// coordinate onto a grid, which is what squashes near-degenerate slivers into
// genuinely degenerate ones - and a degenerate ring is the thing that makes d3
// fill the whole sphere.  If quantization happens at the END, it re-breaks the
// rings that were just repaired, and the repair silently accomplishes nothing.
// Quantizing here means every later stage works on the final coordinates, so
// the repair below is the last word.
//
// Sharing arcs between neighbours is the other reason to build a topology at
// all: it lets the cartogram move a shared border once instead of tearing it
// into two independently-moving copies.
const full = topology({ countries: geo }, QUANTIZATION);

// presimplify attaches a weight (the planar triangle area the point would
// remove) to every point.  Arc endpoints get Infinity, so they always survive.
const pre = presimplify(full);

/**
 * Drop points below `cutoff`, except that every arc keeps at least
 * MIN_ARC_POINTS of its most important ones.
 *
 * This is topojson-simplify's simplify() plus the floor.  It is written out
 * rather than called because simplify() gives no way to express the floor, and
 * the floor is the whole reason small countries survive - see MIN_ARC_POINTS.
 * Points are kept in their original order so the arcs stay valid rings.
 */
function simplifyWithFloor(cutoff) {
    return pre.arcs.map(arc => {
        const kept = new Set(arc.filter(p => p[2] >= cutoff));

        if (kept.size < MIN_ARC_POINTS) {
            // Restore this arc's highest-weight points - the ones that carry the
            // most shape - until it clears the floor.
            const byWeight = [...arc].sort((a, b) => b[2] - a[2]);
            for (const p of byWeight) {
                if (kept.size >= MIN_ARC_POINTS) break;
                kept.add(p);
            }
        }

        return arc.filter(p => kept.has(p)).map(p => [p[0], p[1]]);
    });
}

// Binary search the weight cutoff for the point budget, rather than guessing a
// magic constant.  Each pass is O(n), so ~20 of them is microseconds, and it
// stays correct if the source file is ever swapped.
const weights = pre.arcs
    .flat()
    .map(p => p[2])
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

if (weights.length === 0) {
    throw new Error('presimplify produced no finite weights - is the source empty?');
}

let lo = 0;
let hi = weights.length - 1;

while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const arcs = simplifyWithFloor(weights[mid]);
    if (arcs.reduce((s, a) => s + a.length, 0) > TARGET_POINTS) lo = mid + 1;
    else hi = mid;
}

// The floor means the budget is a target, not a guarantee: if the arcs'
// four-point minimums add up to more than TARGET_POINTS, the floor wins.
const simplified = {
    type: 'Topology',
    bbox: pre.bbox,
    objects: pre.objects,
    arcs: simplifyWithFloor(weights[lo])
};
console.log(
    `simplified: ${countPoints(full)} -> ${countPoints(simplified)} points ` +
    `(target ${TARGET_POINTS}, cutoff ${weights[lo].toExponential(3)})`
);

// ---------------------------------------------------------------------------
// Re-quantize
// ---------------------------------------------------------------------------

/**
 * Planar shoelace of a ring in lon/lat.  Positive is counterclockwise, which
 * is the winding GeoJSON requires for an exterior ring.
 */
function signedArea(ring) {
    let sum = 0;
    for (let i = 0, n = ring.length; i < n; i++) {
        const [x0, y0] = ring[i];
        const [x1, y1] = ring[(i + 1) % n];
        sum += x0 * y1 - x1 * y0;
    }
    return sum / 2;
}

/**
 * Force exterior rings clockwise and holes counterclockwise (in planar
 * lon/lat terms).
 *
 * The sense is worth stating because it inverts the naive reading, and getting
 * it backwards makes things dramatically worse rather than failing safe.
 * GeoJSON's right-hand rule is defined on the sphere: with longitude on x and
 * latitude on y, a correctly wound exterior ring runs CLOCKWISE.  All 4,274
 * exterior rings in the source file are clockwise for exactly this reason, and
 * d3 reads them as the small region they are (Indonesia's comes out at 0.0465
 * steradians, very close to its true 1.9M km^2 share of the globe).
 *
 * This is not cosmetic.  A ring wound the other way means "the whole sphere
 * except this shape", so d3 paints over the entire map.  Simplification is what
 * breaks the winding: an islet reduced to a 4-point sliver has a shoelace near
 * zero, where the sign is numerical noise rather than geography.  24 rings
 * flipped that way, including a 0.036-degree Greek island - which, being
 * outside the top 50, painted the choropleth solid no-data grey and hid all 50
 * coloured countries behind it.
 *
 * Checking a ring's area cannot catch this: the ring really is tiny.  It is the
 * FILL that is enormous, and only orientation predicts it.
 */
function repairGeometry(featureCollection) {
    const stats = { flipped: 0, droppedRings: 0, droppedFeatures: [] };
    const features = [];

    const asPolygon = ring => ({ type: 'Polygon', coordinates: [ring] });

    // d3.geoArea is the ground truth, not the planar shoelace above.  It applies
    // the same spherical fill rule the renderer will, so it can classify the
    // rings the planar sign test cannot: a ring quantization has squashed to a
    // near-degenerate sliver has a shoelace of essentially zero, where the sign
    // is numerical noise, but geometry still resolves to either ~0 or ~4pi.
    // Anything above half the sphere is being read as the complement.
    const HALF_SPHERE = 2 * Math.PI;

    for (const f of featureCollection.features) {
        const { type, coordinates } = f.geometry;

        if (type !== 'Polygon' && type !== 'MultiPolygon') {
            features.push(f);
            continue;
        }

        const polygons = (type === 'Polygon' ? [coordinates] : coordinates).filter(Boolean);
        const keptPolygons = [];

        for (const polygon of polygons) {
            // Exterior first: it decides whether the polygon is worth keeping at
            // all.  If reversing it still leaves d3 filling the sphere, the ring
            // is degenerate beyond saving and the whole polygon goes.
            if (d3.geoArea(asPolygon(polygon[0])) > HALF_SPHERE) {
                polygon[0].reverse();
                stats.flipped++;
            }

            if (d3.geoArea(asPolygon(polygon[0])) > HALF_SPHERE) {
                stats.droppedRings++;
                continue;
            }

            // Holes wind the opposite way, so a correctly wound hole is the one
            // d3 reads as MORE than half the sphere.
            const keptRings = [polygon[0]];

            for (let i = 1; i < polygon.length; i++) {
                if (d3.geoArea(asPolygon(polygon[i])) < HALF_SPHERE) {
                    polygon[i].reverse();
                    stats.flipped++;
                }

                if (d3.geoArea(asPolygon(polygon[i])) < HALF_SPHERE) {
                    stats.droppedRings++;
                    continue;
                }

                keptRings.push(polygon[i]);
            }

            keptPolygons.push(keptRings);
        }

        // Nothing survived: the feature occupied no pixels to begin with, so it
        // is dropped rather than left as an invalid empty geometry.
        if (keptPolygons.length === 0) {
            stats.droppedFeatures.push(f.properties.name);
            continue;
        }

        if (keptPolygons.length !== polygons.length || type === 'Polygon') {
            f.geometry = { type: 'MultiPolygon', coordinates: keptPolygons };
        }

        features.push(f);
    }

    return { collection: { type: 'FeatureCollection', features }, stats };
}

// presimplify() decodes the quantized arcs back to absolute lon/lat and drops
// `transform`; simplify() carries that through.  topojson-simplify v3 no longer
// exports a quantize(), so the only way back to a delta-encoded topology is to
// rebuild it from the simplified GeoJSON.
//
// This step is not cosmetic.  topogram does `tf.scale[0]` on topology.transform
// with no null guard, so a topology without a transform throws the moment the
// cartogram runs.  (topojson-client's own transform() *does* guard for null;
// topogram's does not.  Verified against node_modules/topogram/src/cartogram.js.)
const decoded = feature(simplified, simplified.objects.countries);
const { collection: repaired, stats } = repairGeometry(decoded);

console.log(
    `repaired geometry: ${stats.flipped} rings re-wound, ` +
    `${stats.droppedRings} degenerate polygons dropped` +
    (stats.droppedFeatures.length
        ? `, ${stats.droppedFeatures.length} features removed (no pixels at this ` +
          `resolution): ${stats.droppedFeatures.join(', ')}`
        : '')
);

const out = topology({ countries: repaired }, QUANTIZATION);

// ---------------------------------------------------------------------------
// Verify before writing
// ---------------------------------------------------------------------------

// The Lab 9 join keys off properties.name (the France/Norway fallback) and
// properties['ISO3166-1-Alpha-3'] (the primary key).  If the round trip dropped
// either, the join would fail silently at runtime and surface far from its
// cause - so fail loudly here instead.
if (!out.transform) {
    throw new Error('output has no transform - topogram will throw on transformer()');
}

const geometries = out.objects.countries.geometries;
const missing = geometries.filter(g => g.properties?.name == null);
const missingIso = geometries.filter(g => g.properties?.['ISO3166-1-Alpha-3'] == null);

if (missing.length) {
    throw new Error(`${missing.length} geometries lost properties.name`);
}
if (missingIso.length) {
    throw new Error(`${missingIso.length} geometries lost ISO3166-1-Alpha-3`);
}
if (geometries.length !== geo.features.length) {
    throw new Error(
        `feature count changed: ${geo.features.length} -> ${geometries.length}. ` +
        'A country would silently vanish from both maps.'
    );
}

// Measure what d3 will actually FILL, not what the ring's area is.
//
// These differ, and the difference is the whole point.  A mis-wound ring is
// genuinely tiny - its own area is fine - but d3 fills the sphere minus that
// tiny shape, so it paints over every country drawn before it.  Checking ring
// or feature area misses this completely; only running the same fill rule d3
// uses catches it.  A single such ring is enough to hide all 50 coloured
// countries behind a wall of no-data grey, which is exactly what happened.
const drawn = feature(out, out.objects.countries).features;

const proj = d3.geoNaturalEarth1().fitExtent(
    [[0, 0], [920, 430]],
    { type: 'FeatureCollection', features: drawn }
);

const drawnPath = d3.geoPath(proj);
const sphere = drawnPath.area({ type: 'Sphere' });

// An inverted ring is >= 100% of the sphere; the largest real country is a few
// percent, so anything past a quarter of the sphere is a winding bug.
const INVERTED = drawn.filter(f => drawnPath.area(f) > sphere * 0.25);

if (INVERTED.length) {
    throw new Error(
        `${INVERTED.length} features would fill the whole map (inverted winding), ` +
        `hiding every country drawn before them:\n  ` +
        INVERTED.slice(0, 10)
            .map(f => `${f.properties.name} (${(drawnPath.area(f) / sphere * 100).toFixed(0)}% of sphere)`)
            .join('\n  ')
    );
}

// Separate concern: features quantization has legitimately wiped out.  These
// render as nothing, which is expected for genuinely sub-pixel territories and
// is harmless on the choropleth.  It must never include a country that reaches
// the cartogram - a zero-area feature gives path.centroid() a [NaN, NaN], and
// topogram sums one force per feature onto every point, so one blanks all 50.
// That guard lives in lab9.js, where the GDP list is known.
const empty = drawn.filter(f => drawnPath.area(f) === 0);

if (empty.length) {
    console.log(
        `note: ${empty.length} features are below one quantization cell and ` +
        `render as nothing (expected for sub-pixel territories):\n  ` +
        empty.map(f => f.properties.name).join(', ')
    );
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));

const kb = (readFileSync(OUT).length / 1024).toFixed(0);
console.log(
    `wrote ${OUT}: ${kb} KB, ${geometries.length} features, ` +
    `${countPoints(out)} points, transform present`
);
