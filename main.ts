// Sokoban solver for make.fun sokoban-solver-01-run-20261121.
//
// The levels are a hallway plus 6-by-6 rooms, one door each: a box pushed out
// of its room through the door can never be pushed back, so the level optimum
// is the sum of its rooms' optima. This solver splits each level into rooms
// and solves every room push-optimally, then walks the player on.
//
// Each room is solved with A* over pushes: a state is the boxes' squares plus
// the player's reachable region (named by its lowest square), one push costs
// 1, and the estimate is the cheapest assignment of boxes to goals by
// shortest-path distance (each push moves one box one square, so the estimate
// never overstates the pushes left). Two sound prunings keep the search
// small: a dead square (no pull-back path from any goal reaches it) and a
// frozen 2-by-2 block of walls and boxes with a box off its goal. When A*
// runs out of its work budget, a greedy best-first search on the same
// estimate still finds a valid solution for the room instead of none.
//
// Everything is budgeted by work, never by the clock, and every tie breaks
// by a fixed order, so two runs of the program write identical bytes.
// Node 22 runs this file directly (erasable TypeScript syntax only).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// [dx, dy, step letter, push letter], in the order ties break.
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

// Work budgets, counted in expanded states across the whole set.
const ASTAR_BUDGET = 250_000;
const GREEDY_BUDGET = 250_000;
const WHOLE_BUDGET = 200_000;
const GLOBAL_BUDGET = 2_000_000;
let spent = 0;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
}

/** A level in XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal). */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is a wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/** The squares a box alone can be pushed from onto some goal (pulled back from the goals over open floor). */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue: number[] = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Shortest-path distances from one goal over open floor, ignoring boxes (-1 where unreachable). */
function distancesFrom(level: Level, goal: number): Int32Array {
  const { w, wall } = level;
  const dist = new Int32Array(wall.length).fill(-1);
  const queue: number[] = [goal];
  dist[goal] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const q = p + dy * w + dx;
      if (!wall[q] && dist[q] < 0) {
        dist[q] = dist[p]! + 1;
        queue.push(q);
      }
    }
  }
  return dist;
}

/**
 * The cheapest assignment of boxes to goals by shortest-path distance, or
 * Infinity when some box reaches no goal. Admissible: one push moves one box
 * one square, so the pushes still owed are at least the sum of the boxes'
 * distances to the goals they end on.
 */
function assignmentEstimate(boxes: number[], goals: number[], dist: Int32Array[]): number {
  const n = boxes.length;
  if (n === 0) return 0;
  if (n > 6) {
    // Too many boxes to permute: the sum of each box's nearest goal still bounds the pushes owed.
    let total = 0;
    for (const b of boxes) {
      let best = Infinity;
      for (let gi = 0; gi < goals.length; gi++) {
        const d = dist[gi]![b]!;
        if (d >= 0 && d < best) best = d;
      }
      if (best === Infinity) return Infinity;
      total += best;
    }
    return total;
  }
  let best = Infinity;
  const used = new Uint8Array(goals.length);
  const pick = (bi: number, total: number): void => {
    if (total >= best) return;
    if (bi === n) {
      best = total;
      return;
    }
    for (let gi = 0; gi < goals.length; gi++) {
      if (used[gi]) continue;
      const d = dist[gi]![boxes[bi]!]!;
      if (d < 0) continue;
      used[gi] = 1;
      pick(bi + 1, total + d);
      used[gi] = 0;
    }
  };
  pick(0, 0);
  return best;
}

