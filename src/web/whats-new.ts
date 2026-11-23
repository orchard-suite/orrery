// The notes on each release, written for the people who use the hub. A note
// names `after`: the release that was current when it was written, so it
// ships in the first release after that one. A person who last saw release
// R is shown every note written after R, and none they saw before.
//
// Write one for a change a person would notice, in the words they would use.
// The changelog CI writes is for the people who build the hub; this is not.

import { compareReleases } from '../shared/preferences.ts'

export interface ReleaseNote {
  /** The release that was current when the note was written. */
  after: string
  title: string
  /** Markdown. */
  text: string
}

/** Newest first. */
export const NOTES: ReleaseNote[] = [
  {
    after: '1.156.4',
    title: 'Long work no longer waits on whoever asked',
    text: 'An action can now run as a **job of its own**: one container for each run, started the moment the run is approved. Whoever asked, a person, a tool, or an agent, need not stay: come back to the run\'s page at any time for its steps, log, and outputs. While its job runs, whoever asked can **Stop it** from that page. And a run now lives by being heard from: one that keeps reporting is no longer given up after an hour, however long it takes, while one that goes silent still is.',
  },
  {
    after: '1.155.1',
    title: 'Many changes, one approval',
    text: 'An agent or a tool can now ask for many changes at once as one **change set**: each change its own action, thing, and inputs, with a title and why it was asked. You see it once in what waits for you, not as a row for each change. Its page lists every change, grouped by action and by what each sets, and one **Approve all** runs them, each as if you had approved it alone. **Reject** declines them all, and whoever asked can withdraw it before you decide. Once it ran, its page asks again for just the changes that failed.',
  },
  {
    after: '1.153.0',
    title: 'Runs wait their turn',
    text: 'An action can now say how many of its runs go at once, for a service that does one thing at a time. Approve many batches together and the rest wait as **queued**, saying they wait their turn, then start, oldest first, as each one ahead finishes. Nothing is dropped or replaced.',
  },
  {
    after: '1.152.1',
    title: 'Keys live with their source',
    text: 'Open a source on **Sources** and its keys are right there, with **New key** at the top. The key you make shows in the same panel, with **Copy**, so you never scroll to find it. Register a new source and you go straight to making its key. Keys that belong to no source, and the secrets health checks use, are their own entries in the list. The search box finds a source by name or by any of its keys.',
  },
  {
    after: '1.151.0',
    title: 'A slow action is waited for, not failed',
    text: 'An action that calls a slow service now waits up to 15 minutes for its answer, and your page no longer hangs while it does: the run shows as running. If the service still has not answered, the run says **outcome unknown** instead of failed. The service got the request and may have done the work, so check before you run it again. An unknown run never counts as a failure.',
  },
  {
    after: '1.149.2',
    title: 'Lists in a form, a row each',
    text: 'A form that asks for several values, such as hosts or web addresses, gives each one its own box. **Add another** adds a row, the cross beside a row removes it, and pasting several lines makes a row of each. An action that changes a list something holds, such as the origins an app allows, starts from that list and shows what you add and remove before you send it. Tick **This is what I want** to send it. Whoever approves it sees the same change on the run.',
  },
  {
    after: '1.149.2',
    title: 'Counts stay put in the side bar',
    text: 'The side bar is a little wider, and the page beside it starts closer to it. Point at a kind, or open one, and its count stays where it is: the star, the arrows, and the hide button appear just before it.',
  },
  {
    after: '1.147.0',
    title: 'Your own page, one click away',
    text: 'Click your name at the foot of the side bar and pick **Your page**. It opens the record that stands for you: your details, what you own, and the actions you may run. Change anything there that is open to you, where it is shown.',
  },
  {
    after: '1.147.0',
    title: 'Put your starred kinds in your own order',
    text: 'Point at a kind under **Starred** in the catalog and use its **up** and **down** arrows to move it. On a phone, the arrows sit beside each starred kind. The order is yours alone and follows you to every device.',
  },
  {
    after: '1.146.0',
    title: 'Faces instead of names alone',
    text: 'People show their profile photo wherever they appear: in tables, on their own page, on the Access page, and at the foot of the side bar, which now calls you by your name. Want an icon instead? Open your own page, click your picture, and pick one. Everyone sees what you pick. **Your photo** in that list puts your face back. Only you change your picture.',
  },
  {
    after: '1.145.0',
    title: 'Zen mode and the theme are back on top',
    text: 'The **zen mode** and **light theme** switches sit at the top of the side bar again, beside the fold. Scroll bars are thin and quiet now, and brighten only while you point at what they scroll.',
  },
  {
    after: '1.143.1',
    title: 'More room for the catalog',
    text: 'The side bar gives its room back to the catalog. **Find anything** now sits at the top right of every page. **Ground**, **Scorecards**, and **Model** are one row of tiles. The pages that run the hub are behind **Hub** at the foot. **Favorites** shows once you star something. The Findings page is gone: what needs you is on **Now**.',
  },
  {
    after: '1.141.0',
    title: 'Approve a whole batch from its line',
    text: 'A batch in the runs list says how many of its runs wait for approval, and that line opens the batch, where **Approve the waiting** approves them all at once. A run that is one of a batch links there too. A run nobody could ever approve is now refused as it is asked, saying what would let someone approve it, instead of waiting for ever.',
  },
  {
    after: '1.140.0',
    title: 'Star what you come back to',
    text: 'Star a thing with the **star** beside its name in any table, or **Star** on its page. What you starred comes first in every table of its kind, whatever you sort by, and first in each group. **Favorites** in the menu shows everything you starred, of every kind, in one table. Star a kind beside its name on its table, and it shows under **Starred** at the top of the catalog, and still in its group. Your stars are yours alone, on every device, and never change what a query or a report shows.',
  },
  {
    after: '1.139.0',
    title: 'A mailed report is the whole report',
    text: 'The mail a report sends is now the report itself, not a note with a link. It reaches every recipient who may see it, even one who has not signed in yet. A report can say the days it covers, set its opening paragraph apart above its numbers, and end with a button. Columns show their own titles and units where their data names them.',
  },
  {
    after: '1.138.0',
    title: 'Reports show what is on track and what is not',
    text: 'A report can now mark a number as on track, to watch, or off track: set **good** and **bad** on it, and it is marked wherever it shows. A new **Scorecard** block lists one row a thing, with a mark and a short trend beside it. A mailed edition opens with its team and its date in your own time zone, and a trend in a mail now shows its ups and downs.',
  },
  {
    after: '1.136.1',
    title: 'Reports have their own page, and you build them yourself',
    text: '**Reports** in the menu shows what your teams published, newest first, and opens each one on its latest edition. **New report** makes one from your saved queries: pick the queries, put the blocks in order, and say what the written summary should tell. To change a number or a chart, change its query on the **Query** page, then **Make a report** from there. **Hand over** gives a report and its schedule to someone else. Where your estate publishes them, tables from outside the catalog now show up on the Query page under **Datasets**.',
  },
  {
    after: '1.136.0',
    title: 'Links at the top of a page say what they are',
    text: 'The links at the top of a thing\'s page now show the name of the field they come from, such as **Grafana**, **Logs**, or **Azure portal**, in place of the site\'s address. Point at one to see the whole address. To change what a link says, rename its field on the **Model** page.',
  },
  {
    after: '1.134.0',
    title: 'Reports your team publishes, kept to compare',
    text: 'A team can now keep a **Report** in the catalog: headline numbers, charts, tables, and a few sentences written from saved queries and tools. Publish it by hand or on a schedule, and every edition is kept. Open a report to read its newest edition, see each number\'s trend across editions, and lay two editions side by side. Recipients hear of each new edition the way they hear of everything else. Your estate sets up the report actions first.',
  },
  {
    after: '1.123.0',
    title: 'Write a query as text with help as you type',
    text: 'The **Text** side of the **Query** page is now an editor that knows your catalog. As you type it offers what fits next: the kinds of thing after `from`, their fields after `where` and `columns`, a field\'s values after `==`, and the next part of the query. Press Ctrl Space to ask for suggestions anywhere. Point at a name to see what it is. A field nothing in the query has is underlined where you typed it, and a mistake is marked before you apply.',
  },
  {
    after: '1.119.0',
    title: 'Fold the side bar',
    text: 'The side bar on the left now folds to its icons: press the panel button at its top. Your pages stay one click away, and the catalog list steps aside to give the page more room. It stays as you leave it. The **Model** page has its own list of blueprints, so the side bar folds each time you open it; open it there if you want it.',
  },
  {
    after: '1.119.0',
    title: 'See the schedules that run on your things',
    text: 'A schedule now links to what it runs on. Open a thing in the catalog and its **Schedules** list every schedule that runs on it: who set it up, what it runs, and how often. Admins choose who sees schedules under **Model**, on the **Schedule** blueprint: tick **Also show each one to anyone who can see what it links to**, and each person sees the schedules that run on what they can see.',
  },
  {
    after: '1.112.1',
    title: 'The model sits together when you show only part of it',
    text: 'On the **Model** page, hiding blueprints now closes the room they took, so the ones you show sit near each other. Architects have a **Rearrange** button beside **Showing**: it lays out only what is shown, from scratch, for everyone. Move cards by hand after that as you like.',
  },
  {
    after: '1.110.0',
    title: 'A query chart shows what you add up',
    text: 'The **Chart** on the **Query** page now draws what the table adds up. A cost query grouped by type shows the cost of each type, longest first, in dollars, where it used to count rows. Pick what each bar stands for, how long it is (rows, or the sum, average, highest, or lowest of a number), and what splits it, such as Prod against Test. The chart you pick is saved with the query.',
  },
  {
    after: '1.109.0',
    title: 'Orrery from a terminal',
    text: 'The **orrery** command line now does what you do here: `orrery login` signs you in with a personal key, `orrery actions` lists what you may run, `orrery run` asks for a run and follows it to its end, and `orrery get`, `orrery search`, and `orrery query` read the catalog. It sees and runs only what you may here. `orrery help` explains each command.',
  },
  {
    after: '1.108.0',
    title: 'Money reads as money on the query page',
    text: 'A cost column on the **Query** page now shows dollars, such as **$24,702.77**, where it showed the stored cents. Its totals, its groups, and its range under **Fields** do too. Type a condition on it as an amount, such as **$1,700**. **Export to Excel** writes the amounts with a money format, so the sheet adds what you read.',
  },
  {
    after: '1.107.1',
    title: 'Remove a saved query from the library',
    text: 'In **Queries**, each query you saved has a bin beside it. Admins see one on every query. Before a query goes, Orrery says who else loses it: everyone, an audience, or the people of its home. A removed query also closes in any tab that had it open.',
  },
  {
    after: '1.107.0',
    title: 'Schedules tell you only when they fail',
    text: 'A schedule now tells you, and the people it names, only when it fails: its run failed, or every run of its batch did. Open the schedule, pick **Change**, and under **Tell me** choose **When anything fails** to hear of a batch where even one run failed, or **Every time** for every result. Changing who hears no longer asks for approval again. If a schedule cannot run at all, or stops, you always hear. A run that worked now lands in your list on the desk without a message; choose there how you hear of each kind.',
  },
  {
    after: '1.106.0',
    title: 'Give a query a home, and share it with the people who own it',
    text: 'A saved query can now belong to a program, a team, or any other entity, the way an action does. In **Share**, pick **Where it belongs**, then open it to **The people of** that home: everyone who owns it, such as its teams and its members. The library lists each home\'s queries together, and the home\'s own page shows them under **Queries**, beside its actions.',
  },
  {
    after: '1.104.0',
    title: 'Recent shows only what you ran',
    text: '**Recent** on the Self-service page now lists only the actions you ran by hand. What your schedules fire still runs as you, but it no longer crowds that list. Find it on the **Schedules** page.',
  },
  {
    after: '1.103.0',
    title: 'Scheduled runs fold into one line a day',
    text: 'In **Runs**, everything a schedule fired is now one line a day, not one line a firing. It names the schedule and how often it fires, says how many times it fired and how its runs stand, and shows why the latest failure failed. Press the arrow to see each firing, or the name to open the schedule. The runs and batches around it are the ones people asked for by hand.',
  },
  {
    after: '1.103.0',
    title: 'Fix what is yours, where you see it',
    text: 'Some values are now yours to keep up to date on the things you own, such as a service\'s description. A small **pencil** marks them, at the head of a column and beside a field\'s name, and an empty one says what it is waiting for: **Add a description**. Click it and type. **Now** lists what is yours to fill in. On a **scorecard**, press a failing mark to set the value it is missing, or to see where that value comes from. A value a source sends is still changed at the source. Every edit keeps what it replaced: **Put back** in the entity\'s timeline undoes it.',
  },
  {
    after: '1.103.0',
    title: 'Every schedule in one grid',
    text: 'Every schedule that runs, waits for approval, or is paused now has a record under **Orrery → Schedule**, beside Source and Runner. Each one says what it runs, whose it is, what it runs on, when it fires next, how its last firing went, and what it costs the runners in a day. Filter, query, and export them like anything else. Red means its last firing failed. Only admins see it until an admin opens it under Access. With actions on it, you can pause, resume, or run many schedules at once from the grid.',
  },
  {
    after: '1.100.1',
    title: 'Explore a query: count, group, and add up its answer',
    text: '**Query** is rebuilt for exploring. Keep several queries open, one tab each. Beside the answer, **Fields** counts every column\'s values: press one to keep only its rows, or hold **Ctrl** (or **⌘**) to leave them out. A column\'s header sorts it, groups by it, or adds it up, such as the sum of open alerts per team, and the foot adds up every row. Press a cell to keep or leave out its value, and open a row to see everything it holds. **Columns** can follow a relation, such as a repository\'s team\'s department. A blueprint\'s condition can test what a relation reaches: a service whose repository is idle over 90 days, or a repository with no team. **Text** shows the whole query as text you can edit, and **Chart** draws it as bars.',
  },
  {
    after: '1.99.0',
    title: 'Back goes up the path you are on',
    text: 'The **Back** arrow at the top of a page now goes up the places shown beside it, one at a time, and stops where you last picked a page from the menu. **Recent**, the clock beside it, lists every page you opened and jumps to any of them. On a phone, **Recent** is under **More**. Your mouse\'s back button and the browser\'s Back still go to the page you were just on.',
  },
  {
    after: '1.97.0',
    title: 'See where you have been, and go back',
    text: 'The top of every page now shows **Back** and **Forward**, and the places that led you here, such as **Schedules › Send ping › ping on 3 things**. Click any of them to go straight back there. Hold **Back**, or right-click it, to see your whole trail and jump to any step. Going back finds a page as you left it: its filter, its search, its tab, and how far you had scrolled. On a phone, **Back** sits at the top left.',
  },
  {
    after: '1.95.0',
    title: 'Run an action later, once or on repeat',
    text: 'Wherever you can run an action, **Run later…** now sits beside Run: on its form, on a page, on the rows you picked in a grid, and on things ticked on a map. Pick **Once** to put a run off until a moment you choose, such as tonight or tomorrow at 6 AM; it runs then as you, and nobody has to approve it first. Pick **On repeat** to run it again and again, which someone who decides approvals approves first. **Schedules** shows each of yours on one clock, with every time it fired, what it costs the runners through the day, and each firing\'s runs when you open it.',
  },
  {
    after: '1.89.0',
    title: 'Filter a grid by clicking its spread of values',
    text: 'Click a colour in the **spread of values** at the bottom of a grid to show only those rows: click **online** under Connection to see just what is online. Hold **Ctrl** (or **⌘**) as you click to show everything else instead. Click it again to take the filter away. **Filter** opens the filters as chips that read like a sentence, such as **Connection is not online**. Click one to change it, where every list is searched by typing and shows how many rows hold each value.',
  },
  {
    after: '1.88.2',
    title: 'Ask for more than one approval',
    text: 'An action can now need two or more different people to approve a run before it starts. The run says how many have approved, and who. Most actions still need one.',
  },
  {
    after: '1.87.0',
    title: 'Change the model from your phone',
    text: 'On a phone, the Model page now reads each blueprint as plain sentences, and you change it by tapping them. Tap a **blue** name to change a property or a relation. Tap an **orange** part to change what a property holds, or how a count is worked out. The box at the end adds a property or a relation. **Lifecycle, access, YAML** opens the whole editor, and the list of blueprints can start a new one, import a model, or open the rules. Every change saves at once, the same as on a computer.',
  },
  {
    after: '1.81.1',
    title: 'The model moves the same with a mouse or a trackpad',
    text: 'On the model page, scrolling or pinching zooms toward the pointer and glides there, with a mouse or a trackpad alike. Dragging the empty canvas moves it; hold **Shift** and drag to pick several cards. Double-click the empty canvas to zoom in there, press **F** to see the whole model, and **+** or **-** to zoom. The trackpad and mouse switch is gone.',
  },
  {
    after: '1.79.0',
    title: 'See what waits for your approval',
    text: 'Self-service in the side bar now counts the schedules that wait for your approval, beside the runs. The approvals kind counts the approvals that name you, from every system that writes there. Actions made to be run on a row, such as Approve and Decline in an inbox, no longer show as tiles on the Self-service page.',
  },
  {
    after: '1.78.0',
    title: 'Queries have a library, and share with an audience',
    text: 'Your saved queries now sit in a library beside the answer: yours first, then what was shared with an audience you are in, then with everyone. A saved query runs as soon as you open it. Each blueprint has its own colour, on its rows and on the columns it fills, and a column can read a different field from each blueprint. **Share** says who can open it: only you, an audience you are in, or everyone. Everyone sees only what their own access lets them see. An admin viewing as someone can now run their queries and see exactly what they would.',
  },
  {
    after: '1.78.0',
    title: 'Run an action on many, when each fills in its own environment',
    text: 'An action that takes its environment, or anything else, from the thing it runs on can now run on many at once. Tick rows in the grid, fill the form once, and each run takes its own value from its own thing. The form is the action\'s own, with every kind of question it asks. Before anything is sent you see each thing it runs on, and each it does not, with why.',
  },
  {
    after: '1.77.1',
    title: 'Approvals in the inbox, and runs in Query',
    text: 'Runs and schedules that wait for approval now also show in your estate\'s approvals inbox, where an Approve or Decline action decides them. On the Query page, add **Action runs** to filter and export the runs you may see. Run screenshots are kept for 30 days and runs for a year.',
  },
  {
    after: '1.77.1',
    title: 'Schedule every few hours',
    text: 'A schedule can now run every 2, 3, 4, 6, 8, or 12 hours, from a time you pick. The form greys out anything more often than the action allows, so you know before you ask.',
  },
  {
    after: '1.76.0',
    title: 'Run an action on a schedule',
    text: 'An action that allows it now has **Schedule it** on its form, and on a batch run on a saved query: every hour, every day, or on some days, as you, with the result sent to you and anyone you name. Someone who decides approvals approves each schedule first, and sees the load it adds. Self-service now also has **Insights**: which actions run most and least, who runs them, batches, and how busy each runner is through the day.',
  },
  {
    after: '1.75.0',
    title: 'Query the whole catalog, and export it to Excel',
    text: 'The new Query page reads every match of one or more blueprints at once. Pick the blueprints, filter each, choose the columns, and run it. Export the answer to Excel, run an action on all of it, or save it to run again and share. In the catalog, ticking every row loaded now offers to pick every row that matches, and says how many your filter leaves out.',
  },
  {
    after: '1.74.0',
    title: 'The Load page says what needs you',
    text: 'The Load page now opens with a verdict: what is past or near a budget, and where the hub spends its time, hour by hour. **Needs a look** lists each source, caller, or blueprint worth your time, worst first. Open one to see what is happening, why it costs, and what you can do, or give it a budget of its own. The full lists are still there, folded at the bottom.',
  },
  {
    after: '1.73.2',
    title: 'A batch is one line',
    text: 'In the runs list and the activity log, a batch now shows as one line: what ran, on how many, how its runs stand, and a picture one of them reported. Open it to see every run under it, or open the batch for the whole grid.',
  },
  {
    after: '1.73.2',
    title: 'Access at a glance',
    text: 'The Access page now shows people as cards, grouped by what they hold: admins, each role, those who only read, and those not signed in yet. A ring round each person says if they were here today or this week. **View as** sits on each card, next to the name. One grid shows what every role allows; click a square to change it. Click a person or a role to change them in a side panel. The settings you change once in a while fold away at the bottom.',
  },
  {
    after: '1.72.9',
    title: 'Yours adds up everywhere on Now',
    text: 'The sky, the list under it, and Yours now count your things the same way. A kind you see only because you own some of it counts what you own, where it used to say empty. Yours lists every kind you own, healthy ones too, and opens each to show them all.',
  },
  {
    after: '1.72.9',
    title: 'How long a batch takes',
    text: 'Before you run an action on many things, the drawer now says about how long it takes, from how long its runs usually take. While it runs, the batch page says how much time is left, and follows the batch’s own pace once it has one.',
  },
  {
    after: '1.71.0',
    title: 'Read a whole cell in the catalog',
    text: 'A cell you cannot change now opens when you click it, and shows all of it: every item of a list, every thing a relation points at, and long text in full. A long list has a box to find one. Each thing it points at is a link to its page.',
  },
  {
    after: '1.70.0',
    title: 'Failed runs are tried again',
    text: 'An action can now try a failed run again on its own, after a short wait, before it calls the run failed. A batch then shows what each thing really said, not a passing hiccup. A card waiting for its next try says Retrying, and the run page says which try it is on.',
  },
  {
    after: '1.69.0',
    title: 'Run an action on many things at once',
    text: 'Where an action runs on many, tick rows in the catalog, or tick the box at the top for every row your filter matches, and the action shows in the bar above the grid. Before anything is sent you see every one it will run on. Then each gets its own run, and the batch page shows them all as cards, with the picture each one reported. Run any that failed again from there.',
  },
  {
    after: '1.56.0',
    title: 'Read the whole plan before you approve',
    text: 'A run can now carry an attachment, such as the full plan of an infrastructure apply. It sits folded under the summary on the run page. Open it to read every value, or copy it or download it without opening it.',
  },
  {
    after: '1.51.0',
    title: 'A welcome tour, and these notes',
    text: 'The first time you open the hub, a short tour shows you around: Now, the catalog, and Self-service. Take it again any time from your account menu. From now on, these notes say what is new the first time you open a new release.',
  },
]

/** How many notes the box shows whole; the rest wait as titles a person opens. */
export const OPEN_NOTES = 1

/** The notes laid out in the box: the newest whole, and the rest as titles beneath it, so a person back after many releases reads the latest first and is never handed a wall. */
export function laidOut(notes: readonly ReleaseNote[], open = OPEN_NOTES): { open: ReleaseNote[]; folded: ReleaseNote[] } {
  return { open: notes.slice(0, open), folded: notes.slice(open) }
}

/** The notes a person who last saw `seen` has not read, newest first. None for a person who has seen none: they start with the tour. */
export function unread(seen: string | null, notes: ReleaseNote[] = NOTES): ReleaseNote[] {
  if (!seen) return []
  return notes.filter((n) => compareReleases(n.after, seen) >= 0)
}
