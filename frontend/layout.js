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
  const NODE_H = 56;
  const SPACING_X = 220;
  const SPACING_Y = 90;
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

  return { computeLayout, computeRoutes, NODE_W, NODE_H, SPACING_X, SPACING_Y };
});
