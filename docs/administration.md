# Administration

An **Administrator** (GLOSSARY.md) is a user named in the backend's
configuration who may do what the app offers no one in its UI. Today that is
one thing: restoring a deleted Chat Thread (NBK-95, ADR-0001 amendment).
Administrators use the API directly, with `curl`.

## Making someone an Administrator

List their emails, comma-separated, in the repo-root `.env`, then restart the
backend:

```bash
ADMIN_EMAILS=ada@example.com, grace@example.com
```

Case and spaces don't matter. Unset or empty, there is no Administrator, and
every restore answers 403. The user must also have an account: an
Administrator signs in like anyone else.

## Finding a deleted Chat Thread

The UI lists no deleted Threads. Each deletion leaves a line in the backend's
log (`docs/logging.md`), with what a restore needs, as its message and as
fields (`threadId`, `notebookId`, `title`, `author`):

```text
Chat Thread deleted: id=<threadId> title="Revenue questions" notebook=<notebookId> author=ada@example.com
```

In production's JSON log, `grep 'Chat Thread deleted'` finds it, and `jq`
reads its fields: `… | jq 'select(.threadId) | {threadId, notebookId, title}'`.

Or ask Postgres, which keeps every deleted Thread with its messages:

```bash
docker compose exec postgres psql -U rag_notebook rag_notebook -c \
  "SELECT id, notebook_id, title, deleted_at FROM chat_threads
   WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC;"
```

## Restoring it

Sign in to get a session cookie, then restore by Notebook and Thread id:

```bash
API=http://localhost:3000
C=$(curl -si -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"ada@example.com","password":"…"}' \
  | sed -n 's/^[Ss]et-[Cc]ookie: \([^;]*\).*/\1/p' | head -1)
curl -s -X POST -H "Cookie: $C" $API/notebooks/<notebookId>/threads/<threadId>/restore
```

It answers the restored Chat Thread (200), back in its Notebook's list with
its messages for everyone. It answers 403 when the signed-in user isn't an
Administrator, and 404 when there is no deleted Chat Thread by that id.
