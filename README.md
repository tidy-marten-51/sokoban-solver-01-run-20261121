# sokoban-solver-01-run-20261121

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/tidy-marten-51/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/tidy-marten-51/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver, written for the
[sokoban-solver-01-run-20261121](https://make.fun/bounty/sokoban-solver-01-run-20261121)
bounty. It answers every instance of a set in one run, in as few pushes as
possible.

## How it works

The generated levels are a hallway plus 6-by-6 rooms, one door each, and a
box pushed out of its room can never be pushed back — so the level optimum
is the sum of its rooms' optima. The solver splits each level into rooms
and solves every room push-optimally, then walks the player on.

Each room is solved with A* over pushes: a state is the boxes' squares plus
the player's reachable region (named by its lowest square), one push costs
1, and the estimate is the cheapest assignment of boxes to goals by
shortest-path distance. Two sound prunings keep the search small: dead
squares (no pull-back path from any goal reaches them) and frozen 2-by-2
blocks of walls and boxes with a box off its goal. When A* runs out of its
work budget, a greedy best-first search on the same estimate still finds a
valid solution for the room instead of none.

Everything is budgeted by work, never by the clock, so two runs write
identical bytes.

## Practice score

1,000,000 of 1,000,000 on the kit's practice set (all 5 instances solved in
their push-optimal counts: 13, 16, 29, 47, 60 pushes), in about 0.3s — and
the same full score on 6 further sets drawn from the published generator
with fresh seeds.

## Run it

```sh
node main.ts
```

It reads `/input/<id>/level.txt` (or `$MAKEFUN_INPUT_DIR`) and writes
`/output/<id>/solution.txt` (or `$MAKEFUN_OUTPUT_DIR`), one line of `u`,
`d`, `l`, `r` moves per instance.
