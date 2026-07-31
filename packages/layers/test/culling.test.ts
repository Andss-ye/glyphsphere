import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { geoContains, geoDistance } from 'd3-geo';
import type { Position } from 'geojson';
import type { Topology } from 'topojson-specification';
import {
  boundingCap,
  capIsVisible,
  capRuns,
  resolveLine,
  resolveRing,
  viewCap,
  parseLandTopology,
  visiblePolygons,
  visibleLines,
} from '../src/index.js';

/**
 * Culling and thinning exist to make deep zoom affordable — 103 ms per frame down to 7 — and
 * they are only allowed to do that if the picture does not change. The dangerous failure is not
 * a slow frame, it is a polygon that stops containing the camera: the land under the viewer
 * turns to ocean, which is exactly the bug this project has already been bitten by twice.
 */

const assets = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'data',
  'assets',
  'earth',
);

/**
 * A circle of `count` points around [lon, lat], radius in degrees.
 *
 * Clockwise in lon/lat, which is what d3 reads as an interior: the obvious counter-clockwise
 * version encloses 97 % of the sphere instead of a disc, which is the same winding trap
 * `rewindPolygon` exists to undo for Natural Earth.
 */
function circle(lon: number, lat: number, radiusDeg: number, count: number): Position[] {
  const ring: Position[] = [];
  for (let i = 0; i <= count; i++) {
    const angle = -(i / count) * Math.PI * 2;
    ring.push([lon + Math.cos(angle) * radiusDeg, lat + Math.sin(angle) * radiusDeg]);
  }
  return ring;
}

describe('bounding caps', () => {
  it('contains every point it was built from', () => {
    const ring = circle(30, 10, 5, 200);
    const cap = boundingCap([ring]);

    for (const [lon, lat] of ring) {
      const distance = geoDistance([cap.centre[0], cap.centre[1]], [lon!, lat!]);
      expect(distance).toBeLessThanOrEqual(cap.radiusRad + 1e-9);
    }
  });

  it('agrees with the geoDistance test it replaced', () => {
    const cap = boundingCap([circle(30, 10, 5, 64)]);

    for (const [lon, lat, horizonRad] of [
      [30, 10, 0.05],
      [35, 10, 0.05],
      [-150, -10, 0.5],
      [31, 11, 0.001],
      [0, 0, 1.5],
    ] as const) {
      const byDistance =
        geoDistance([lon, lat], [cap.centre[0], cap.centre[1]]) - cap.radiusRad <= horizonRad;
      expect(capIsVisible(cap, viewCap(lon, lat, horizonRad))).toBe(byDistance);
    }
  });

  it('handles the antimeridian, where averaging degrees would put the centre at zero', () => {
    const cap = boundingCap([[[179, 0], [-179, 0], [180, 1]]]);
    expect(Math.abs(cap.centre[0])).toBeGreaterThan(170);
    expect(cap.radiusRad).toBeLessThan(0.1);
  });
});

describe('ring thinning', () => {
  const ring = capRuns(circle(0, 0, 20, 512));

  it('keeps every point where the camera is looking', () => {
    // A view wide enough to cover the whole ring: nothing is far, nothing is thinned.
    const full = resolveRing(ring, viewCap(0, 0, Math.PI), 0, []);
    expect(full).toHaveLength(513);
  });

  it('thins what the camera cannot see', () => {
    const partial = resolveRing(ring, viewCap(20, 0, 0.05), 0, []);
    expect(partial.length).toBeLessThan(513);
    expect(partial.length).toBeGreaterThan(16);
  });

  it('always closes the ring, however hard it thins', () => {
    for (const horizon of [0.001, 0.05, 0.5, 3]) {
      const out = resolveRing(ring, viewCap(120, 60, horizon), 0, []);
      expect(out[0]).toEqual(ring.coordinates[0]);
      expect(out[out.length - 1]).toEqual(ring.coordinates[ring.coordinates.length - 1]);
    }
  });

  /**
   * The one that matters. Thinning may move the coastline off screen; it may never move it
   * across the camera, because a polygon that stops containing the viewer paints the ground
   * under them as sea.
   */
  it('still contains a camera that was inside it', () => {
    for (const [lon, lat] of [[0, 0], [10, 5], [-15, -10], [0, 19]] as const) {
      const out = resolveRing(ring, viewCap(lon, lat, 0.02), 0, []);
      expect(geoContains({ type: 'Polygon', coordinates: [out] }, [lon, lat])).toBe(true);
    }
  });

  it('thins by what a subcell can show, so finer data costs nothing extra', () => {
    // A subcell four times the data's own spacing: three points in four are invisible.
    const fine = capRuns(circle(0, 0, 20, 2048));
    const shown = resolveRing(fine, viewCap(0, 0, Math.PI), fine.meanStepRad * 4, []);
    expect(shown.length).toBeLessThan(700);
    expect(geoContains({ type: 'Polygon', coordinates: [shown] }, [0, 0])).toBe(true);
  });
});

