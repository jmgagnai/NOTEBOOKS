# Issue tracker: Jira

Issues live in Jira Cloud, project **NBK** (team-managed, Scrum template — board
"NBK board", id 35, sprints enabled), at
https://jmga.atlassian.net/jira/software/projects/NBK. Issue types: Epic, Story,
Task, Bug, Subtask. All operations go through the REST API via `curl` — there is
no CLI.

## Auth

Basic Auth, `email:api_token` base64-encoded. Credentials live in `.env` (git-ignored,
never commit it):

- `JIRA_BASE_URL` — https://jmga.atlassian.net
- `JIRA_EMAIL` — jmgagnaire@gmail.com
- `JIRA_API_TOKEN` — the Atlassian API token
- `JIRA_PROJECT_KEY` — NBK

Source `.env` before any call, e.g.:

```bash
set -a; source .env; set +a
AUTH="$JIRA_EMAIL:$JIRA_API_TOKEN"
curl -s -u "$AUTH" -H "Content-Type: application/json" "$JIRA_BASE_URL/rest/api/3/..."
```

## Use the helper, not raw curl

`node scripts/jira.mjs` wraps the operations below and converts Markdown bodies
to Atlassian Document Format, which the v3 API requires. Reach for it first:

```bash
node scripts/jira.mjs get NBK-1 --comments
node scripts/jira.mjs comment NBK-1 body.md          # - reads stdin
node scripts/jira.mjs create --summary "..." --body ticket.md \
  --type Task --parent NBK-1 --label ready-for-agent
node scripts/jira.mjs transition NBK-5 Done
node scripts/jira.mjs link NBK-6 blocked-by NBK-5
```

It converts headings, paragraphs, bullet and ordered lists, `- [ ]` task lists
(which become real Jira checkboxes), and inline bold/code/links. Hand-rolling
that conversion per task is how a spec's structure gets flattened into one
paragraph.

The raw endpoints below remain the reference for anything the helper does not
cover.

## Conventions

- **Create an issue**:
  `POST $JIRA_BASE_URL/rest/api/3/issue` with body
  `{"fields":{"project":{"key":"NBK"},"summary":"...","description":{...ADF...},"issuetype":{"name":"Task"}}}`.
  Jira's `description` field is Atlassian Document Format (ADF), not plain markdown.
  `scripts/jira.mjs` does that conversion for you; build ADF by hand only for a node
  type it doesn't emit, and keep the document's structure rather than collapsing it
  into one paragraph — a spec or ticket is mostly headings, lists and checkboxes.
- **Read an issue**: `GET $JIRA_BASE_URL/rest/api/3/issue/<key>?fields=summary,description,status,labels,comment`
- **List/search issues**: `GET $JIRA_BASE_URL/rest/api/3/search?jql=project=NBK AND ...` (JQL), URL-encoded.
- **Comment on an issue**: `POST $JIRA_BASE_URL/rest/api/3/issue/<key>/comment` with ADF body.
- **Apply / remove labels**: `PUT $JIRA_BASE_URL/rest/api/3/issue/<key>` with
  `{"fields":{"labels":["..."]}}` (full replace — fetch current labels first and merge).
- **Transition status**: `GET .../issue/<key>/transitions` to find the transition id for
  the target status, then `POST .../issue/<key>/transitions` with `{"transition":{"id":"<id>"}}`.
- **Close/Done**: transition to the `Done` status via the same mechanism.

## Workflow states

Confirmed via `GET /rest/api/3/project/NBK/statuses` — same three statuses for every
issue type (Epic, Story, Task, Bug, Subtask):

`To Do` → `In Progress` → `Done`

Status ids (stable, usable in transition lookups without a name match):
`To Do`=10040, `In Progress`=10041, `Done`=10042.

## Sprints

This is a Scrum board (board id 35), so issues also belong to a sprint, not just a
status column:

- **Current/future sprints**: `GET $JIRA_BASE_URL/rest/agile/1.0/board/35/sprint`
- **Add an issue to a sprint**: `POST $JIRA_BASE_URL/rest/agile/1.0/sprint/<sprintId>/issue`
  with `{"issues":["NBK-1", ...]}`
- **Backlog (no sprint)**: issues created without a sprint sit in the board backlog;
  list via `GET $JIRA_BASE_URL/rest/agile/1.0/board/35/backlog`
- Story points live on `customfield_10016` ("Story point estimate") — set via the
  normal issue `PUT` under `fields`.

## When a skill says "publish to the issue tracker"

Create a Jira issue (issue type `Task`) in project `NBK`.

## When a skill says "fetch the relevant ticket"

`GET` the issue by key, expanding `comment` and `labels`.

## Wayfinding operations

Used by `/wayfinder`. Jira has no native sub-issue/dependency graph as rich as GitHub's,
so this is approximated:

- **Map**: a single Task labelled `wayfinder-map`, holding the Notes / Decisions-so-far /
  Fog content in its `description` (ADF).
- **Child ticket**: a Task linked to the map via an issue link of type **"relates to"**
  (or **Jira sub-tasks** if the board enables them), labelled `wayfinder-<type>`
  (`wayfinder-research` / `wayfinder-prototype` / `wayfinder-grilling` / `wayfinder-task`).
  Once claimed, set `assignee` to the driving dev via
  `PUT .../issue/<key>/assignee`.
- **Blocking**: Jira issue link type **"is blocked by"** /
  `POST $JIRA_BASE_URL/rest/api/3/issueLink` with
  `{"type":{"name":"Blocks"},"inwardIssue":{"key":"<child>"},"outwardIssue":{"key":"<blocker>"}}`.
  A ticket is unblocked when every issue linked as a blocker is in status `Done`.
- **Frontier query**: `GET /rest/api/3/search?jql=project=NBK AND labels="wayfinder-*" AND status!=Done`,
  then for each result fetch `issuelinks` and drop any with an open (`status != Done`)
  blocker, or an existing `assignee`; first by creation order wins.
- **Claim**: `PUT .../issue/<key>/assignee` with your account id, the session's first write.
- **Resolve**: comment the answer, transition to `Done`, then append a context pointer
  to the map's Decisions-so-far (in the map issue's description, via a `PUT`).