/** The squares the player reaches from `from` with `occupied` in the way; returns the lowest square reached. */
function reach(level: Level, occupied: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2-by-2 block of walls and boxes with a box off its goal. */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes (lower LURD letters), or null when unreachable. */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string | null {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/**
 * A push-optimal solution of `level` (A*, `astar` true) or a valid one found
 * greedily (`astar` false), searching at most `maxExpansions` states:
 * {pushes, moves}, or null when the search gives up.
 */
function solveSearch(level: Level, maxExpansions: number, astar: boolean): { pushes: number; moves: string } | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const dist = goals.map((g) => distancesFrom(level, g));
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (level.boxes.some((b) => !live[b])) return null;
  if (solved(level.boxes)) return { pushes: 0, moves: '' };

  const keyOf = (boxes: number[], low: number): string => low + ':' + boxes.join(',');
  // The states in the order found: boxes, player square, parent, the push that made them, pushes so far, and the
  // lowest square of the player's reachable region (part of the state's key, so a stale heap entry can be spotted).
  const sBoxes: number[][] = [level.boxes];
  const sPlayer: number[] = [level.player];
  const sParent: number[] = [-1];
  const sFrom: number[] = [-1];
  const sTo: number[] = [-1];
  const sG: number[] = [0];
  const sLow: number[] = [];
  const best = new Map<string, number>();
  for (const b of level.boxes) occupied[b] = 1;
  const low0 = reach(level, occupied, level.player, seen, ++stamp, stack);
  sLow.push(low0);
  best.set(keyOf(level.boxes, low0), 0);
  for (const b of level.boxes) occupied[b] = 0;

  // A heap on [f, h, sequence, state]: f = pushes + estimate (A*) or the estimate alone (greedy).
  const heap: [number, number, number, number][] = [];
  let seq = 0;
  const h0 = assignmentEstimate(level.boxes, goals, dist);
  if (h0 === Infinity) return null;
  heap.push([astar ? h0 : h0, h0, seq++, 0]);
  const less = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  let expanded = 0;
  let found = -1;
  while (heap.length > 0 && expanded < maxExpansions && spent < GLOBAL_BUDGET) {
    const [, , , s] = heapPop();
    const boxes = sBoxes[s]!;
    const g = sG[s]!;
    // A stale heap entry (a cheaper path to this state was found since) is skipped, never expanded: without this,
    // A* could return a solved state through a costlier path than the best one known.
    if (best.get(keyOf(boxes, sLow[s]!)) !== g) continue;
    if (solved(boxes)) {
      found = s;
      break;
    }
    for (const b of boxes) occupied[b] = 1;
    reach(level, occupied, sPlayer[s]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        if (frozenBlock(level, occupied, goal, t)) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        const next = boxes.slice();
        next[bi] = t;
        next.sort((a, b2) => a - b2);
        const h = assignmentEstimate(next, goals, dist);
        let key = '';
        let low = -1;
        if (h !== Infinity) {
          low = reach(level, occupied, b, mark, ++stamp, stack);
          key = keyOf(next, low);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (h === Infinity) continue;
        const prevG = best.get(key);
        if (prevG !== undefined && prevG <= g + 1) continue;
        best.set(key, g + 1);
        const idx = sBoxes.length;
        sBoxes.push(next);
        sPlayer.push(b);
        sParent.push(s);
        sFrom.push(b);
        sTo.push(t);
        sG.push(g + 1);
        sLow.push(low);
        heapPush([astar ? g + 1 + h : h, h, seq++, idx]);
      }
    }
    for (const b of boxes) occupied[b] = 0;
    expanded++;
    spent++;
  }
  if (found < 0) return null;
  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const nextBoxes = sBoxes[s]!;
    const from = boxes.find((b) => !nextBoxes.includes(b))!;
    const to = nextBoxes.find((b) => !boxes.includes(b))!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    const walk = walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    if (walk === null) return null;
    moves += walk + dir[3];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that
 * holds a box is a room. Null when some part holds more or fewer boxes than
 * goals, or a box starts in the hallway: then the level is no set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares: number[] = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The level solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room
 * is done), the player walking on from where the last room left it.
 */
function solveByRooms(level: Level): { pushes: number; moves: string } | null {
  const rooms = roomsOf(level);
  if (rooms === null) return null;
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solveSearch(sub, ASTAR_BUDGET, true) ?? solveSearch(sub, GREEDY_BUDGET, false);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/** The moves for a level in XSB, or '' when no solution is found (a valid, scoreless answer). */
function solve(text: string): string {
  const level = parseLevel(text);
  if (level.boxes.every((b) => level.goals.includes(b))) return '';
  const byRooms = solveByRooms(level);
  if (byRooms !== null) return byRooms.moves;
  const whole = solveSearch(level, WHOLE_BUDGET, true) ?? solveSearch(level, WHOLE_BUDGET, false);
  return whole === null ? '' : whole.moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
