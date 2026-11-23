package main

// The help. `orrery` or `orrery help` prints the overview; `orrery help
// <command>` or `orrery <command> --help` prints one command's.

const overview = `orrery is the command line of an Orrery hub: one graph of an estate.

As a person (sign in once; you see and run what you may in the web app):
  orrery login --hub <address>          sign in to a hub with a personal key, kept in the system keychain
  orrery logout                         forget the hub and the key
  orrery whoami                         who the hub says you are
  orrery actions [--entity bp:key]      the self-service actions you may run, or the ones you may run on one entity
  orrery action <id>                    one action: what it does and the inputs it takes
  orrery run <action> [--entity bp:key] [--input name=value]...
                                        ask for a run, follow it to its end, print its log, steps, and outputs
  orrery watch <run-id> [--once]        follow a run that was asked for earlier, or read it once as it stands
  orrery runs [--action id]             the latest runs you may see
  orrery get <blueprint:key>            one entity: its fields, its relations, the actions you may run on it
  orrery search [text] [--blueprint b] [--filter json]
                                        entities by text, by a filter, or both
  orrery queries                        the saved queries you may open
  orrery query <id> | --file q.json     run a saved query, or one written as JSON

  Every one of those takes --hub <address> and -o json. Table output is for
  reading; -o json is the hub's own answer, for a script or an agent.
  Exit code: 0 done, 1 refused or failed, 2 a run still going at --timeout.

As a machine (a shell job, a hook, a pipeline; ORRERY_URL and ORRERY_TOKEN):
  orrery push <file.yaml> [--scope name] [--snapshot] [--enrich]   offer the file's blueprints, then write its entities as one run
  orrery put <blueprint> <key> [--title t] [--icon name] [--field k=v]... [--relation r=target]...   create or replace one entity
  orrery patch <blueprint> <key> [--field k=v]... [--relation r=target]...           merge fields into one entity
  orrery delete <blueprint> <key>                                                    explicit delete (needs a delete grant)
  orrery heartbeat                                                                   mark the source alive
  orrery refresh-git <source-id>                                                     pull a git source now
  orrery report <run-id> [--state running|succeeded|failed] [--label l] [--link url] [--summary s] [--step name] [--output name=value]... [--log line]...   report on an action run (needs an access token with actions.report; a job reports on its own run with the credential it was handed, and leaves --state out)

  environment: ORRERY_URL (the ingest host), ORRERY_TOKEN (a source token, or an access token for report; inside a job, both are set for it, with ORRERY_RUN, its run's id)
  field values parse as JSON when they can (numbers, booleans, objects) and as strings otherwise

  orrery version
  orrery help <command>                 one command, with examples`

const whichHub = `
Which hub: --hub <address>, else ORRERY_MCP_URL, else the first hub you signed
in to. The address is the hub's machine address (the one tokens are sent to,
such as https://orrery-ingest.example.org), not the web app's.`

