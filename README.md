# pi-session-title

[![CI](https://github.com/MKmasterg/pi-session-title/actions/workflows/ci.yml/badge.svg)](https://github.com/MKmasterg/pi-session-title/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@mkmasterg/pi-session-title)](https://www.npmjs.com/package/@mkmasterg/pi-session-title)

The assistant names every [pi](https://pi.dev) session at the start of the thread, so `/resume` lists a title instead of a truncated first message, and you can find the thread again by title, by anything said in it, or by the prompt that started it.

```
/resume
  Session search: login redirect
› Fix login redirect — Return to the original page after sign-in           14  2h ago
```

It is one file, [`extensions/session-title.ts`](extensions/session-title.ts), with no dependencies beyond pi itself.

## Install

```bash
pi install npm:@mkmasterg/pi-session-title            # from npm
pi install git:github.com/MKmasterg/pi-session-title  # or straight from GitHub
pi -e ./extensions/session-title.ts                  # or try it once from a clone, without installing
```

## Use

Nothing to do: start a thread, and the assistant's first action is to title it.

| | |
|---|---|
| `/title` | Show the current title and task. |
| `/title <title>` | Rename by hand. Keeps the task line. |
| `/title task <text>` | Change only the task line. |
| `/title auto` | Ask the model to re-title the session from the whole conversation so far, for example when the work changed direction. |

The native `/name` keeps working and simply replaces the title.

## How it works

**The assistant does the naming.** While a session has no name, the extension declares one extra tool, `session_title`, to the model, with a guideline to call it first: a concise, specific title (3–8 words) plus a one-line summary of what you asked for. The tool writes both through pi's own session name as `title — task`, and hides a record of them in the session as a custom entry.

**Why the session name:** pi's `/resume` picker shows the name instead of the first message and ranks it first when you search. Searching already covers three tiers: the name (exact or fuzzy), then the session id, every user and assistant message, and the working directory (exact). So a title is found by its words, a thread is found by anything said in it, and the first prompt keeps matching even after the name replaces it on screen. `"quoted phrases"` and `re:regex` work too, `Ctrl+N` limits the list to titled sessions, and `Ctrl+S` switches between recent and relevance ordering.

**No cost after the first request.** The tool is declared only while the session is unnamed. Pi diffs the prompt against what the model already has, so an unnamed session adds nothing after its first request, and the moment the session is titled the tool leaves the prompt again. Resumed sessions that never got a title pick up the tool on their next turn, and so do forks taken before the point where the parent was titled.

**If the model does not call it**, nothing breaks: the session stays as it was, the tool stays available, and you can just ask "name this session" or use `/title`.

**Headless sessions.** `pi -p` and RPC mode have no picker row for the tool, but the title is still written, so the next interactive `/resume` shows it.

## Development

```bash
npm install
npm run check                       # type-check against pi 1.6
npm test                            # behaviour tests through pi's real extension loader
npm run verify:package              # the npm tarball holds only the extension and its docs
```

The tests load the extension through `discoverAndLoadExtensions`, drive the tool, the command and the `before_agent_start` handler, and assert on the names written, the entries recorded, and which requests see the tool.

## Releasing

Releases come from conventional commits: `fix:` bumps the patch version, `feat:` the minor version (while below 1.0), and `feat!:` or `BREAKING CHANGE:` marks a breaking change.

1. On every push to `main`, CI type-checks and tests against the locked pi version and the newest pi release.
2. release-please keeps a release PR open with the next version and its `CHANGELOG.md` entry. pi shows that changelog to users when the package updates.
3. Merging the release PR tags the version and creates a GitHub release. The `publish` job then tests again and runs `npm publish --provenance` in the `npm` environment.

Publishing uses npm trusted publishing, so there is no npm token in the repository. Set up trusted publishing for the package on npmjs.com against the `release.yml` workflow in the `npm` environment of this repository before the first release.
