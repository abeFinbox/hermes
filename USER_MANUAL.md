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
18. [Load testing with Hera](#18-load-testing-with-hera)

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

Always on the row: the **⠿** drag handle, the **checkbox** that enables/disables the step (disabled steps are skipped but kept), the method chip, and the step **name** — which gets the whole width, because that is what you scan the list for.

The action icons — **＋** add to composer (composer on only) · **▶** run just this step · **↑/↓** reorder · **⧉** duplicate · **✕** delete — appear when the row is hovered, focused or selected, floating over its right-hand edge so they never shorten the name. On a touch screen (no hover) they stay visible and get bigger hit areas. Tab still reaches them, and the full name is in the row's tooltip.

For long suites the list scrolls inside its own column, so the detail panel stays visible.

**Reordering by drag**: grab a row anywhere (or by its ⠿ handle) and drop it where you want it. A line marks the insertion point — top half of a row means *before* it, bottom half *after* it — and a drop zone appears under the list for "move to the end". The step you had selected stays selected wherever it lands, and like every other edit the new order is not saved until you hit **Save**.

Dragging is disabled while the step filter is active: the rows you see are a subset, so "drop below this one" would put the step next to a neighbour that isn't actually adjacent. Clear the filter, or use **↑/↓**, which always work. With the composer on, dragging a row onto the basket still adds it there — the two drops don't collide.

### The step detail — three tabs

- **Request** — method, URL, query params, headers, body (none / JSON / raw / form-urlencoded / **form-data**), auth (none / bearer / basic). Every text field supports `{{variable}}` placeholders. Below the URL, **chips** show every placeholder the step uses: green = defined, red = undefined (click *define as global* to fix it on the spot). Imported steps have a **↩ Reset to imported original** button.
- **Validate** — checks that run after the response. See [§7](#7-validating-responses).
- **Capture** — pulls values out of the response into variables for later steps. See [§6](#6-variables--chaining).

### Beautifying and minifying a payload

In the **Request** tab, JSON and raw bodies get two buttons: **✨ Beautify** re-indents with a 2-space indent, **🗜 Minify** collapses the payload onto one line. They are exact inverses — minifying a beautified payload gives back the original text, character for character.

Both understand templated payloads, which plain JSON formatting cannot: every `{{token}}` is masked before parsing and restored afterwards, so `"id": "{{$guid}}"` keeps its quotes and a bare `"amount": {{amount}}` — not valid JSON on its own — survives untouched. If the body is genuinely malformed, nothing is changed and the parse error is shown as a toast.

### Scrolling a long step

The step panel is its own scroller. The step name, the tab strip, and the **method + URL + placeholder chips** stay pinned at the top; everything from **Query params** downwards scrolls inside the panel — so the wheel works with the cursor over the step, and the URL you are editing against stays on screen. The URL row is visible on the Validate, Capture and Poll tabs too.

Picking another step resets that scroll to the top. Once the panel's own content reaches its end the wheel continues onto the page, and on narrow windows (under 820px, where the columns stack) the panel goes back to growing with the page instead of nesting a short scroller.

### Keyboard: send with ⌘/Ctrl + Enter

**⌘ + Enter** (macOS) or **Ctrl + Enter** (Windows/Linux) sends the selected step, from anywhere in the editor — including while the cursor is in the URL box or the body textarea. It is the same action as **▶ Send**, so it respects the environment picked in the run bar and uses your unsaved edits.

When a script bench panel is open (Validate / Capture / Poll), the same shortcut runs **the bench** instead — you are looking at it, so running it beats firing a real request. Dialogs (cURL import, delete confirmation) keep the keyboard to themselves.

### Attaching files (form-data body)

To send a `multipart/form-data` request (file uploads), set the body mode to **form-data**. You then build the body from typed fields:

- **Text field** — a plain key/value part (the value supports `{{variables}}`).
- **File field** — pick a file from the **Files store** (see below). The file's bytes and original name are sent as that part.

Hermes sets the `Content-Type` (with the multipart boundary) automatically — don't add it manually. Use **↻ Refresh files** if you just uploaded something, or **Manage files ↗** to open the store. If a referenced file has been deleted, the field is flagged and the step errors until you attach a new one.

**The Files store (Files in the sidebar)** is a shared, server-side folder for upload files. Upload once (drag-and-drop or the button, up to 25 MB each) and reference the file from any request's form-data body. Files live on the server (`DATA_DIR/files`), not inside suites — so they're reusable, don't bloat exports, and are covered by the same backups as the database. Deleting a file here means any request pointing at it needs a new attachment.

### Suite variables tab

Key/value pairs scoped to this suite — the **fallback** layer, used when neither the selected environment nor a global defines the name (see [§6](#6-variables--chaining)). This is where a Postman import parks its collection variables. The checkbox column marks a value as visible; unchecked = secret (masked).

### Settings tab

- **Default cycles** — pre-fills the run bar.
- **Request timeout (ms)** — per request (default 30 000).
- **Stop on failure by default** — pre-checks the run-bar option.
- **Run captures even when the step failed** — useful for capturing diagnostic values from failing responses.

## 6. Variables & chaining

### Scopes and precedence

When `{{name}}` is resolved, the first match wins:

1. **Runtime** — captured earlier in the *current run/cycle*
2. **Environment** — the environment selected for this run (see below)
3. **Global** — the Variables page, Global tab (shared by all suites)
4. **Suite** — the suite's Variables tab

So a captured `{{token}}` beats everything, the environment's `{{base_url}}` beats the global one, and a global beats the suite's own value.

**This is deliberately not Postman's order**, where collection variables outrank the environment and globals. The reason is what suite variables usually *are* here: values that arrived with a Postman import — a `base_url` pointing at whatever host the collection was recorded against. Under Postman's order those imported values silently shadowed the environment you selected and the globals you had just edited, so switching environment appeared to do nothing. Suite variables are the **fallback** layer: what a suite ships with, used when nothing above it defines the name.

Two consequences worth knowing:

- To override one value for a single suite, put it in that suite's **environment** (or capture it at runtime), not in the suite's Variables tab — the tab is now the bottom of the chain.
- A capture with scope **global** writes to the globals as asked, but if the selected environment defines the same name, the environment still wins on read. Capture to **suite** or **runtime** scope in that case — both also write the runtime layer, which outranks everything.

Suite variables reset at the start of each cycle; globals persist (and global captures are saved permanently, immediately).

### Environments — reusable variable sets

An **environment** is a named set of variables (`dev`, `staging`, `local`, whatever you call it) that you point a run at. Same suite, same steps, different `{{baseUrl}}` and credentials.

Manage them on the **Variables** page: the tab strip is the scope selector — **Global** plus one tab per environment. Buttons there create, rename, duplicate and delete environments (deleting is admin-only, like every other delete).

Selecting one:

- **Suite editor → run bar → environment**: this is the suite's *default*, saved with the suite. It applies to **▶ Run**, to a single-step **Send**, and is carried over to Hera by **⚡ Load test**.
- **Hera → New load test → Environment**: pre-filled from the suite's default, overridable for that one test.
- `(none)` is always available and means globals + suite variables only.

Every run records the environment it used — by id *and* by name, so old runs stay readable after a rename or delete. You can see it on the run detail page ("Environment: dev") and on a load test's detail page. Deleting an environment clears it from any suite that pointed at it; those suites fall back to `(none)` rather than breaking.

Two suites can run against different environments at the same time — the selection is per run, not a single global switch.

### Dynamic tokens — `{{$guid}}`, `{{$timestamp}}` …

Some values should not be stored anywhere, because they must be different on every request. Those are written as `{{$name}}` and generated by the runner at send time:

| Token | Produces | Example |
|---|---|---|
| `{{$guid}}` | Random UUID v4 — the usual choice for a link id | `3f2b9c74-5e41-4a8f-b0d2-9c1e77a4e5b3` |
| `{{$randomInt}}` | Random integer, 0–1000 | `742` |
| `{{$randomHex}}` | 16 random hex characters | `a3f19c02b7d45e68` |
| `{{$timestamp}}` | Now, Unix seconds | `1788945353` |
| `{{$epochMillis}}` | Now, Unix milliseconds | `1788945353514` |
| `{{$isoTimestamp}}` | Now, ISO 8601 UTC | `2026-09-09T09:15:53.514Z` |
| `{{$date}}` | Today in UTC | `2026-09-09` |

They work anywhere a variable works — URL, query params, headers, the body, and bearer/basic auth — and in scripts via `variables.get("$guid")`. In the editor they show up as a blue **generated** chip rather than a red undefined one.

```json
{
  "link_id": "{{$guid}}",
  "requested_at": "{{$isoTimestamp}}",
  "business_date": "{{$date}}",
  "epoch": {{$timestamp}},
  "nonce": {{$randomInt}}
}
```

**Evaluated per occurrence**, like Postman. Two `{{$guid}}` in one payload are two different UUIDs, and the same token in step 1 and step 5 differs. When one value has to appear in several places — the usual case for a link/session id — generate it once and capture it:

- put `{{$guid}}` in the request that creates the resource, then capture the id the server returns; or
- capture it directly in a capture script: `variables.set("link_id", variables.get("$guid"))` — from then on `{{link_id}}` is that one id for the rest of the run (a new one next cycle).

Under Hera the tokens are generated **inside each k6 iteration**, so every virtual user sends its own id and its own "now" — verified with 3 VUs over 12 s: the timestamp assertion held on all 60 iterations.

Two details worth knowing:

- Nothing is stored, so nothing can shadow them: a variable name can never start with `$`.
- In the Hera **Targets** preview a dynamic token stays literal (`.../items?rid={{$guid}}`) and is listed as a runtime token. That is deliberate — the preview would otherwise show a UUID that is not the one sent, and a host has to be pinned to one IP before the run starts.

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

### Trying a script without sending a request (script bench)

Under the **Validate**, **Capture** and **Poll** tabs there is a **🧪 Try …** button. It opens a small panel where you type a response — status, status text, response time, headers (`Name: value`, one per line) and body — and run this tab's logic against it. No HTTP request is made and nothing is saved.

Why it's there: the alternative is re-sending the real request until an assertion fires, which needs the service up and cannot reproduce the cases you most want to cover — a 500, a truncated body, the third poll attempt. Here the response is just input you control.

What it reports:

- **would PASS / would FAIL** — the same verdict the step would get.
- **Assertions** — visual rules *and* every `test()`, in the order a run reports them.
- **Would capture** (Capture tab) — each variable and the value it would receive, with the scope the rule declares. Nothing is written, not even a `global` capture.
- **Variables read by the script** — every name the script asked for and what it resolved to, using the environment currently selected in the run bar. This is the fast way to catch a `{{token}}` that is silently undefined.
- **Would stop / would continue** (Poll tab) — whether `stop()` was called, i.e. whether polling would end on an attempt like this.
- **console.log** output and any script error (syntax error, bad `JSON.parse`, timeout).

**Fill from last response** copies the most recent single-step **Send** result into the fields, which is usually the quickest starting point: send once, then edit the body to the failure case you want to assert on.

Every role can use the bench, including read-only `npc` — it sends nothing and writes nothing.

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
| `variables.get(key)` | Resolved value (runtime > environment > global > suite), or `undefined` |
| `variables.get("$guid")` | Any [dynamic token](#dynamic-tokens--guid-timestamp-) — generated on each call, so two calls give two values |
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

## 18. Load testing with Hera

Everything so far runs your suite **once, one request at a time**. Hera runs it
**concurrently**: every virtual user (VU) walks all enabled steps in order,
carrying captures between them, then loops for the duration you set. Your
existing suite *is* the load test — there is nothing new to author.

> **What Hera tells you, and what it does not.**
> Hera answers *"does this break when N users hit it at once?"* — session
> collisions, race conditions, 429s and 5xxs that never appear at 1 user.
> It is **not** a capacity-planning latency benchmark. k6 timestamps requests in
> userspace, so if the machine running Hermes is busy, k6's own scheduling
> stalls get attributed to your target. For numbers you would put in a capacity
> plan, run k6 on a dedicated box.

### Starting a run

**Hera → New load test.** Pick a suite, set **virtual users** and **duration**,
press start. From the suite editor there is also a **⚡ Load test** button, which
saves first and jumps here with that suite selected.

The caps under each field (`max 20`, `max 60s`) are this server's limits. Ask for
more and the server reduces it rather than refusing — the run then reports what
it actually used.

**Thresholds** (under *Advanced*) decide the verdict. With none set, a test that
finishes is reported **passed** however slow it was — only a k6 failure or a
broken script fails it. Set a p95 or an error-rate threshold to get a real
pass/fail.

**Environment** picks the variable set every virtual user resolves against. It is
pre-filled from the suite's default and can be changed for this test alone;
`(none)` means globals + suite variables only. Switch it and the **Targets** list
below re-resolves immediately, so you can see that you are about to load `staging`
and not production before you start. The run row records the environment (by name
too), and a step's rebuilt cURL uses the environment that run actually used.

**Targets** shows exactly where the load will go, resolved from your variables.
Hosts are pinned to a resolved IP before the run starts, so a DNS change
mid-run cannot redirect your load somewhere else. IPv6 targets are handled too —
including `localhost`, which resolves to `::1` first on macOS.

### Load modes — the shape of the run

**Mode** in the launch form decides how load arrives over time. A mode never adds
load beyond the virtual users and duration you already set: `VUs` is the peak,
`Duration` is the total, and the stages always add up to exactly that total. Every
server cap therefore applies identically in every mode.

| Mode | Shape | Use it to answer |
|---|---|---|
| **Constant** | flat, full load for the whole run | "how does it behave at N users" |
| **Smoke** | 1 virtual user (whatever you typed) | "does this suite even work under k6" |
| **Load** | ramp up 20%, hold 60%, ramp down 20% | "how does it behave through a normal busy period" |
| **Stress** | four steps at 25/50/75/100% of your VUs | "at which step does latency turn" |
| **Spike** | low baseline, sudden surge to full, then recover | "does it survive a burst, and does it recover" |
| **Soak** | steady, for a long time | "does it drift, leak or degrade over time" |
| **Rate** | fixed arrival rate, VUs are just budget | "what happens at exactly N iterations/s" |

The form shows the derived shape before you start — `0→20 over 12s, hold 36s,
20→0 over 12s` — and the run page records which mode ran.

Two things worth knowing:

- **Soak is capped by `HERA_MAX_DURATION_SEC`** (300s by default). A real soak
  wants tens of minutes, so an operator has to raise that ceiling first.
- **Rate mode counts ITERATIONS, not requests.** One iteration is one full pass
  through the suite, so a 7-step suite at 10/s is roughly 70 requests/s. If the
  target cannot keep up, k6 does not slow down — it reports **dropped
  iterations**, which appears as its own tile on the run page. That number is the
  point of the mode: it means the arrival rate exceeded what the system could
  absorb. A run that drops nothing sustained the rate.
- If a run is too short for its shape (a spike needs at least 10s), Hera runs it
  flat and says so in the form rather than emitting one-second ramps.

### What Hera can point at

**By default, only this instance's own `/mock` API.** That is not a crippled
default — `/mock` has a login → token → items chain and `/mock/job` for async
polling, so you can try the whole thing safely. To load-test anything real, an
operator sets `HERA_TARGET_ALLOW`.

Permanently blocked, and no configuration can widen this: cloud metadata
endpoints (`169.254.0.0/16` and friends), IPv6 link-local and unique-local
addresses, and non-`http(s)` schemes. Pointing Hera at Hermes' own `/api` is
refused too — hammering the API you are reading results from takes the UI down
with it.

### Reading the results

| Panel | What it means |
|---|---|
| **Requests / Error rate / Requests-s** | totals for the whole run |
| **p95 / p99** | response-time percentiles across every request |
| **Checks** | your assertions and `test()` calls — `400/400` means all passed |
| **Script errors** | a capture/validation script threw. **Any non-zero value fails the run** |
| **Latency percentiles** chart | ⚠️ **cumulative** — see below |
| **Throughput / Virtual users / Error rate** charts | instantaneous, from the change between samples |
| **Per step** | requests, error rate and latency for each step; plus **Polls** and **Wait p95** for polled steps |

The latency chart is **cumulative over the run so far**, because k6 reports a
running trend that cannot be un-averaged. A spike at second 50 is therefore
diluted rather than sharp. p99 appears only in the final summary. Throughput,
VUs and error rate *are* instantaneous.

**Wait p95** is the number to care about for an async pipeline: it is
time-to-completion — how long a caller waited for the work to actually finish
under this load — not per-request latency.

### The k6 output panel, and why a step failed

The **k6 output** panel at the bottom of a run streams k6's own output while the
run is going, roughly every 2 seconds, and keeps the last 64KB of it afterwards.
It is open by default while a run is live. Copy, wrap, **Errors only** and
**Follow** are in its toolbar; Follow keeps the newest line in view and switches
itself off as soon as you scroll up, so it never yanks you away mid-read.

For any step that ends non-2xx or fails an assertion, Hera adds one line of its
own:

```
HERA_DIAG step="Insights" tag=s07 status=401 code=1401 dur=42ms body="{'error':'missing or invalid bearer token'}"
```

That is the answer to "the step is 100% red and the numbers tell me nothing":
`status` is the HTTP status and `code` is k6's own error code, which is what
distinguishes a real 401 from a DNS failure, a TLS rejection or a timeout — cases
where there is no status at all.

Three things worth knowing:

- **The limit is per virtual user.** `HERA_DIAG_MAX` (default 3) is per step *per
  VU*, so a 20-VU run can show up to 60 lines for one step. Enough to see a
  pattern, not enough to bury the log.
- **The response body is included**, truncated to `HERA_DIAG_BODY_MAX`
  characters (512 by default) and flattened to one line, with double quotes
  shown as single ones. It is usually the only thing that actually explains a
  4xx. Note the trade-off: these lines are stored with the run, so bodies sit at
  rest in the database until the run is deleted — an operator pointing Hera at
  production data should set `HERA_DIAG_BODY=0`.
- **The URL is never printed**, not even truncated, because a resolved URL
  routinely contains `{{token}}` values. The step name and tag identify it
  instead.

If a run is live on the *other* engine, the panel says so rather than showing an
empty log: live output only exists in the process that launched k6. Once the run
finishes, either engine can show it.

### Reproducing a failing step with cURL

Every row in **Per step** has a **⧉ cURL** button. It gives you the request that
step actually sent, as a command you can paste into a terminal — same
construction order as the load test itself, so if the step returned 401 under
load, the command returns 401 too.

- **Real values, including secrets.** A masked `Authorization` header would
  reproduce a *different* 401 from the one you are chasing, which is worse than
  useless. So the command is built on demand, never stored with the run, and only
  admins (or moderators where `HERA_ALLOW_MODERATOR=1` is set) can see it.
- **Variables captured mid-run stay as `{{name}}`.** A `{{session_id}}` created
  by an earlier step cannot exist before the run; the modal lists those and you
  substitute a real value.
- **It is built from the suite as it is now.** Hera stores no request snapshot,
  so if the suite was edited after the run, the modal says so.
- File uploads become `-F 'field=@filename'` — the file has to be in your working
  directory for the command to run.

### How your scripts behave under load

Capture and validation scripts run **unchanged**. `response`, `variables`,
`expect`, `test`, `fail` and `stop` all work exactly as in §14. Three
differences, which preflight also lists before you launch:

1. **`variables.set(..., 'global')` becomes iteration-local.** Under load there
   is no shared store to write back to, and thousands of VUs writing one global
   would be meaningless. Chaining *within* each iteration — the part that
   matters — works normally. The summary counts suppressed global writes.
2. **`console.log` only emits for the first iteration of the first VU.**
   Otherwise a long run buries the real errors in noise. You still get one full
   trace.
3. **No 2-second per-script timeout.** A runaway script blocks its own virtual
   user until the run's overall watchdog fires.

### Polling under load

A polled step (§5) keeps polling under load — that *is* the user journey for an
async API. Two consequences worth planning for:

- **The request count becomes unbounded.** The rate cap and the duration become
  the real limits, so the "≈ N requests" estimate is replaced by a warning.
- **Expect few completed iterations.** A step that polls for 60 s means each VU
  finishes roughly one journey a minute, so a 30 s run may complete none.

### One at a time, and stopping

Only **one load test runs at a time** across the whole installation — both
backends share a database, so results stay comparable and the machine is not
fighting itself. Starting a second returns a clear "already running".

**Stop** asks k6 to stop; in-flight virtual users drain first, so the status
shows `stopping` briefly before it settles on `stopped`. Every role can stop a
run, including read-only npc.

### When Hera is unavailable

The page says so, with the reason. Hera needs the **k6 binary on the host running
the selected backend** — so the answer can differ between the Node and Go
engines, and switching engine may be all it takes. `↻ Recheck` re-probes without
a restart. A run is also refused on a machine with too little CPU to produce
honest numbers.
