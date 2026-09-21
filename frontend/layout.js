// Automatic graph layout, shared by the server (import/export) and the
// browser (rendering trees in "auto" mode).
//
// This file lives in frontend/ so the browser can load it with a plain
// <script> tag, and the backend requires it directly from there. Keeping it
// in one place matters: if the importer and the renderer computed layouts
// differently, an imported tree would jump the moment it was displayed.

(function (global, factory) {
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory(); // Node
  } else {
    global.SkillTreeLayout = factory(); // browser
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const NODE_W = 170;
  // Tall enough for three wrapped lines of the skill name plus the count
  // line underneath. Names used to be cut at 22 characters, which on a real
  // tree meant almost every node showed an ellipsis instead of what it was —
  // 105 of the 127 in the physics example. Three lines at this width hold
  // about 60 characters, which covers every name anyone has written here.
  const NODE_H = 84;
  const SPACING_X = 220;
  // Kept at NODE_H plus the 34px gap the layout has always left between rows.
  const SPACING_Y = 118;
  const ORDER_PASSES = 8;
  // Pair comparisons the crossing-minimisation may spend on one graph.
  //
  // Counting crossings between two columns is quadratic in the edges crossing
  // that gap, and the ordering passes ask for a count once per adjacent pair,
  // per column, per guard iteration. The total climbs steeply with the size
  // of the tree: measured on skill-tree-shaped graphs, 30 skills cost under a
  // million comparisons, 100 skills 41 million, 150 skills 138 million, and
  // 250 skills 888 million — five seconds of solid CPU. In the browser that
  // is a frozen tab; on the server it is the single thread that answers every
  // request, so one imported tree could stop the site serving anyone at all.
  //
  // So the ordering gets an allowance rather than a blank cheque. Below it
  // nothing changes: every tree up to about a hundred skills is ordered
  // exactly as it always was, and the example trees spend under forty
  // comparisons. Above it the ordering stops early and the graph is drawn
  // with the order it had reached — more crossings than the search would
  // eventually have found, but a drawing, in bounded time, rather than a
  // hung page or a hung server.
  const ORDER_BUDGET = 50000000;

  // Placeholder rows the lane pass may reserve for one graph.
  //
  // A lane is created for every column an edge skips, so the count follows
  // the total span of the edges, not the number of skills or links — which
  // is why a tree well inside the validator's limits can still ask for
  // millions of them. A 1000-skill chain with 4001 long-range links measures
  // 3.7 million lanes and two minutes of work, most of it allocation that
  // ORDER_BUDGET never sees, because that budget prices crossing counts and
  // nothing else. For scale on the other side: the example trees use one and
  // two lanes, and a 250-skill tree about 312.
  //
  // Past the cap an edge simply gets no reserved row and is drawn straight,
  // the way every edge was before lanes existed — it may cross whatever lies
  // between its ends, which on a graph this size it was going to do anyway.
  const MAX_LANES = 20000;

  // Left-to-right layered layout.
  //
  //   nodes: [{ id }]           - any comparable id (number or string)
  //   edges: [{ from, to }]     - `from` is the prerequisite, `to` depends on it
  //
  // A node's column is the longest path from any root, which guarantees every
  // node sits strictly to the right of all of its prerequisites. Within a
  // column, nodes are ordered to avoid edges crossing each other.
  //
  // Returns { positions, routes }:
  //   positions - Map of id -> { x, y }
  //   routes    - Map of edge index -> [{ x, y }], the waypoints an edge has
  //               to pass through to clear the columns it skips over. Empty
  //               for edges between neighbouring columns, which are straight.
  //
  // Crossings are minimised, not abolished: plenty of graphs cannot be drawn
  // in layers without any, so this gets to zero where zero is reachable and
  // as close as it can otherwise.
  function computeRoutes(nodes, edges) {
    const ids = nodes.map((n) => n.id);
    const known = new Set(ids);

    const prereqs = new Map(ids.map((id) => [id, []]));
    for (const edge of edges) {
      if (known.has(edge.to) && known.has(edge.from)) prereqs.get(edge.to).push(edge.from);
    }

    // ---- 1. columns ----

    const depthCache = new Map();
    const depthOf = (id, seen) => {
      if (depthCache.has(id)) return depthCache.get(id);
      // `seen` guards against cycles. Validated trees never have them, but
      // this also runs on live editing state, which can lag behind.
      if (seen.has(id)) return 0;
      seen.add(id);
      const parents = prereqs.get(id) || [];
      const depth = parents.length === 0
        ? 0
        : 1 + Math.max(...parents.map((p) => depthOf(p, seen)));
      seen.delete(id);
      depthCache.set(id, depth);
      return depth;
    };

    const columns = [];
    for (const id of ids) {
      const d = depthOf(id, new Set());
      while (columns.length <= d) columns.push([]);
      columns[d].push(id);
    }

    // ---- 2. lanes for edges that skip a column ----
    //
    // An edge from column 0 to column 3 would otherwise be drawn straight
    // across whatever happens to sit in columns 1 and 2. Giving it a
    // placeholder in every column it crosses reserves an empty row for it to
    // pass through, and lets the ordering pass below treat a long edge as an
    // ordinary chain of short ones.

    const lanes = new Set(); // placeholder keys; they get no final position
    const next = new Map(); // key -> keys one column to the right
    const prev = new Map(); // key -> keys one column to the left
    const link = (from, to) => {
      if (!next.has(from)) next.set(from, []);
      if (!prev.has(to)) prev.set(to, []);
      next.get(from).push(to);
      prev.get(to).push(from);
    };

    const laneChains = new Map(); // edge index -> lane keys, left to right
    let laneCount = 0;
    edges.forEach((edge, index) => {
      if (!known.has(edge.from) || !known.has(edge.to)) return;
      const from = depthCache.get(edge.from);
      const to = depthCache.get(edge.to);
      if (!(to > from)) return; // only reachable on a cycle; nothing to route
      // Out of lanes: leave this edge unrouted and unlinked. Linking it
      // across columns it skips would feed the ordering pass positions from
      // a column it cannot compare against, which is worse than leaving the
      // edge out of a decision it can no longer usefully inform.
      if (laneCount + (to - from - 1) > MAX_LANES) return;

      const chain = [];
      let tail = edge.from;
      for (let d = from + 1; d < to; d++) {
        const lane = ` lane${laneCount++}`;
        lanes.add(lane);
        columns[d].push(lane);
        link(tail, lane);
        chain.push(lane);
        tail = lane;
      }
      link(tail, edge.to);
      if (chain.length) laneChains.set(index, chain);
    });

    // ---- 3. ordering within each column ----

    const indexed = () => {
      const pos = new Map();
      for (const column of columns) column.forEach((key, i) => pos.set(key, i));
      return pos;
    };

    // Reordering one column moves only that column's indices, so the sweeps
    // below patch those rather than rebuilding the whole map: same contents,
    // and the bookkeeping stops growing with the number of columns.
    const reindex = (pos, column) => column.forEach((key, i) => pos.set(key, i));

    // Median of a node's neighbours in the adjacent column. Median rather than
    // mean: one far-off neighbour shouldn't drag a node past everything else.
    const medianOf = (key, neighbours, pos, fallback) => {
      const list = (neighbours.get(key) || [])
        .map((n) => pos.get(n))
        .filter((v) => v !== undefined)
        .sort((a, b) => a - b);
      if (list.length === 0) return fallback; // nothing to line up with: stay put
      const mid = list.length >> 1;
      return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
    };

    const reordered = (column, neighbours, pos) =>
      column
        .map((key, i) => ({ key, i, m: medianOf(key, neighbours, pos, i) }))
        .sort((a, b) => a.m - b.m || a.i - b.i) // ties keep the order they had
        .map((entry) => entry.key);

    // How many edges cross each gap between two columns. Ordering changes
    // the order inside a column, never which keys are in it, so every count
    // below would arrive at the same number: it is worked out once here.
    const bandWidths = [];
    for (let d = 0; d + 1 < columns.length; d++) {
      let width = 0;
      for (const key of columns[d]) width += (next.get(key) || []).length;
      bandWidths.push(width);
    }

    // Crossings between column d and the next: two edges cross exactly when
    // their endpoints sit in opposite order.
    let spent = 0;
    const crossingsBetween = (d) => {
      // Price the count before building anything for it. Assembling the edge
      // list is itself O(edges), and transpose() asks for this hundreds of
      // times, so a check that came after the list would leave the runaway in
      // place.
      const width = bandWidths[d];
      spent += (width * (width - 1)) / 2;
      // Out of budget: Infinity reads as "no improvement I can see", so
      // transpose() puts its trial swap back and the pass loop keeps the best
      // ordering it already had. The charge depends only on the graph, so the
      // browser and the importer still agree on the layout they produce.
      if (spent > ORDER_BUDGET) return Infinity;

      const left = columns[d];
      const right = columns[d + 1];
      const rightIndex = new Map(right.map((key, i) => [key, i]));
      const segments = [];
      left.forEach((key, i) => {
        for (const target of next.get(key) || []) {
          const j = rightIndex.get(target);
          if (j !== undefined) segments.push([i, j]);
        }
      });
      let total = 0;
      for (let a = 0; a < segments.length; a++) {
        for (let b = a + 1; b < segments.length; b++) {
          if ((segments[a][0] - segments[b][0]) * (segments[a][1] - segments[b][1]) < 0) total++;
        }
      }
      return total;
    };

    const countCrossings = () => {
      let total = 0;
      for (let d = 0; d + 1 < columns.length; d++) total += crossingsBetween(d);
      return total;
    };

    // Crossings a column is responsible for, counting both of its sides.
    const localCrossings = (d) =>
      (d > 0 ? crossingsBetween(d - 1) : 0) +
      (d + 1 < columns.length ? crossingsBetween(d) : 0);

    // Medians get the ordering roughly right but stall in local minima, which
    // is how a graph that could be drawn cleanly ends up with a stray crossing.
    // Swapping neighbours whenever it helps clears those out.
    const transpose = () => {
      for (let guard = 0; guard < 16; guard++) {
        let improved = false;
        for (let d = 0; d < columns.length; d++) {
          const column = columns[d];
          for (let i = 0; i + 1 < column.length; i++) {
            const before = localCrossings(d);
            [column[i], column[i + 1]] = [column[i + 1], column[i]];
            if (localCrossings(d) < before) improved = true;
            else [column[i], column[i + 1]] = [column[i + 1], column[i]]; // no better: put it back
          }
        }
        if (!improved) return;
      }
    };

    // Sweep right, then left, then swap neighbours, keeping whichever ordering
    // crossed least. Each step is a local improvement, so an early pass can
    // beat a later one.
    transpose();
    let best = columns.map((column) => column.slice());
    let bestCrossings = countCrossings();

    for (let pass = 0; pass < ORDER_PASSES && bestCrossings > 0; pass++) {
      const pos = indexed();
      for (let d = 1; d < columns.length; d++) {
        columns[d] = reordered(columns[d], prev, pos);
        reindex(pos, columns[d]);
      }
      for (let d = columns.length - 2; d >= 0; d--) {
        columns[d] = reordered(columns[d], next, pos);
        reindex(pos, columns[d]);
      }
      transpose();

      const crossings = countCrossings();
      if (crossings < bestCrossings) {
        bestCrossings = crossings;
        best = columns.map((column) => column.slice());
      }
    }

    // ---- 4. positions ----

    const positions = new Map();
    const lanePoints = new Map();
    best.forEach((column, depth) => {
      column.forEach((key, i) => {
        const x = depth * SPACING_X;
        const y = Math.round((i - (column.length - 1) / 2) * SPACING_Y);
        if (lanes.has(key)) {
          // The reserved row, entered and left at the same x as the node boxes
          // either side of it. Spanning the column (rather than pinching to a
          // single point in the middle of it) keeps every gap between two
          // columns a clean band, where edges cross only if their order does.
          lanePoints.set(key, [
            { x, y: y + NODE_H / 2 },
            { x: x + NODE_W, y: y + NODE_H / 2 },
          ]);
        } else {
          positions.set(key, { x, y });
        }
      });
    });

    const routes = new Map();
    for (const [index, chain] of laneChains) {
      routes.set(index, chain.flatMap((lane) => lanePoints.get(lane)));
    }
    return { positions, routes };
  }

  // Positions only. The backend imports/exports coordinates and has no use for
  // edge routing, so it stays on this narrower signature.
  function computeLayout(nodes, edges) {
    return computeRoutes(nodes, edges).positions;
  }

  // ---- the shape of a drawn edge ----

  // An edge leaves the right of one box and arrives at the left of another,
  // and the control points sit level with each end so it departs and lands
  // flat. How far they reach along x decides how the line looks: too little
  // and it hooks tightly against the boxes, too much and it flattens into a
  // shelf.
  //
  // Half the run is the natural choice, and it is what this used to do — but
  // when two nodes sit close together with a big drop between them, half of
  // a short run is a couple of pixels and the line kinks at both ends. So the
  // reach has a floor, and is capped at the run itself: keeping it within the
  // gap is what lets the reserved rows and the detours promise the clearance
  // they do, since the curve then never strays outside the x it was given.
  const CURVE_MIN_REACH = 36;

  function controlPoints(a, b) {
    const run = Math.abs(b.x - a.x);
    const direction = b.x < a.x ? -1 : 1;
    const reach = Math.min(run, Math.max(run / 2, CURVE_MIN_REACH));
    return [a.x + direction * reach, b.x - direction * reach];
  }

  // The path an edge is drawn along, shared by every renderer so the shape
  // tested for clearance above is the shape that reaches the screen.
  function edgeCurve(points) {
    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 0; i + 1 < points.length; i++) {
      const from = points[i];
      const to = points[i + 1];
      const [c1x, c2x] = controlPoints(from, to);
      d += ` C ${c1x} ${from.y}, ${c2x} ${to.y}, ${to.x} ${to.y}`;
    }
    return d;
  }

  // ---- routing for coordinates this file did not choose ----

  // How far a detour keeps away from the box it is avoiding.
  const CLEARANCE = 14;
  // Curve samples per segment when testing whether a path enters a box. The
  // drawn edge is a cubic whose control points share their y with the ends,
  // so it can sag away from the straight chord — testing the chord alone
  // would miss a box the visible line actually crosses.
  const CURVE_SAMPLES = 24;
  // Box tests one call may spend. This runs on every render, and a render is
  // what a drag pays for each frame, so the ceiling is set by what fits in a
  // frame rather than by how much routing a graph could use: measured, 400k
  // tests cost about 60 ms on a 1000-skill tree, and this keeps the worst
  // case near 15 ms. Past it the remaining edges keep the line they had.
  const ROUTE_BUDGET = 100000;

  function curveEntersBox(a, b, box) {
    const [c1x, c2x] = controlPoints(a, b);
    for (let s = 0; s <= CURVE_SAMPLES; s++) {
      const t = s / CURVE_SAMPLES;
      const u = 1 - t;
      const x = u * u * u * a.x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * b.x;
      const y = u * u * u * a.y + 3 * u * u * t * a.y + 3 * u * t * t * b.y + t * t * t * b.y;
      if (x > box.x1 && x < box.x2 && y > box.y1 && y < box.y2) return true;
    }
    return false;
  }

  // Waypoints that steer each edge around any node box standing in its way.
  //
  // computeRoutes only has to think about this for edges that skip a column,
  // because it chose the coordinates and put every node in a row — but a tree
  // stored as 'manual' carries whatever positions its author dragged things
  // to, and nothing there keeps a box out of a line's path. This walks the
  // obstacles an edge would cross from left to right and lifts the line over
  // or drops it under each one, whichever is nearer to where the line was
  // already going.
  //
  //   positions: Map of id -> { x, y }, the top-left of each node box
  //   edges:     [{ from, to }] in the order they will be drawn
  //
  // Returns a Map of edge index -> waypoints, in the same shape computeRoutes
  // returns, so a renderer can use the two interchangeably. Edges with a
  // clear run get no entry and stay the single smooth curve they were.
  function routeAroundNodes(positions, edges) {
    const routes = new Map();
    if (!positions || !edges) return routes;

    const boxes = [];
    for (const [id, p] of positions) {
      boxes.push({ id, x1: p.x, y1: p.y, x2: p.x + NODE_W, y2: p.y + NODE_H });
    }
    boxes.sort((a, b) => a.x1 - b.x1);

    let spent = 0;
    edges.forEach((edge, index) => {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) return;

      const start = { x: from.x + NODE_W, y: from.y + NODE_H / 2 };
      const end = { x: to.x, y: to.y + NODE_H / 2 };
      if (end.x === start.x) return; // nothing to travel along

      // Edges are not all left-to-right. A tree stored as 'manual' can put a
      // prerequisite to the right of the skill it unlocks, and those
      // backwards edges are the long ones that sweep across the drawing and
      // meet the most in their way — so the detour is built in whichever
      // direction this edge actually travels.
      const step = end.x > start.x ? 1 : -1;
      const lo = Math.min(start.x, end.x) + 1;
      const hi = Math.max(start.x, end.x) - 1;
      const clampToRun = (x) => Math.min(Math.max(x, lo), hi);

      // Everything in the way is treated as one obstruction, and the line is
      // taken over or under the whole of it in a single lift.
      //
      // Dodging one box at a time is what fails here: stepping under one node
      // drops the line into the next, and by then the way around that one is
      // already behind the pen. Growing a single group and re-checking the
      // whole path against it converges instead of zigzagging — and it looks
      // like the reserved rows an automatic layout produces, rather than a
      // line picking its way between boxes.
      const cluster = new Map();
      let waypoints = [];

      for (let attempt = 0; attempt < 4; attempt++) {
        const path = [start, ...waypoints, end];
        let grew = false;
        for (let i = 0; i + 1 < path.length && spent <= ROUTE_BUDGET; i++) {
          for (const box of boxes) {
            if (box.id === edge.from || box.id === edge.to) continue;
            if (spent > ROUTE_BUDGET) break;
            spent++;
            if (!curveEntersBox(path[i], path[i + 1], box)) continue;
            if (!cluster.has(box.id)) {
              cluster.set(box.id, box);
              grew = true;
            }
          }
        }
        if (!grew) break;

        const group = [...cluster.values()];
        let minX = Infinity, maxX = -Infinity, topY = Infinity, bottomY = -Infinity;
        for (const b of group) {
          if (b.x1 < minX) minX = b.x1;
          if (b.x2 > maxX) maxX = b.x2;
          if (b.y1 < topY) topY = b.y1;
          if (b.y2 > bottomY) bottomY = b.y2;
        }

        // The plateau starts a clearance before the group and ends a
        // clearance after it, so the climb and the descent both happen in
        // open space rather than alongside a box.
        const nearX = step > 0 ? minX - CLEARANCE : maxX + CLEARANCE;
        const farX = step > 0 ? maxX + CLEARANCE : minX - CLEARANCE;
        const withinRun = (x) => (x - start.x) * step > 0 && (end.x - x) * step > 0;
        if (!withinRun(farX)) {
          // No far side to come down on: the group reaches past the end of
          // this edge, so there is nothing to get around. Leave the line as
          // it was rather than inventing a worse path for it.
          waypoints = [];
          break;
        }

        // Over or under is not obvious from the geometry — the shorter lift
        // often runs straight into whatever is stacked on that side. So both
        // are drawn and the one that ends up crossing fewer boxes wins, with
        // the smaller deviation breaking a tie.
        const candidates = [topY - CLEARANCE, bottomY + CLEARANCE].map((candidateY) => {
          const route = [{ x: nearX, y: candidateY }, { x: farX, y: candidateY }];
          const path = [start, ...route, end];
          let crossings = 0;
          for (let i = 0; i + 1 < path.length && spent <= ROUTE_BUDGET; i++) {
            for (const box of boxes) {
              if (box.id === edge.from || box.id === edge.to) continue;
              if (spent > ROUTE_BUDGET) break;
              spent++;
              if (curveEntersBox(path[i], path[i + 1], box)) crossings++;
            }
          }
          const middle = (start.y + end.y) / 2;
          return { route, crossings, deviation: Math.abs(middle - candidateY) };
        });
        candidates.sort((a, b) => a.crossings - b.crossings || a.deviation - b.deviation);
        waypoints = candidates[0].route;
        if (candidates[0].crossings === 0) break;
      }

      if (waypoints.length) routes.set(index, waypoints);
    });

    return routes;
  }

  return {
    computeLayout,
    computeRoutes,
    routeAroundNodes,
    edgeCurve,
    controlPoints,
    NODE_W,
    NODE_H,
    SPACING_X,
    SPACING_Y,
  };
});
