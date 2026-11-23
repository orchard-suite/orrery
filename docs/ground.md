# The ground

The ground is the view under the sky: where the catalog says what there is,
the ground says how it is doing. It is drawn as an atlas you walk down, one
grain a level. It is in preview: an admin opens it on the Access page.

Every level works the same way.

- The picture is the stage and fills the window.
- A panel on the right holds the verdict in one sentence, one bar with its
  three counts (broken, no data, holding), one ranked list, and what you can
  do. It explains nothing: this page does.
- A small key sits in a corner of the picture, in the picture's own marks.
  The **?** beside it opens the whole key and replays the first-visit tour.
- Point at a mark and a card reads it aloud. Click it and a peek opens at the
  top of the panel. Escape, or a click on empty ground, closes it.
- A peek leads with what to fix. Each broken check says what is missing, the
  level it holds the thing below ("for Silver"), and, where its record says,
  what to do and a link to the record. Where a scorecard copies another
  tool's verdict, its gaps take the place of its tier rules, so one missing
  thing counts once. A level that falls short with no record you may see says
  "No reason given".
- The lens, at the picture's upper left, makes the whole level ask about one
  check alone. **Every check** puts it back.
- No data is never drawn as healthy.

## The words

| On the page | What it is in the model |
| --- | --- |
| Planet | An entity a map is drawn of, such as a program |
| Continent | A place its things run, such as an environment |
| Garden | A plot: one thing the planet holds, such as a service or a team, and what it has on one continent |
| Patch of open ground | One region's things of one kind on a continent that no garden claims |
| The workshop | Everything tied to no continent |
| Region | A part: a program that names this one as its parent |
| Ladder | A scorecard, its levels the rungs; a budget or a guard is a ladder of one rung |
| Flower, petal | On a continent, one garden or patch, a petal a ladder; in a garden, one thing |
| The walk, a stop | The climbs that mend the most, and the ones you put on your own walk |
| Bed | One entity on a kind's ground |

## The sky: `/ground`

One body for each planet. Its distance from the sun is its share of broken
checks: the fewer, the nearer. The rings are bands a reader can name: clear, a
few broken (under 20%), many broken (20 to 50%), storm (half or more), and not
judged (every check without data). A band is as wide as the bodies in it need.

- The ring round a body is its checks: red broken, grey no data, green
  holding.
- A large body is a primary planet (the model's `map.primary`), one of yours,
  or one you pinned. Every other is a small dot; a red glow marks one in a
  storm. Where the model names no primary, every body is as big as what its
  map holds.
- A body's bearing is its sector (the model's `map.sector`) and never moves.
  Only its distance changes with its health.
- Primaries, pins, and search matches carry a name. Any other names itself
  when you point at it.
- A body that holds nothing, or that nothing checks, is not drawn. The panel
  counts them.
- Type in the search box to find one; Enter opens the first match. **Mine**
  keeps to your own, where the estate says what a person owns.
- A click peeks. A double click, or Enter, opens the planet.
- **By kind** lists each kind that has a ground, with how many are outside a
  budget.

## A planet: `/map/<blueprint>/<key>`

The globe shows where. Each continent is as big as what runs on it. On it,
each cell is one garden, or one patch of open ground. A cell's colour is the
share of broken checks of what sits there:

- red: half or more broken
- dark red: some broken
- hatched: none broken, some without data
- green: every check holds
- dark and dotted: nothing checks it

A hedged cell is a garden; a dashed one is a patch. The number on a continent
is its broken checks. Pointing at a garden joins its copies on the other
continents. A click keeps that: the cell you opened stays marked in blue, and
its garden stays joined to its copies, until you close it. A garden's own
square on the bench picks the same garden: pointed at or opened there, its
cells on the globe light and join one another. A garden's peek names each side
of it, its own checks and each continent it grows on, and a click moves
between them.

**Where** ranks the continents and the workshop by broken checks. They add up
to the planet's total, each check counted once. **Fix first** ranks what to
do across the whole planet: each fix once, with how many things it holds
back. Pointing at one lights every cell it touches; a click lists the things,
each opening its own peek. **Tend first** ranks gardens
and patches together: a garden over every continent it runs on, a patch on its
one continent. **Regions** are chips. On each continent a region's cells lie
together as one cluster. Pick a chip and one line runs round the region on
every continent it reaches, while the rest stands back. A cell of another
region that holds some of its things wears a dashed edge.

## The workshop: `/map/<blueprint>/<key>?nowhere`

What is tied to no continent: things on no place, and the checks that are a
garden's own wherever it grows. For a service, its own checks are about its
code; for a team, about the team itself. It is the bench beside the globe: a
hedged square each garden, for its own checks, and a dashed square each kind
of thing on no place, as on the globe. Opened, it is a meadow like a
continent's, with its own walk: a flower each kind of thing on no place, and
one each garden for the checks that are its own.