var help = map[string]string{
	"login": `orrery login --hub <address> [--command <command>]

Signs you in to a hub, so the other commands act as you.

With no --command it asks for a personal key without showing it (or reads one
line from standard input), asks the hub who the key is, and keeps it in the
system keychain: the macOS keychain, the Secret Service where secret-tool is
installed, otherwise a file only you can read. Make a key in the hub's web
app, under your name, API keys. The key is never printed.

With --command it keeps no key: it remembers a command of yours that prints a
token each time one is needed, such as a vault read. A hub that takes its
identity provider's tokens (GET <address>/v1/sign-in says the issuer and the
scope to ask for) also takes one of those, so a command that prints one signs
you in with no key at all. An action that calls another system as you needs
that kind of sign-in: the hub cannot trade a personal key for your token.

Either way the hub's line is written to ~/.config/orrery/tokens (or the file
ORRERY_TOKENS_FILE names), "<address> <command that prints a token>". The
agent plugin reads the same file, so one sign-in serves both.

  orrery login --hub https://orrery-ingest.example.org
  vault read -field=key secret/orrery | orrery login --hub https://orrery-ingest.example.org
  orrery login --hub https://orrery-ingest.example.org --command 'vault read -field=key secret/orrery'`,

	"logout": `orrery logout [--hub <address>]

Forgets a hub: removes its line from the tokens file, and its key from the
keychain when this command line put it there. A command you gave with
--command is only forgotten, never run.` + whichHub,

	"whoami": `orrery whoami [-o json]

Who the hub says you are: your name, whether you are an admin, your roles,
and the hub's version. The quickest check that a sign-in works.` + whichHub,

	"actions": `orrery actions [--entity <blueprint:key>] [-o json]

The self-service actions you may run. With --entity, only the ones you may
run on that one entity: who may run an action can depend on what you are to
the entity and on what it is. The hub decides both lists.

RUNS ON names the blueprints an action runs on; an action with none takes no
--entity. APPROVAL says a run waits for someone to approve it.

  orrery actions
  orrery actions --entity service:checkout
  orrery actions -o json | jq -r '.actions[].id'` + whichHub,

	"action": `orrery action <id> [-o json]

One action: what it does, what it runs on, whether a run waits for approval,
and every input it takes, in the order they are asked. Read it before you run
it. For each input: its type, whether it is required, the values it picks
from, and when it is asked at all. -o json is the whole definition.

  orrery action restart-app` + whichHub,

	"run": `orrery run <action> [--entity <blueprint:key>] [--input name=value]... [--no-wait] [--timeout 30m] [-o json]

Asks the hub for a run of an action, as you, then follows it to its end:
each log line as it comes, under its step, then the state, the summary, the
steps, the outputs, and the link the backend named. The hub checks who you
are, what you may run, and every input, exactly as the web form does, and
writes the run and its log as it does there.

  --entity   what it runs on, for an action that runs on a blueprint
  --input    name=value sends the value as text; the hub reads it as the
             input's own type (a number, true or false, a date, an entity as
             blueprint:key or a bare key). name:=<json> sends JSON as it is.
             Give a name more than once for an input that takes a list.
             Leave out an input that is not asked or that the hub works out.
  --no-wait  ask and return at once, with the run's id. The run goes on in
             the hub without you: nothing of yours has to stay running for
             it, unless the action's backend is caller, where whoever asked
             does the work. Read it later with orrery watch <id> --once
  --timeout  how long to follow before giving up (the run itself goes on)

Exit code: 0 when the run succeeded (or, with --no-wait, was taken), 1 when
the hub refused it or the run failed, ended with its outcome unknown (the
hub stopped waiting for its backend, which may have done the work: check
before running it again), was declined, cancelled, or sent back, 2 when it was still going at --timeout; follow it then with orrery watch.
A run that waits for approval is followed until someone decides it.

An action whose answer is shown once (its definition says "reveal") writes
that answer to your terminal only: never to standard output, a pipe, a file,
or -o json. Without a terminal the run is not asked for.

  orrery run restart-app --entity service:checkout --input why="stuck after deploy"
  orrery run grant-access --input person=ada --input days=30 --input groups=dev --input groups=ops
  orrery run rotate-key --entity service:checkout -o json | jq .state` + whichHub,

	"watch": `orrery watch <run-id> [--once] [--timeout 30m] [-o json]

Follows a run that was asked for earlier, from the web app, an agent, or
orrery run --no-wait: its log so far, each new line as it comes, then what
came of it. Exit codes are the ones orrery run gives.

  --once     read the run as it stands now and return at once: its log so
             far, its state, summary, steps, outputs, and link. Nothing is
             followed. A run may be read this way at any time, hours or days
             after it was asked for: a run that waits for approval, or a job
             that runs for days, needs nobody to stay for it. Exit code: 0
             while it is still going or once it succeeded, 1 once it ended
             any other way.

  orrery watch 9f2c41aa07b3 --once
  orrery watch 9f2c41aa07b3 --once -o json | jq '{state, summary, outputs}'` + whichHub,

	"runs": `orrery runs [--action <id>] [--entity <blueprint:key>] [--limit 20] [-o json]

The latest runs you may see, newest first: of every action, of one, or on
one entity.` + whichHub,

	"get": `orrery get <blueprint:key> [-o json]

One entity: its status and why, its fields, what it points at and what
points at it, and the actions you may run on it. What you may not see is
left out. -o json is the hub's whole answer.

  orrery get service:checkout
  orrery get service:checkout -o json | jq .fields` + whichHub,

	"search": `orrery search [text] [--blueprint <id>] [--filter <json>] [--fields a,b] [--sort field] [--limit 50] [--after <next>] [-o json]

Entities, by text found in the key, the title, or any field you may see, by
a filter, or by both together.

  --blueprint  only entities of one blueprint
  --filter     a filter object as JSON. Leaves: {"field":"tier","op":"eq","value":"gold"}
               with op one of eq, neq, gt, gte, lt, lte, in, contains, prefix,
               exists, within, older; {"relation":"team","target":"team:platform"};
               {"relatedTo":"team:platform"}; {"state":"missing"}; {"search":"text"}.
               Combine with {"and":[...]}, {"or":[...]}, {"not":{...}}.
  --fields     field names to show as columns after the id, the title, and the status
  --sort       a field to order by, or -field for descending
  --after      the next page: the value the page before named

  orrery search checkout
  orrery search --blueprint service --filter '{"field":"tier","op":"eq","value":"gold"}' --fields tier,language
  orrery search --blueprint service -o json | jq -r '.entities[].id'` + whichHub,

	"queries": `orrery queries [-o json]

The saved queries you may open: your own and the ones shared with you. Run
one with orrery query <id>.` + whichHub,

	"query": `orrery query <id> [--limit 200] [-o json]
orrery query --file <query.json | -> [--limit 200] [-o json]

Runs a saved query by its id, or a query written as JSON (- reads it from
standard input), and prints the answer as one table across blueprints. The
hub shapes the answer by the query's own view, so the rows are the ones its
page shows: its conditions, its order, its totals, and, under the table,
its groups with the count and the totals of each.

A query as JSON: {"sources":[{"blueprint":"service","clauses":[{"field":"tier","op":"eq","value":"gold"}]}],
"columns":["title","tier","r:team"],"view":{"sort":[{"column":"title"}]}}.
A column is a field, a relation as r:<name>, or one of $type, title, key,
$status, state, $owner, lastSeenAt, updatedAt. orrery queries -o json shows
the spec of every saved query, to copy from.

  orrery query q_8f2k1
  orrery query --file gold-services.json -o json | jq '.rows[].values'` + whichHub,
}

// helpFor is one command's help, or the overview for a command with none of its own.
func helpFor(command string) string {
	if text, ok := help[command]; ok {
		return text
	}
	return overview
}