describe('against the real coastline', () => {
  const land = parseLandTopology(
    JSON.parse(readFileSync(join(assets, 'land-110m.topo.json'), 'utf8')) as Topology,
    'land',
  );

  it('keeps the camera on land when it is over land', () => {
    // Places that are unambiguously inland, well away from any coast.
    for (const [name, lon, lat] of [
      ['Kansas', -98, 38],
      ['Sahara', 10, 25],
      ['Siberia', 100, 62],
      ['Amazon', -60, -5],
      ['Australia', 133, -25],
    ] as const) {
      const view = viewCap(lon, lat, 0.02);
      const collection = visiblePolygons(land.polygons, view, 0);
      const inside = collection.features.some((f) => geoContains(f, [lon, lat]));
      expect(inside, `${name} should still be land after thinning`).toBe(true);
    }
  });

  it('keeps the camera off land when it is over ocean', () => {
    for (const [name, lon, lat] of [
      ['Pacific', -140, 0],
      ['Atlantic', -30, 20],
      ['Indian', 80, -30],
    ] as const) {
      const view = viewCap(lon, lat, 0.02);
      const collection = visiblePolygons(land.polygons, view, 0);
      const inside = collection.features.some((f) => geoContains(f, [lon, lat]));
      expect(inside, `${name} should still be ocean after thinning`).toBe(false);
    }
  });

  it('rejects the hemisphere behind the planet', () => {
    // Looking at the mid-Pacific, Africa is on the far side and must not be streamed at all.
    const view = viewCap(-160, 0, 1.2);
    const near = visiblePolygons(land.polygons, view, 0);
    const all = visiblePolygons(land.polygons, viewCap(-160, 0, Math.PI), 0);
    expect(near.features.length).toBeLessThan(all.features.length);
  });

  it('drops no coastline the camera can see', () => {
    const view = viewCap(-80.19, 25.77, 0.3);
    const outline = visibleLines(land.outlineSegments, view, 0);
    // Florida's coast is in view: something has to be there.
    expect(outline.coordinates.length).toBeGreaterThan(0);
  });
});

/**
 * `resolveLine` is the stroke counterpart of `resolveRing`, and it is allowed to do something
 * `resolveRing` must never do: **drop** geometry rather than thin it. A line has no interior, so
 * a stretch that is off screen contributes nothing — but dropping it has to split the polyline,
 * because joining across the gap draws a chord, and where a coastline leaves the view and comes
 * back that chord lands right across the screen.
 */
describe('resolveLine', () => {
  /** Every point of every emitted segment, and the segments themselves. */
  function run(ring: Position[], view: ReturnType<typeof viewCap>, subcellRad = 0) {
    const segments: Position[][] = [];
    const pool: Position[][] = [];
    let taken = 0;
    resolveLine(
      capRuns(ring),
      view,
      subcellRad,
      () => {
        const array = pool[taken] ?? [];
        pool[taken] = array;
        taken++;
        return array;
      },
      (segment) => segments.push(segment),
    );
    return segments;
  }

  /** A line of `count` points marching east along the equator from `fromLon`. */
  function equatorLine(fromLon: number, toLon: number, count: number): Position[] {
    return Array.from({ length: count }, (_, i) => [
      fromLon + ((toLon - fromLon) * i) / (count - 1),
      0,
    ]);
  }

  it('invents no points: every coordinate comes from the source', () => {
    const line = equatorLine(-40, 40, 600);
    const source = new Set(line.map((p) => `${p[0]},${p[1]}`));
    for (const segment of run(line, viewCap(0, 0, 0.1))) {
      for (const point of segment) {
        expect(source.has(`${point[0]},${point[1]}`)).toBe(true);
      }
    }
  });

  it('drops the far stretches instead of thinning them', () => {
    // A line crossing a third of the planet, seen through a narrow view at its middle.
    const line = equatorLine(-60, 60, 1200);
    const kept = run(line, viewCap(0, 0, 0.05)).flat();
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(line.length / 4);

    // And what survives is actually near the view, not a scattering of the whole line.
    for (const point of kept) {
      expect(Math.abs(point[0]!)).toBeLessThan(30);
    }
  });

  it('never joins across a gap: no segment contains a chord across the view', () => {
    // Two separate stretches near the view with a long excursion between them, which is the
    // shape that produces a false coastline if the dropped runs are silently skipped.
    const line: Position[] = [
      ...equatorLine(-8, -2, 200),
      ...equatorLine(-2, 178, 400).slice(1),
      ...equatorLine(178, 182, 200).slice(1),
    ];
    const view = viewCap(0, 0, 0.05);

    for (const segment of run(line, view)) {
      for (let i = 1; i < segment.length; i++) {
        const step = geoDistance(
          [segment[i - 1]![0]!, segment[i - 1]![1]!],
          [segment[i]![0]!, segment[i]![1]!],
        );
        // Consecutive points inside a segment stay adjacent on the source line; a joined gap
        // would show up here as a single stride of tens of degrees.
        expect(step).toBeLessThan(0.5);
      }
    }
  });

  it('emits nothing for a line that never reaches the view', () => {
    const line = equatorLine(100, 160, 400);
    expect(run(line, viewCap(-70, 0, 0.05))).toEqual([]);
  });

  it('keeps a line that sits entirely inside the view in one piece', () => {
    const line = equatorLine(-1, 1, 300);
    const segments = run(line, viewCap(0, 0, 0.6));
    expect(segments.length).toBe(1);
    expect(segments[0]!.length).toBeGreaterThan(line.length / 2);
  });

  it('reaches past the viewport edge, so a stroke does not stop short of it', () => {
    // Runs just outside the view are still emitted: a coastline has to arrive from beyond the
    // border, or every stroke would end in mid-air at the edge of the frame.
    const line = equatorLine(-20, 20, 800);
    const radius = 0.05;
    const kept = run(line, viewCap(0, 0, radius)).flat();
    const reach = Math.max(...kept.map((p) => Math.abs(p[0]!)));
    expect(reach).toBeGreaterThan((radius * 180) / Math.PI);
  });
});