## A continent: `/map/<blueprint>/<key>?at=<place>`

A meadow, with the walk under it.

**Ladders.** Every check climbs a ladder. A scorecard is a ladder, its levels
the rungs: Bronze, Silver, Gold. A thing stands on the highest rung it holds
with every rung below it held. A budget or a guard is a ladder of one rung.

**The meadow.** One flower is one garden, or one patch of open ground. Each
ladder is a slice of the flower, always at the same bearing: the first
straight up, the rest round clockwise. In a slice, a petal is as wide as its
share of the things and as long as the rung they reached.

- full and green: at the top
- short and red: stopped by a broken check
- grey and dashed: stopped by a check with no data, never read as holding
- gold dashes: what your walk grows to the top

A flower is as big as what it holds. The ten worst carry their rank. Beds with
nothing broken stand smaller after them, a garden of one thing in full bloom
is a small flower by its name, and what nothing checks is named last.

**The walk.** Each stop is a climb: the things standing on the same rung of
one ladder, stopped there by a broken check. Taking them to the top mends the
number it shows. The stop that mends the most comes first. A stop says what
comes into full bloom when it is done. The meadow stays at the top while the
walk scrolls under it. Point at a stop, or press its name to hold it, and the
meadow rings in gold every bed it grows, while **Growth** in the panel says
the stage it reaches and what it leaves broken. Nothing moves when you point.
A thing stopped by no data is in no stop: it needs its data first.

**Your walk.** Add a stop and it is kept for you, on every device. The panel
says what is left broken once your walk is done, and each stop's progress: how
many of the things it named stand at the top now. A stop is walked when all of
them do. **Growth** counts the things in full bloom, at the top of every
ladder, and names the stage: bare, sprouting (a quarter), budding (half),
blooming (three quarters), full bloom (all). Gold shows the stage your walk
reaches.

A continent counts only the things on it: a garden's own checks are the
workshop's.

## A garden: `…?at=<place>&plot=<key>`

One garden on one continent, or one kind of thing on its open ground
(`…&kind=<blueprint>`), as a plate of specimens. One flower is one thing,
numbered as the panel numbers it, a petal a ladder, the ghost of a full petal
behind it; a stub is a ladder that does not read it. Under it: its name, what
stops it next, and its rungs, one row of dots a ladder. The walk here, in the
panel, climbs inside this garden alone. The chips above the plate are the same
garden on its other continents.

## A kind's ground: `/ground/<blueprint>`

Every entity of one kind as a cell of land. An island is the folder its keys
share. With the lens on **Every check**, a cell outside any budget stands in a
storm, one inside every budget lies calm, and one with no number lies in fog.
Pick one budget and the map, the counts, and the rounds follow it alone.

**The rounds** are where to go first: what got worse this week, then what is
furthest outside. They are the gold route on the map. Where a number keeps
its past, the panel and each island say how many got better or worse since
last week.

A click opens a peek. From it, an entity's own page is its bed.

## A bed: `/ground/<blueprint>/<key>`

One entity, read for what to fix first. It says everything plainly: no
garden words, no formulas.

- **To fix** heads the page with how many there are, one card each, and
  each card says where to go. A page with none says so under its name.
  - A thing behind a number out of line, such as the red pipeline behind
    Red pipelines: its name, which opens it in the catalog, why it is
    failing in its own words, its own links (its last run, its page), and
    one short line on the number it moves ("Why Red pipelines is 1."). A
    thing that moves several numbers is one card.
  - A thing that gives the entity's own status, though it moves no number
    out of line, such as a flaky pipeline.
  - A number out of line with no one thing behind it, such as a count the
    source sends or a number under its least: its value, what it should be,
    and its description.
  - A check that does not hold.
  - A reason for the entity's own status that no card above already gives.

  A grey entity is not judged, so its reasons are nothing to fix. The last
  three are about the entity itself, so they link to its own addresses.
- **Numbers** lists the numbers no card names, each with its value. A number
  with no value and no goal is left out. One worked out from related things
  folds open ("Show the 1 pipeline") to its description and the things
  behind it: for a count, what it counted; for a highest or a lowest, each
  with its value, the one that sets it in bold. You see only what you may
  see, so the lines may add up to less than the number.
- **Checks** answer Yes or Unknown; one that says No is a card above.
  **Details**, the seed it started from, and what it copied its patterns
  from stand beside and under them.

## Acting on several

A tick box stands only on a thing you may run an action on: in its peek and
on its row. Tick several and a tray offers the actions every one of them
shares. Each gets its own run. Where you may act on nothing, there is no box
and no tray.

## Setting it up

`docs/modelling.md` says how a model names a ground (`ground`, and `budget`
on a number field) and a map (`map`, with `primary` and `sector`).
