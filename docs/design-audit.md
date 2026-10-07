# Hojicha Launcher: design audit and consistency plan

Audit of the renderer (`src/renderer/index.html`, `style.css`, `app.js`) as of 2026-10-07, including the uncommitted
Schematics work in the working tree. No code was changed. All values are CSS px (the window is zoomed to 110%, so
on screen they're 10% larger). Line numbers are `style.css` unless a file is named.

---

## 0. Which parts are older (from git history)

All UI lives in three files, so per-file dates don't help. Each style rule was dated with `git blame` and each
feature with the commit that introduced its selectors. The whole app is 7 days old, so "older" is relative.

| Date | Commit | What it introduced (visible UI) |
|---|---|---|
| Oct 1 | `39e8333`, `59a5d1b` *Redesign around hojicha* | **The design system**: palette, buttons (default/quiet/danger/primary/play), inputs, focus ring, sidebar, side lists, instance view, tabs, rows, consoles, dialogs, Accounts, Versions |
| Oct 2 | `5d3bc9b` | Title bar, activity pill, update button, type scale `--text-*` ("larger type") |
| Oct 2 | `407089c` | Line icons (`.icon`), meta row under the instance name |
| Oct 2 | `bbcff31` | Server view, Console, Online play, chips, `button.outline`, New server type picker |
| Oct 2 | `ca7b84e` | Grain, warm light, Close dialog |
| Oct 4 | `ddcbd0d` | Server **Settings** and **Files** tabs (`.save-bar`, `.setting`, `.file-list`) |
| Oct 4 | `e062d4a` | Matcha theme, theme switch |
| Oct 5 | `9c51414` | View-header rework (all views), item icons, icon picker, New instance start page (`.choice`) |
| Oct 5 | `3689646` | App **Settings page**, ⋯ instance menu (`.menu`), dense Mods rows, gear button |
| Oct 5 | `90129f6` | Kind pills (`.kinds`), split tabs with fixed toolbar |
| Oct 6 | `3d83e45` | Server ⋯ menu, Join menu, New server start page |
| Oct 6 | `53b8bd2`, `163117b` | **Skins dialog** |
| Oct 6 | `f7cbe48` | Popups fade, click outside closes |
| Oct 6–7 | `b5426da`, `54d48d0`, *uncommitted* | **Schematics**: sidebar row, view, viewer dialog, Create group, Name, Move, right-click menu, drop overlay |

**Proposed cutoff (needs your confirmation, Q1):** treat everything **through v0.6.4 (Oct 5)** as the source of
truth. Those commits reshaped the core tabs (the instance header, dense Mods list and kind pills all date from
Oct 5), so the Instance view you see today *is* Oct 5 work. Everything **from Oct 6 on** is "newer": server ⋯/Join
menus, New server start page, Skins, Schematics.

The Oct 6 menus and New server start page reuse `.menu` and `.choice` as they are, so in practice the newer work
that drifted is **Skins** and **Schematics**.

---

## 1. Audit: what's in use today

### Typography
One family everywhere: `--font` "Zen Kaku Gothic New" (bundled weights **400, 500, 700** only), `--mono` Cascadia
Mono for consoles and code. Body `15px / 1.5` with tabular numbers (`body`, 129).

| Role | Size / weight / line height | Where |
|---|---|---|
| Page title | 28 (`--text-xl`) / 700 / 1.2 | `.heading h1` 541 |
| Brand name | 24 / 700 | `.brand` 240 |
| Dialog title | 18 (`--text-l`) / 700, 4px below | `.dialog-body h2` 969 |
| Play button | 18 / 700 | `button.play` 182 |
| Settings group heading | 15 / 700, steam | `.settings-group h3` 881 |
| Sidebar section label | 14 / 500, dim | `.side-section h2` 382 |
| Row title | 15 / 500, steam | `.rows .title` 687 |
| Row secondary (author, desc, version) | 14, dim | `.rows .by/.desc/.version` 690–692 |
| Sub-line (sidebar, account kind) | 13 (`--text-xs`), dim | `.side-list .sub` 420, `.account-kind` 497 |
| Two-line stacks | line height 1.3 | `.account-text` 495, `.join-text` 822 |
| Hint / intro / status / error | 14, dim (error: ember) | `.hint` 979, `.intro` 672, `.status` 640, `.error` 209 |
| Field label | 14, dim; control inside at 15, steam | `.field` 974–975 |
| Buttons | 15 / 500; primary 700 | `button` 155, `.primary` 171 |
| Console | mono 13 / 1.5 | `.console` 803 |

Small group labels have **five** treatments (see conflicts below): `.side-section h2` 14/500 dim (Oct 1),
`.file-list h3` 13/500 dim (Oct 4), `.icon-heading` 13/700 dim (Oct 5), `.kind-divider` 13/400 dim with a rule
(Oct 5), `.settings-group h3` 15/700 steam (Oct 4).

### Buttons
Base (`button`, 149–159): 1px `--edge` border, **radius 8**, padding **7px 14px**, 15/500, height ≈ **38.5**.
Hover: border `--steam-dim` + background `--kiln-raised`. Disabled: opacity **0.7**. Transition 120ms.

| Variant | Look | Where |
|---|---|---|
| default | outlined | 149 |
| `.quiet` | no border, dim text; hover background `--kiln` | 161–162 |
| `.danger` | dim text, ember on hover/focus (always paired with default or quiet) | 164–165 |
| `.primary` | liquor fill, 700 | 167–173 |
| `.play` | pill, 18/700, padding 10/30, min-width 160, icon 15 | 176–195 |
| `.outline` | liquor border + liquor text | 841–842 |
| pills | radius 999, padding 3px 12px, 14: `.kinds button` 710, `.activity` 331, `.update-install` 277 | |
| icon-only | `.more-button` **40×40 round**, glyph 18 (567); `.settings-button` **36×36 radius 8**, glyph 16 (478) | |
| sidebar add | `.side-add`: borderless, "+" in liquor | 454–463 |

### Inputs, toggles, dropdowns
- Input/select (197–204): background `--roast`, 1px `--edge`, radius 8, padding 7px 10px, focus = liquor border
  (no outline ring). Placeholder full `--steam-dim`. Same height as a button.
- Compact select inside a menu: padding 3px 6px, 14 (`.menu-row select` 593).
- Switch (766–791): 38×22, edge track, leaf when on, 16px knob.
- Checkbox: native, `accent-color: liquor` (`.check` 976–977).
- Segmented: `.theme-switch` (289–323: 1px **edge** border, padding 2, buttons 1px 12px, sliding liquor pill).
- Radio cards: `.type-option` (984–1000) and `.choice` (1009–1036): 1px edge, **radius 10**, `--roast` on the
  dialog's `--kiln`, liquor border when chosen.

### Lists, rows, cards, panels
- Rows (`.rows`, 676–693): divider `rgba(clay, .7)` between rows, padding **12px 4px**, gap 14, 36px thumb radius 8.
  Dense mod rows: padding 6px 4px, gap 12, 28px thumb radius 6 (731–732). **No hover background** on rows.
- Empty/loading in a list: `emptyRow()` (`app.js:108`) → `.rows .empty-row` (756): 15px dim, **28px** vertical padding.
- Hover-highlight lists (sidebar, menus, file list): radius **6**, padding 5–7px 8–10px, background `--kiln-raised` (on kiln) or `--kiln` (on roast).
- Inset panels take the *other* surface: on main, `--kiln` (`.online-manual` 853); in a dialog, `--roast`
  (`.login-panel` 1150, `.upload-box` 1043). All **radius 10**, padding 12–16.
- Chips: radius 999, `--kiln`, 14 (858–862).

### Layout
- Window: title bar 52 tall; sidebar 264 wide (`--sidebar-width`), padding 10px 12px 14px.
- View (535): padding **28px 36px 0**, column flex.
- Header (539): title + meta on the left, `.header-actions` on the right (⋯, then the main action), **aligned to the
  bottom**, wrapping when narrow. The main action is always top right (Play / Start and join).
- Under the header: `.tabs` (645) with a clay rule, gap 22, active tab = 2px liquor underline.
- Tab body (661): padding 8px 0 24px. Split tabs (665–670): a fixed toolbar then a scrolling list that fades at the top.
- Toolbar (`.mods-bar` 702, `.search` 759): padding **12px 0 6px**, gap 8, **input flex: 1**, buttons after it;
  kind pills on their own line under it (708).
- Forms: `.settings-form` max-width 720, gap 22; `.setting` row: text left, control right, gap 24, padding 10 0.
- No max width on lists.

### Icons
`.icon` (597): 1em square, stroke **1.6**, round caps/joins, `currentColor`. Size set by font-size:
**15** next to text (`.meta-item .icon` 603, Play 192), **18** in icon buttons and choice tiles (`.more-button`, `.choice-icon` 1032),
16 in the gear (478). Pixel art at 16 (`.pixel-icon` 604) or 32 (`.item-icon` 422), `image-rendering: pixelated`.

### Colors
All palette values are variables in `:root` with a Matcha counterpart (46–117). Hardcoded colours: `#fff` +
`rgba(0,0,0,.5)` in the "+" hover overlays (`.item-icon::after` 444, `.skin-button::after` 1073), deliberately
theme-independent; `#000` in the scroll fade mask (functional). The `:root` comments state two rules: control edges
use `--edge` (≥3:1), and liquor is "the one strong colour: Play, focus, active tab".

### Popups and menus
- `dialog` (949–972): width **440** (480 Versions, 520 New instance and Icon), padding **24**, `--kiln`, 1px clay,
  **radius 14**. Body gap 12. Title h2 18/700 first.
- Actions: bottom, **right-aligned**, gap 8, margin-top 6, **quiet Cancel/Close first, primary last**.
- No × close button anywhere. Escape and a click on the backdrop close every popup (`app.js:4212`). 140ms fade.
- Menus (`.menu`, 569–594): min-width 220, padding 6, radius 10, items 7px 10px radius 6 weight 400, `hr` dividers.
  Labels are plain verbs with no "…" ("Rename", "Change icon", "Open folder").

### Copy conventions (visible text)
Older loading text uses the single "…" character ("Loading versions…", `app.js:956`, 1063, 1771, 1803, 1907).

---

## 2. Baseline (the design standard)

The standard is section 1 as written, through Oct 5. Condensed:

| Token | Value | Source |
|---|---|---|
| Type scale | 13 / 14 / 15 / 18 / 28 | `:root` 72–77 |
| Weights | 400 body · 500 labels, buttons, titles in rows · 700 headings, primary | 155, 171, 541 |
| Radii | 6 list item · 8 control · 10 card/panel/menu/console · 14 dialog · 999 pill/round | 396, 153, 1017, 955, 185 |
| Control height | ≈38.5 (15×1.5 + 7+7 + 2) for button, input, select | 154, 201 |
| Disabled | opacity 0.7 | 159, 791 |
| View padding | 28 36 0 | 535 |
| Toolbar | padding 12 0 6, gap 8, input grows | 702, 759 |
| Row | padding 12 4 (dense 6 4), divider clay .7 | 681, 731 |
| Dialog | 440 wide, padding 24, gap 12, actions right, quiet then primary | 949, 968, 971 |
| Icons | stroke 1.6; 15 inline, 18 in icon buttons | 597, 603, 567 |
| Empty state in a list | `emptyRow()`, 15 dim, 28 vertical padding | `app.js:108`, 756 |
| Surfaces | inset panel = the other of roast/kiln; hover = one step up | 853, 1150 |
| Accent | liquor only for Play, primary, focus, active tab, chosen | `:root` 55 |

### Conflicts inside the baseline (you choose: Q3–Q5)
1. **Icon-only button**: ⋯ is 40×40 round with an 18 glyph, the gear is 36×36 radius 8 with a 16 glyph (both `3689646`, Oct 5).
2. **Small group heading**: five styles (see Typography). Schematics and Skins each invented a sixth.
3. **Segmented control**: `.theme-switch` (edge border, 1/12 padding, sliding pill) vs `.kinds` (borderless
   pills). These do different jobs (one choice vs filter), so both may be right. They matter for Skins' arms switch.

---

## 3. Deviations in newer UI, most noticeable first

### High
| # | Where | Now | Baseline |
|---|---|---|---|
| H1 | Schematics header (`.schem-header`/`.schem-tools` 1168–1182, `index.html:175–211`) | Kind pills, sort select, view button, filter, two icon buttons all on the **title line**, centred. Controls are **30** (pills), **34** (select, icon buttons) and **38.5** (filter) tall side by side. Filter is fixed **160** wide. | Title line has only the title and header actions. Filter sits in a toolbar row below (padding 12 0 6, input grows), pills on the line under it, everything 38.5 tall. |
| H2 | Schematics list view (`.schem-row*` 1236–1265) | Rounded rows with a hover fill, no dividers, names **14/500**, padding 4px, a sticky header with sortable 13px column labels | `.rows`: dividers, no hover fill, titles **15/500**, padding 12 4 (dense 6 4). No sortable-column pattern exists in older UI. |
| H3 | Skins dialog (`index.html:502`) | **No title**, only `aria-label` | Every older dialog starts with an 18/700 h2 |
| H4 | Empty and loading states: Schematics (`app.js:3571, 3575, 3593, 3601`), Skins (`app.js:2494`) | `<p class="hint">`: 14, no padding, sits tight to the top | `emptyRow()`: 15, 28px above and below |
| H5 | Sidebar Schematics row (`index.html:39–49`, `.library-icon` 1163) | Outline icon **22**, stroke **1.2**, **liquor** colour, above Instances with no section label | Sidebar rows lead with a 32px item icon; strokes are 1.6; liquor is reserved for Play, focus and active tab |
| H6 | Group headings: `.schem-group` (1192: 14/700 dim, 28px above), `.skins-side h3` (1108: 14/700 dim) | 14/700 dim | Matches none of the five older styles (waits on Q4) |

### Medium
| # | Where | Now | Baseline |
|---|---|---|---|
| M1 | Name, Create group and Move dialogs (`index.html:598, 690, 704`) | `label.hint` above a bare input, 12px gap (the dialog's) | `label.field`: 14 dim label with the control inside, **5px** gap, input text 15 steam |
| M2 | Icon-only buttons: `.schem-icon-button` 34 sq r8 (1182), `.schem-back` 34 round **clay** border (1232), `.schem-step` 36 round (1328), `.skin-play` 32 round (1093) | four sizes, two shapes | 40 round or 36 r8 (Q3); edges in `--edge` |
| M3 | Right-click and View menus (`.schem-menu` 1273–1275, `app.js:3244–3281, 4768`) | min-width 190; disabled opacity 0.55; labels end in "..." ("Rename...", "Move to..."); the View menu's tick is a text "✓" padded with an em space | min-width 220; disabled 0.7; no "…" on menu items; the cape menu uses the svg tick (`.cape-tick` 1141) |
| M4 | Arms switch in Skins (`.pill-switch` 1103–1105) | **clay** border, buttons 3px 10px, no slide | `.theme-switch`: **edge** border (contrast rule), 1px 12px, sliding pill |
| M5 | Card radius: `.schem-tile` 1198, `.skin-view` 1090, `.schem-stage` 1343 | **12** | 10 |
| M6 | Folder breadcrumbs (`.schem-crumbs` 1228–1234) | 18px crumbs next to a 28px folder name, 34 round back button | No equivalent. Closest is title + meta. |
| M7 | Drop overlays: `.app-drop` 1356 vs `.skin-drop` 1129 | inset 10 / 8, radius 14 / 10, text 18 / 15, both weight **600** (not bundled: renders as 700) | They should share one style. Weights 400/500/700 only. |
| M8 | "..." vs "…" in visible text (`app.js:2494, 3098, 3244–3281, 3571`; `index.html:216`) | three dots | single "…" character |

### Low
| # | Where | Now | Baseline |
|---|---|---|---|
| L1 | Translucent surfaces (`.schem-format/-where/-ext/-size/-step/-check`, `.skin-drop`) | `color-mix(kiln …)` at 70 / 80 / 85 / 88 % | one value |
| L2 | `.move-row:disabled` 1282 | opacity 0.45 | 0.7 |
| L3 | Tick strokes: `.in-use` 2.4, `.cape-tick` 2.2, `.schem-check` 2.4 | three weights | one tick weight |
| L4 | `.add-skin` (1125) dashed border | clay | control edges use `--edge` |
| L5 | `.schem-sort` (1180) | 14px, height 34 | 15px / 38.5 (the 14px precedent is only inside menus) |
| L6 | `.move-tree` (1277) | bordered roast box with its own 10px top margin on top of the dialog gap | Versions and modpack lists aren't boxed |

### Probably meant to be unique (flag, don't fix without your say: Q7)
- **Schematic viewer** (`#schem-dialog` 1304–1353): padding 16/18/14 instead of 24, gap 10, actions margin 0,
  **Delete on the left**, primary button labelled **Back**, overlays on the picture. It's a near-full-window viewer.
- **Skins 3D stage**, the round play/elytra buttons over the model, the skin tiles.
- **Schematic tiles** themselves (pictures, folder stacks, pick circles): no older equivalent to match.

### Tier-B notes (only if you pick the stricter Oct 2 cutoff in Q1)
Server Settings/Files, the Settings page, icon picker (uses `.hint` for loading, `app.js:1907`), gear vs ⋯, and
the `.choice` start pages would then be "newer" too. I don't recommend this: it would mean pulling the current
Instance view back toward a look you replaced on purpose.

---

## 4. Keeping it consistent from now on

1. **Tokens in `:root`, equal to today's values** (so nothing moves):
   `--radius-item: 6px`, `--radius-control: 8px`, `--radius-card: 10px`, `--radius-dialog: 14px`, `--radius-pill: 999px`;
   `--icon-inline: 15px`, `--icon-button: 18px`; `--disabled-opacity: 0.7`; `--glass: color-mix(in srgb, var(--kiln) 85%, transparent)`;
   `--view-pad: 28px 36px 0`, `--dialog-pad: 24px`, `--toolbar-pad: 12px 0 6px`, `--row-pad: 12px 4px`.
   I would **not** impose a spacing scale: the older tabs use 2–36 in irregular steps, and rounding them would move pixels.
2. **Shared classes and JS helpers, not a framework** (the app is vanilla JS with `el()`):
   - `.toolbar`: the identical rules of `.mods-bar` and `.search`, merged with no visual change.
   - `.group-label`: one small heading, once Q4 is answered.
   - `.icon-button`: one size and shape, once Q3 is answered.
   - `.card` (radius 10, edge border, chosen = liquor) for `.choice`/`.type-option`/tiles.
   - Reuse what exists: `emptyRow()` for every empty or loading list, `.field` for every labelled input, `.menu` as is.
   - A dialog skeleton documented in the design doc (h2, body, right-aligned quiet → primary).
3. **`docs/design.md`**: a one-page reference with the tables from section 2, the dialog/header/toolbar
   skeletons, and "do / don't" for the accent colour, edges and copy ("…", no "…" on menu items).
4. **A guard script** (`npm run lint:css`, plain Node, no dependency) that flags `font-size`, `border-radius`,
   hex/rgb colours and `font-weight: 600` written as raw values outside `:root`. It warns rather than fails, with an
   allow-list for the deliberate exceptions (brand 24, login code 30, the "+" overlays).
5. **Screenshot diffs as the safety net** (below).

---

## 5. Phased plan

Every phase is one small commit, reviewed before the next. Verification uses the existing README screenshot rig
(sample data, never your real account), extended to every view, tab and popup **in both themes**, at a fixed
1200×690.

| Phase | Changes | Files | You see | How we verify older UI didn't change |
|---|---|---|---|---|
| **0. Safety net** | Land the uncommitted Schematics work first (Q2). Move the rig into `tools/ui-shots/` (outside `src/`, so not packaged), cache its sample data so runs are deterministic, add a capture list (≈30 screens × 2 themes) and a pixel-diff script using Electron's `nativeImage` (no new dependency). Take the **baseline set**. | `tools/ui-shots/*`, `package.json` (script only) | Nothing | Run twice and confirm a 0-pixel diff, so the rig itself is stable |
| **1. Tokens** | Add the section 4 tokens; replace matching literals in older rules only where the value is identical | `style.css` | Nothing | **0 differing pixels** on every screen, both themes |
| **2. Shared classes** | `.toolbar` (merge mods-bar/search), `.group-label`, `.icon-button`, `.card`; older markup gets the class next to its old one | `style.css`, `index.html` | Nothing | 0 differing pixels on older screens |
| **3. Design doc + guard** | `docs/design.md`, `tools/lint-css.js` | docs, tools | Nothing | n/a |
| **4a. Skins** | Title (H3), `emptyRow`-style loading (H4), heading (H6), arms switch (M4), radius (M5), drop overlay (M7), "…" | `index.html`, `style.css`, `app.js` | Skins dialog | Older screens: 0 diff. Skins: before/after shown side by side |
| **4b. Schematics popups** | Name / Group / Move use `.field` (M1); move list (L6) | same | Three small dialogs | same |
| **4c. Schematics menus** | min-width, disabled, labels, tick (M3) | `style.css`, `app.js` | Right-click and View menus | same |
| **4d. Schematics empty states** | `emptyRow`-style (H4), "…" (M8) | `app.js` | Empty folder, no results, loading | same |
| **4e. Schematics list view** | Rows per Q9 (H2) | `style.css`, `app.js` | List view | same |
| **4f. Schematics header** | Per Q5: toolbar row or one aligned line, one control height (H1, M2, L5) | `index.html`, `style.css` | The header | same |
| **4g. Sidebar row** | Per Q6 (H5) | `index.html`, `style.css` | Sidebar | same |
| **4h. Tidy** | Glass alpha, tick strokes, disabled opacities, card radius, `.add-skin` edge (L1–L4) | `style.css` | Barely | same |
| **5. Viewer** | Only if you want it (Q7) | | | |

Rule for every phase: **any** pixel change on an older screen stops the phase. I'd show it to you rather than
explain it away.

---

## Questions before we start

1. **Cutoff**: OK to treat everything through v0.6.4 (Oct 5) as the source of truth, and Oct 6+ (Skins,
   Schematics, server ⋯/Join menus, New server start page) as newer?
2. **Uncommitted Schematics work** (~2,100 changed lines across 9 files): commit it before Phase 0, so the
   baseline screenshots and later diffs aren't tangled with it?
3. **Icon-only buttons**: ⋯ (40 round, glyph 18) or gear (36, radius 8, glyph 16) as the standard for icon
   buttons in the main area? My suggestion: ⋯ style in views, gear style stays for the sidebar footer only.
4. **Group headings**: which older style should Schematics' "Folders / Schematics" and Skins' "Saved skins" use?
   `.settings-group h3` (15/700), `.side-section h2` (14/500 dim), `.file-list h3` (13/500 dim), or
   `.kind-divider` (13 dim with a line)?
5. **Schematics header**: is the one-line header (tools beside the title) intentional, to give the tiles more
   room? Or should it follow the other views: title line, then a toolbar row with a full-width filter?
6. **Sidebar Schematics row**: is the amber outline icon above Instances, with no section label, intentional?
7. **Schematic viewer**: leave it as a special screen (tight padding, Delete on the left, "Back" as primary)?
8. **Copy**: are "..." vs "…" and the trailing "..." on menu items in scope? It's visible text, but it's copy
   rather than layout.
9. **Schematics list view**: bring it in line with `.rows` (dividers, 15px names, no hover fill), or keep its
   table look (hover rows, sortable columns) as a new, documented pattern?
10. **Screenshot rig**: OK to commit it under `tools/ui-shots/` (dev-only, not in the installer) with cached
    sample data?
