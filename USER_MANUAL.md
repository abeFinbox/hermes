# User Manual — Hermes, *The Messenger*

Everything in the app, explained in the order you'll meet it. For setup and architecture, see the [README](README.md).

> 💡 **Fastest way to learn the UI**: turn on the **Legends** checkbox in the top bar. Every functional control gets a small ⓘ badge — hover it for an explanation of exactly what that control does. Turn it off again for a minimal UI.

---

## Contents

1. [Signing in](#1-signing-in)
2. [The UI at a glance](#2-the-ui-at-a-glance)
3. [Importing a Postman collection](#3-importing-a-postman-collection)
4. [Creating a suite from scratch](#4-creating-a-suite-from-scratch)
5. [The suite editor](#5-the-suite-editor)
6. [Variables & chaining](#6-variables--chaining)
7. [Validating responses](#7-validating-responses)
8. [Running: single step, whole suite, cycles](#8-running-single-step-whole-suite-cycles)
9. [Run history & reports](#9-run-history--reports)
10. [The suite composer](#10-the-suite-composer)
11. [Exporting to Postman](#11-exporting-to-postman)
12. [Migrating suites between instances](#12-migrating-suites-between-instances)
13. [Appearance & themes](#13-appearance--themes)
14. [Settings, users & security](#14-settings-users--security)
15. [Script API reference](#15-script-api-reference)
16. [Troubleshooting](#16-troubleshooting)
17. [Backend engine (Node ⇄ Go)](#17-backend-engine-node--go)

---

## 1. Signing in

- Enter your username, password, and the **captcha** shown in the image. The captcha is generated locally on the server — no external service, works air-gapped. Click the image for a fresh one; each captcha is single-use and expires after 5 minutes.
- First run seeds an admin account (**admin / admin123** unless overridden). Change the password immediately in **Settings**.
- Sessions last 12 hours (JWT in an httpOnly cookie). Repeated failed logins are rate-limited per IP.

## 2. The UI at a glance

| Area | Purpose |
|---|---|
| **Sidebar** | Collections, Suites, Variables, Files, Runs, Appearance, Settings, Docs |
| **Top bar** | Quick theme switcher · **Legends** toggle (ⓘ help badges) |
| **Collections** | Raw Postman imports (read-only tree view) |
| **Suites** | Your editable test suites — the heart of the app |
| **Variables** | Global variables shared by every suite |
| **Files** | Shared store for files attached to requests (form-data uploads) |
| **Runs** | Execution history and reports |

Collections and suites are separate on purpose: a suite created from a collection owns a **copy** of the requests (copy-on-write). Editing a suite never mutates the imported collection, and deleting a collection never breaks its suites.

## 3. Importing a Postman collection

1. In Postman: right-click a collection → **Export** → format **Collection v2.1** → save the `.json`.
2. In the app: **Collections → Import Postman collection** → upload the file or paste the JSON.
3. Leave **"Also create an editable test suite"** checked (recommended) — you'll land directly in the new suite's editor.

What survives the import: folder structure (as step labels), method/URL/params/headers, raw-JSON/urlencoded bodies, bearer & basic auth, collection variables (→ suite variables), and any `pm.*` scripts (stored verbatim — shown nowhere yet, but re-attached on export; they are **not executed** by the runner).

Multipart file bodies and other auth types (OAuth, AWS Sig) are not supported yet — those requests import with what can be kept and are fully editable afterwards.

## 4. Creating a suite from scratch

**Suites → New suite from scratch** → name it → the editor opens with one empty step. Add steps with **+ Add step** and fill in each request by hand. Everything else (chaining, validation, runs, export) works identically to imported suites.

## 5. The suite editor

Layout: suite header (name, description, **Save**, 🧺 Composer toggle) → **run bar** → suite-level tabs (**Steps / Suite variables / Settings**) → the step list (left) and the selected step's detail (right).

⚠️ **Nothing is persisted until you click Save.** The Save button lights up ("Save changes") whenever there are unsaved edits; Run auto-saves first.

### The step list

Steps execute **top to bottom** — order matters because captures from earlier steps feed later ones.

Per-row controls: **checkbox** enable/disable (disabled steps are skipped but kept) · **＋** add to composer (only when composer is on) · **▶** run only this step · **↑/↓** reorder · **⧉** duplicate · **✕** delete. For long suites the list scrolls inside its own column, so the detail panel stays visible.

### The step detail — three tabs

- **Request** — method, URL, query params, headers, body (none / JSON / raw / form-urlencoded / **form-data**), auth (none / bearer / basic). Every text field supports `{{variable}}` placeholders. Below the URL, **chips** show every placeholder the step uses: green = defined, red = undefined (click *define as global* to fix it on the spot). Imported steps have a **↩ Reset to imported original** button.
- **Validate** — checks that run after the response. See [§7](#7-validating-responses).
- **Capture** — pulls values out of the response into variables for later steps. See [§6](#6-variables--chaining).

### Attaching files (form-data body)

To send a `multipart/form-data` request (file uploads), set the body mode to **form-data**. You then build the body from typed fields:

- **Text field** — a plain key/value part (the value supports `{{variables}}`).
- **File field** — pick a file from the **Files store** (see below). The file's bytes and original name are sent as that part.

Hermes sets the `Content-Type` (with the multipart boundary) automatically — don't add it manually. Use **↻ Refresh files** if you just uploaded something, or **Manage files ↗** to open the store. If a referenced file has been deleted, the field is flagged and the step errors until you attach a new one.

**The Files store (Files in the sidebar)** is a shared, server-side folder for upload files. Upload once (drag-and-drop or the button, up to 25 MB each) and reference the file from any request's form-data body. Files live on the server (`DATA_DIR/files`), not inside suites — so they're reusable, don't bloat exports, and are covered by the same backups as the database. Deleting a file here means any request pointing at it needs a new attachment.

### Suite variables tab

Key/value pairs scoped to this suite. They override globals of the same name. The checkbox column marks a value as visible; unchecked = secret (masked).

### Settings tab

- **Default cycles** — pre-fills the run bar.
- **Request timeout (ms)** — per request (default 30 000).
- **Stop on failure by default** — pre-checks the run-bar option.
- **Run captures even when the step failed** — useful for capturing diagnostic values from failing responses.

## 6. Variables & chaining

### Scopes and precedence

When `{{name}}` is resolved, the first match wins:

1. **Runtime** — captured earlier in the *current run/cycle*
2. **Suite** — the suite's Variables tab
3. **Global** — the Variables page (shared by all suites)

So a captured `{{token}}` beats a stale suite value, and a suite's `{{baseUrl}}` beats the global one. Suite variables reset at the start of each cycle; globals persist (and global captures are saved permanently, immediately).

### Capturing (the chaining mechanism)

On the step that *produces* a value, open **Capture**:

- **Visual rule**: choose a source — **Body JSONPath** (`$.data.token`), **Header**, **Status code**, or **Whole body** — name the target variable, pick the scope (**suite** or **global**).
- **Script**: full control —

  ```js
  const body = response.json();
  variables.set("authToken", body.token);            // suite scope
  variables.set("userId", body.user.id, "global");   // persisted global
  console.log("captured for", body.user.name);       // shows in run logs
  ```

Any later step can then use `Authorization: Bearer {{authToken}}` — that's the whole chain.

### Promoting a variable from a request

Typing `{{newVar}}` anywhere in a request shows a red chip if it's undefined. Click **define as global**, enter the value (optionally secret), done — the chip turns green. Chips also recognize variables captured by *earlier* steps in the suite, so a chain shows green even before the value exists.

## 7. Validating responses

Open a step's **Validate** tab. A step **fails** if any visual assertion fails, any `test()` fails, or the script throws.

### Visual assertions

| Rule | Example |
|---|---|
| Status code equals | `200` |
| JSONPath exists | `$.data.token` |
| JSONPath equals | `$.count` = `3` |
| Header equals | `Content-Type` = `application/json` |
| Body contains text | `"success"` |
| Response time below (ms) | `1500` |

### Validation script

```js
test("login succeeds", () => {
  expect(response.status).toBe(200);
});
test("token looks like a JWT", () => {
  expect(response.json().token).toMatch(/^eyJ/);
});
test("id matches the one captured in step 1", () => {
  expect(response.json().id).toBe(variables.get("userId"));
});
test("fast enough", () => {
  expect(response.time).toBeLessThan(1500);
});
```

Each `test()` becomes its own pass/fail line in run results and reports. Full API in [§15](#15-script-api-reference).

## 8. Running: single step, whole suite, cycles

### Single step — the ▶ / Send button

Click **▶** on a step row (or **▶ Send** in the detail header) to run **just that request**, using your current **unsaved** edits plus all suite/global variables. The response appears inline: status, time, assertions, captured values, script logs, body. Nothing is persisted.

**Chain testing**: suite-scope captures from a Send are folded back into the suite variables (you'll see a toast). Send step 1, then Send step 2 — it will use step 1's captured token. This is the fastest way to debug a chain one request at a time.

### Whole suite

Set **cycles** (1–100) and **stop on failure** in the run bar, hit **▶ Run**. Unsaved changes are saved first; you land on the live run page.

**Cycles** repeat the entire suite N times — each cycle starts with a fresh variable scope (suite + globals re-read; runtime captures cleared), so cycles are independent measurements. Use cycles for soak/consistency checks; the report aggregates across all of them.

**Stop on failure** skips the remaining steps of a cycle after the first failing step (the skipped ones are recorded as `skipped`).

## 9. Run history & reports

**Runs** lists every execution (filterable per suite via the suite row's *Runs* button) with live status. Click one to open the detail:

- Summary card: steps passed, assertions passed, duration; refreshes every second while running.
- Per cycle, per step: expand to see the resolved request (auth headers redacted), response status/time/headers/body, every assertion with its failure message, captured variables, and script `console.log` output.

**Generate report (stub)** produces a structured JSON document for the finished run — view it in the modal or **⬇ Download JSON**. It's deliberately a stub: the JSON shape is the contract, and HTML/PDF rendering plugs in behind the same endpoint (`POST /api/runs/:id/report`) later.

## 10. The suite composer

Build a new suite by cherry-picking requests — even across different suites.

1. In any suite editor, check **🧺 Composer** in the header. A small floating box appears — **drag its header** to move it anywhere.
2. Collect requests: click **＋** on step rows, or **drag a row and drop it onto the box**.
3. The basket persists while you navigate — open another suite and keep collecting.
4. Reorder with ↑/↓ (this becomes the new suite's step order), name it, click **Create suite ➜**.

Steps are **copied** with their validations and captures — source suites are untouched. Any suite variables the picked steps reference are carried into the new suite automatically (first source wins on name clashes).

## 11. Exporting to Postman

**Suites → Export** downloads the suite as a **Postman collection v2.1** (`<name>.postman_collection.json`) — openable in Postman, or re-importable here (handy as a backup/share format).

Included: folder structure, requests (method/URL/params/headers/body/auth), suite variables (**secret values exported blank**), and scripts:

- Steps that still carry their **original imported `pm` scripts** export those verbatim.
- Otherwise, **visual assertions and captures are translated** into a generated `pm.test` script (e.g. *status = 200* → `pm.response.to.have.status(200)`; captures → `pm.collectionVariables.set(...)`).
- Sandbox-mode scripts aren't `pm`-compatible, so they're embedded as clearly-marked **comments** — nothing is silently lost.

The export reflects the suite's **current edited state**, so it's also the way to hand your improvements back to Postman users.

> Moving a suite to **another Hermes instance** (your laptop → the Docker stack → prod)? Use a bundle instead — see §12. The Postman format cannot carry polling, suite settings, sandbox scripts or attached file bytes.

## 12. Migrating suites between instances

**Suites → Migrate** downloads a **Hermes bundle** (`<name>.hermes-bundle.json`) — a lossless snapshot of one suite. **Suites → Import bundle** loads it on the target instance. Both work on either backend engine, and a bundle from one engine imports into the other.

Use this whenever the suite must arrive *runnable*: the bundle keeps everything the Postman format drops.

| | Postman export | Hermes bundle |
|---|---|---|
| Requests, headers, auth, folders | ✅ | ✅ |
| Visual assertions & captures | translated to `pm` script | ✅ kept as-is, still editable |
| Sandbox scripts | comments only | ✅ still executed |
| Polling (interval / timeout / stop script) | ❌ | ✅ |
| Suite settings (cycles, stop-on-failure, timeout) | ❌ | ✅ |
| Attached files (form-data file parts) | placeholder, no bytes | ✅ bytes embedded, re-uploaded on import |
| Referenced global variables | ❌ | ✅ (the ones this suite uses) |
| Opens in Postman | ✅ | ❌ Hermes only |

**Migrating, step by step**

1. On the source instance: **Suites → Migrate** on the row you want. Leave *Embed attached files* on unless the target already has them.
2. Save the `.json` it downloads.
3. On the target instance: **Suites → Import bundle** → pick the file → **Import bundle**.
4. The result panel lists anything that needs attention. **Open suite & run** takes you straight to the editor.

**What import does — and does not — touch**

- It always creates a **new** suite; nothing existing is overwritten. A name clash becomes `My suite (imported)`.
- Attached files are re-uploaded into the target's own file store and every form-data part is repointed at the new file ids — so a migrated suite never references files that only exist on the source machine.
- Global variables the suite references come along. Values already present on the target are **kept** unless you tick *Overwrite globals that already exist here*.

**Secrets are not in the bundle by default.** Secret values export blank, and both the bundle and the import result list which keys need filling in on the target. An admin can tick *Include secret values in plaintext* — that writes real credentials into a file on disk, so treat it like one. Non-admins cannot enable it at all (the server rejects the request, not just the checkbox).

Two other things worth knowing: files are embedded as base64, so a suite with large attachments makes a large bundle (you get a warning past ~20 MB). And a bundle from a newer Hermes is refused outright rather than half-imported — upgrade the target first.

## 13. Appearance & themes

Quick-switch from the **top-bar dropdown**, or manage everything on the **Appearance** page.

- **System** (default) follows your OS light/dark preference live.
- **8 presets**: Light, Dark, Midnight, Nord, Dracula, Solarized Light, Sepia, High Contrast.
- **Custom themes**: click **customize** on any preset → the builder opens with a color picker + hex field for each of the 12 design tokens, a corner-radius slider, and a dark flag. **Every change previews live across the whole app**; *Cancel* reverts, *Save & apply* persists.
- Custom themes live in your **browser** (localStorage). Use **export** / **⬆ Import theme JSON** to move them between machines or share with teammates.

## 14. Settings, users & security

- **Change password** — for your own account (min 6 chars).
- **Backend engine** — pick which backend serves your requests, **Node** or **Go** (admin only; see §16). Everyone else sees the current selection read-only.
- **Users (admin only)** — add users with a **role** (Admin / Moderator / NPC), delete users (not yourself).
- Passwords are bcrypt-hashed. The JWT signing secret is auto-generated and persisted in the data directory (`JWT_SECRET` env to override).
- **Secret variables** are masked in the UI and blanked in exports, but stored plaintext in the local SQLite DB — treat `backend/data/` accordingly.
- `CAPTCHA_BYPASS=1` (env) accepts the captcha text `bypass` — for API testing and CI only; never set it in production.

### Roles

Every user has one of three roles. The backend enforces them; the UI hides controls a role can't use.

| | **Admin** | **Moderator** | **NPC** |
|---|:---:|:---:|:---:|
| View everything | ✓ | ✓ | ✓ |
| Create / edit suites, import, variables, files | ✓ | ✓ | — |
| Delete anything (any tab) | ✓ | — | — |
| Run / execute suites (incl. Send) | ✓ | ✓ | ✓ |
| Appearance & Docs | ✓ | ✓ | — |
| Manage users · switch engine | ✓ | — | — |

NPCs are "look and run": they can browse suites and execute runs, but can't change anything. Moderators can build and edit but never delete.

## 15. Script API reference

Scripts run **server-side** in a sandbox: 2-second timeout, no filesystem, no network, no `require`. Available globals: `response`, `variables`, `test`, `expect`, `fail`, `console.log`, `JSON`, `Math`.

### `response`

| Member | Meaning |
|---|---|
| `response.status` | HTTP status code (number) |
| `response.statusText` | Status text |
| `response.time` | Response time in ms |
| `response.headers` | Header map, **lower-cased keys** |
| `response.header(name)` | Case-insensitive header lookup |
| `response.json()` | Body parsed as JSON (throws if not JSON) |
| `response.text()` | Raw body string |

### `variables`

| Member | Meaning |
|---|---|
| `variables.get(key)` | Resolved value (runtime > suite > global), or `undefined` |
| `variables.set(key, value)` | Set **suite-scope** — *capture scripts only* |
| `variables.set(key, value, "global")` | Set + persist a **global** — *capture scripts only* |

Non-string values are stored JSON-stringified. Validation scripts can read but not set.

### Assertions (validation scripts)

`test(name, fn)` registers a named check; a throwing `fn` marks it failed. `expect(actual)` matchers:

`toBe` (===) · `toEqual` (deep, via JSON) · `toContain` (string/array) · `toMatch` (regex or pattern string) · `toBeLessThan` · `toBeGreaterThan` · `toBeDefined`

`fail(message)` aborts the script and fails the step. `console.log(...)` output appears under **Script logs** in run results.

## 16. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Step errors with *"Unresolved variables in URL"* | A `{{var}}` had no value at send time. Check the chips on the Request tab; define the variable or make sure the capturing step runs (and is enabled) earlier. |
| `{{var}}` chip is red but a capture sets it | Chips only recognize *visual* captures and `variables.set("name", ...)` written with a **literal string** in earlier steps' scripts. It will still resolve at run time. |
| Single-step Send fails but the full run passes | Send doesn't run earlier steps. Send the capturing step first (its captures fold into suite variables), then retry. |
| *"Captcha incorrect or expired"* | Captchas are single-use and expire in 5 min — read the new image and retry. |
| Login says *"Too many attempts"* | Per-IP rate limit: wait 60 seconds. |
| Response body shows *(truncated)* | Bodies are stored up to 64 KB per step in run history; the request itself was sent/received in full. |
| Script fails with *"Script execution timed out"* | 2-second sandbox limit — avoid heavy loops. |
| `variables.set is only available in capture scripts` | Setting variables belongs on the **Capture** tab; the Validate tab is read-only by design. |
| Imported requests missing bodies/auth | Multipart files and OAuth/AWS auth aren't supported yet — edit the step to fill the gap. |
| Where is my data? | `backend/data/app.db` (SQLite). Custom themes + composer basket live in the browser's localStorage. |
| I deleted a collection — are its suites broken? | No. Suites own a full copy of their steps; only the "reset to imported original" reference point is unaffected either way. |
| A button I expected is missing | Your role may not permit that action (see §13 Roles). Moderators can't delete; NPCs are read-only + execute. |

## 17. Backend engine (Node ⇄ Go)

Hermes runs on either of two interchangeable backends that serve the exact same API:

- **Node** — Express + TypeScript, `node:vm` script sandbox.
- **Go** — chi + goja, a single static binary.

Both read the **same database and the same session secret**, so switching engines keeps you logged in and shows identical data — it swaps the engine underneath, nothing else.

- The **top bar** shows a read-only **Engine** pill (🐹 for Go, ⬡ for Node) with a live green/red health dot. Click it to jump to Settings.
- **Admins** switch the engine in **Settings → Backend engine** by clicking the Node or Go card. The page reloads and every request now goes to the chosen engine. Non-admins see the selection but can't change it.
- If a card's dot is red, that backend isn't running — start it (`cd backend-go && go run .` for Go) or ask an admin.

Why two? It lets you A/B the same suites and data across two implementations — handy for comparing behavior, performance, or migrating. Script results and error messages are identical on both, by design.
