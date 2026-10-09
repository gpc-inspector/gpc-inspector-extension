# The visual system

This document states what every color, weight, typeface and size in the popup means. A
new surface inherits these rules instead of adding a treatment of its own, and a reviewer
checks a diff against them rather than against taste.

`npm run harness` builds every popup surface into one scrollable contact sheet at 420px,
and the side panel at four widths (§12), rendered by the *real* view model and renderers
over fixture captures. Review against it, never against hand-written markup, which lets
CSS be checked against DOM the code does not emit.

---

## 1. The one rule that outranks the rest

**Nothing in the interface may encode a verdict.** No red, no green, no severity ordering,
no color that means "bad". The product reports facts and lets the reader conclude (D4).

Every rule below is downstream of that.

**Amber, the attention color (§2), sits close to this line.** It marks key findings: places
where the page may have mishandled GPC, or that someone checking the page would want to
examine. What it says is **"something interesting here"**. What it must never say is
compliant or non-compliant, good or bad: there is no red and no green, no value is ever
colored by what it is, and the copy under an amber mark states a fact and attributes every
assessment to its source.

---

## 2. Color

Five roles: three colors (neutral, accent, amber) and two structures (could not look, which
carries no hue, and finding, which carries amber on its rule and icon only). Each means
exactly one thing, and the test for a proposed sixth is whether it can be stated in one
clause without the word "or".

### Neutral: the whole product

`--tx` / `--tx2` / `--tx3` for text, `--card` / `--sub` / `--bg` for ground, `--line` /
`--line2` for rules. Everything is neutral unless a rule below says otherwise. A reader
should be able to describe this interface as "gray" and be substantially right.

### Accent (blue): interactive or active. Nothing else.

Links, the selected tab, the active filter, the signal-on dot, a switch that is on, the
primary button. And **every link is underlined**, always, so accent never has to carry the
affordance alone.

Overview links stay in the accent treatment. The credit for the classification list, which
carries two of them, is the last line of the Overview (§9). Links to further detail
otherwise live inside an expansion, such as the decoder link in a privacy-string row; a
vendor row does not repeat it.

**A cookie name is never accent.** Every place a cookie name appears is inside a row that is
itself a button (a request group, a vendor row), and the link color on one part of a
clickable row would advertise that part as the link.

**On the Requests tab, cookie names are monospace at full text strength (`--tx`)** while
everything around them sits at `--tx2`/`--tx3`: contrast by weight rather than hue, as for
emphasis (§3). The names the Overview's count includes take the attention color on this tab
too, in a domain's row and in a request's Set-Cookie line, so a name under the count can be
found here; every other name stays at `--tx`. On the Overview, cookie names take the
attention color (next section), which is not the link color.

A cookie *count* inside a sentence ("set 7 cookies") is not a name and takes no treatment.

What accent must never mean is "notable". Emphasis is weight, not color.

### Amber: look more closely here

Exactly one meaning: **a key finding the reader should look at more closely.** It is about
what the reader should *do*, not about what a thing *is*, so it is not scoped to one kind of
fact.

What earns it is a judgment call made by hand, against this test: is this where a page may
have mishandled GPC, or where someone reviewing the page would want to look first? The
current set:

- the headline count, **including a counted zero**
- the cookie names under the count, in the vendor rows and in the vendor panel, so a name
  in the headline can be matched to the same name in the list. This use is for matching,
  and is not a license to color other kinds of names. Only the names the count includes:
  a vendor in a category that does not count (Social, Content, Consent Managers and the
  rest) has its cookie names in `--tx2`, on its row and in its panel, and that color is the
  one sign that they are not counted
- the cookie names on a Tag containers row and in its panel, where amber and `--tx2` sit
  side by side on one row: a container's tags write the owner's names and other
  companies' and the site's, and only the owner's are counted. The two colors on one row
  are the only sign of which is which, so they are checked in dark and light
- an engine finding's (i) and its 3px left rule

The rows of the vendor list's last group, "No company found for this domain", are never
amber: nothing in the group is counted, so their names are `--tx2`, on the row and in the
panel, as on every row the count leaves out.

What never carries it:

- **a value, colored by what it is.** `denied`, "no", "not opted out" are never amber
  because of what they say. That would be red and green under another name (§1)
- **"we could not look"**. That is the extension's blind spot, not an interesting result
  about the page, and it keeps the dashed box below so the two never share a treatment
- the no-ad-tech dash, "no cookies set" and every other absence (§4)
- the Google Consent Mode row's values, Settings
- on the Requests tab, anything but a cookie name the count includes. The tab is the
  evidence view and nothing on it is a finding

**Form.** Text, icons, and one thin accent: a finding's left rule. **Never a ground**: a
wash is a banner, and a banner is a warning. The rule is as far as it goes: the finding's
ground stays `--sub` and its text stays `--tx`.

**The budget.** Cover everything amber with a hand: what is left must still be the
supporting detail, not the news. If a screenful shows more than a few amber marks, or if
amber is the first thing you would describe about the page, something that did not earn it
is carrying it. **A tone is not justified by its definition alone. It has to survive being
looked at next to everything else on the screen.**

### Could not look: a dashed box, without color

**An observation was not available to us.** Not "bad", not "warning", not "finding": a
statement about our own blind spot, which a reader needs before any number below it means
anything.

Transparent ground, a **1px dashed border in `--tx3` on all four sides**, text at `--tx2`.
Dashed because the claim is an incomplete outline. Nothing else in the popup is dashed, so
it looks like nothing else. It does not take the attention color: a gap in our own capture
is not a finding about the page.

What legitimately carries it: a capture capability that failed to install (so a row reads
"not observable"), and a capture marked incomplete (so the request list is short). Both are
short and both sit at the top.

Taken to its limit, it is the whole Overview: a page whose load was not observed, a page
that did not load, and a page the extension cannot inspect at all (a new tab, the browser's
own pages, an extension store, a local file) each show one box at the top and hide the
sections under it, since headings over nothing read as results. A page that cannot be
inspected also hides the status row, the request count on the Requests tab and the footer,
and its Requests tab shows the same box: nothing there describes a website, and reloading
does not change that. Which page that is comes from the tab's address, not from the record,
which can still hold the requests a new tab page made or the report of a frame inside an
extension store.

### Finding: the loudest thing on the page

A finding is the strongest claim this product makes, and it must look like it: `--sub`
ground, a **3px left rule**, and body text at full `--tx` strength. The rule and the (i)
take the attention color (amber, above), because a finding is the clearest case of "look
more closely here". The ground and the text carry no hue: a finding is a fact stated
firmly, not a warning, and the sentence still attributes any assessment to its source
("this is conflicting according to IAB guidance").

Every finding gets the same treatment. One finding more amber than another would be a
severity order, which §1 forbids. Contrast is the main lever: it buys prominence without
buying judgment, and the color is a mark on top of it, not a replacement for it.

### Never colored, specifically

Google Consent Mode values. `denied` is not good and `granted` is not bad; both are what
Google's consent store holds. The absence treatment alone separates a value from one never
set ("not set").

---

## 3. Emphasis

Emphasis is **weight** (`600`) applied to the value, never color, never accent. Current
users: the flagged GPP pair (GPC field set beside did-not-opt-out) and an emphasized
decoded field. Both are "these two facts are the ones IAB guidance pairs", which is a
statement about the pair, not a grade on the site.

---

## 4. Absence

**Dimmed and italic**, at the size of its context. One treatment for every absence:

- a consent value the container never declared
- "no signals observed"
- a vendor that set no cookies
- an empty privacy-string list, an empty request list, an empty vendor list

Italic is reserved for absence and nothing else. In particular a **qualifier**
("deprecated", "EU / GDPR") is dimmed but *upright*: it narrows a row's scope, it does not
report a missing value.

---

## 5. Monospace

**A machine-readable identifier: something a person could copy and paste back into a
tool.** Cookie names, hostnames, URLs, container and measurement IDs, header names, raw
privacy strings, hashes, status codes.

Not: category words, consent values, UI labels, or counts inside a sentence. That includes
the filter chips (`all`, `3rd party`), the Consent Mode values (`granted`, `denied`), and
the request row's meta line, whose `first-party` / `uncategorized` are our vocabulary
rather than the page's.

The test: if translating it would be correct, it is prose, and prose is never mono.

---

## 6. Type scale

Six sizes, and a seventh is a bug.

| token | px | used for |
|---|---|---|
| `--fs-display` | 40 | the count, once per page |
| `--fs-title` | 14 | screen title in the header |
| `--fs-body` | 12.5 | row labels and values, prose |
| `--fs-meta` | 11.5 | secondary lines under a row |
| `--fs-small` | 11 | hints, descriptions, detail grids |
| `--fs-label` | 10.5 | section labels, pills, mono detail |

`13` is the body default only, never a step of the scale.

### Section labels: two tiers

- **Tier 1** (`.section-label`, `.group-label`): `--fs-label`, `.08em`, uppercase, `--tx3`.
  Names a region of the screen.
- **Tier 2** (`.vdetail-label`, `.notice-group-label`, `.sr-head`, `.vgroup-label`):
  `--fs-label`, `.08em`, uppercase, `--tx3`, or `currentColor` at 70% inside a toned
  notice. Names a block inside an expanded panel, or a group inside a section.

Same size and tracking in both tiers; only the container distinguishes them. `.sr-head` is
not monospace: "Global Privacy Platform" is prose.

The VENDORS label carries the vendor list's one column heading (READ GPC) on its own
line, right-aligned over the column with the caret gutter reserved. One line, not a heading
and then a row of headings. The list's credit is not on this line; it is the last line of
the Overview (§2).

**The vendor list is grouped by category.** The heading says "Vendors"; a tier-2 label
over each group says which kind, in Disconnect's name for the category: Advertising and
Analytics, which the headline counts, then every other category in the list's order,
"Uncategorized" last (the same word as on the Read GPC lines and the Requests tab). A row is
a company in one category, so a company is listed under each category it has domains in.
No note and no rule before the categories the headline does not count: the labels do the
separating, and the color of the cookie names says which are counted. Inside a group, the
rows that set a cookie, then the rest, each alphabetical.

**After every category, "No company found for this domain"**: one row per third-party
registrable domain the list names no company for, with a cookie, a probe or a write the
browser did not store. It is a group of the list, not a section, and its rows are drawn
like every other row, with a Read GPC state judged per domain. The heading fits one line at
320px. The row's name is a domain, so it wraps (`vname-wrap`, as a container's name does)
rather than ellipsizes. A row whose only cookies were written and removed reads "cookies
written and removed"; one whose only write was not stored reads "no cookies set", what
happened, with the attempt in its panel. The heading makes no ownership claim, and no row
carries help text of its own.

**The names under the count are a list, not a run of text.** The number and the caption
stay centered. Under them the same labels stand in a column of their own, top-aligned with
their group's first vendor, and each vendor starts a line; a cookie list too long for its
line wraps with an indent under its vendor. The caption counts each kind, "4 advertising
and 2 analytics vendors", so nothing under the names repeats the split.

---

## 7. Rhythm

| token | value | applies to |
|---|---|---|
| `--pad-x` | 14px | every full-bleed row's horizontal padding |
| `--row-y` | 10px | a list row's vertical padding |
| `--gap` | 8px | between elements inside a row |

`--pad-x` is the same on every surface, so the left edge of the content does not move
between tabs.

List rows (vendor, request, request group, privacy string) all use `--row-y`. Settings rows
keep more room because each carries a description; the description supplies it as its own
margin rather than the row using a different padding.

---

## 8. Expandable rows

Four surfaces expand: vendor rows, request group rows, request rows, privacy-string rows.

**One affordance: a `›` on the right, rotating 90° when open.** `--tx3`, going `--tx2` on
row hover, with `background: var(--sub)` on hover and a 2px accent focus ring at
`outline-offset: -2px`. Identical on all four.

---

### The Tag containers section

A section of its own after Vendors, not a group of the vendor list: a container is the
site's tool, neither a vendor nor an endpoint. It uses the vendor row's own markup and
classes, a caret and a panel, with three additions: the container's id after the
product's name in the monospace face and `--tx2`; a name in `--tx2` beside amber ones on
one row; and a closing line naming ids found with nothing recorded. It has its own Read
GPC column heading and no line of text under the heading, and it is left out when the page
ran no container. A product's name and its id wrap to a second line before either is cut,
and an id is kept whole on a line (`AW-` never on one line and `7130000` on the next). The
Google tag's ids take a line of their own under its name. A panel's sections are the same,
in the same order, for every product.

### The First party section

The Overview's last section, after Tag containers and above the list credit, which stays the
last line. Headed "First party", as the Requests tab's party label reads. One row in a
vendor row's markup, closed until opened: the site's registrable domain, and under it every
cookie name from both lists, each once, in the row's small mono face; "cookies written and
removed" when only probes were seen. The names take the secondary color of a row the
headline does not count (`.vrow-other`), and the row has no Read GPC state and no column
heading: nothing in the section is counted.
Open, the panel starts with the sentence that says which cookies are here and which are
listed under a third party or under Tag containers, then two lists, "Written by the site's
advertising or analytics scripts" and "Set by the site's responses or other scripts". Each
key is listed once: a key a third party is counted for is under that third party only. An
empty list keeps its label and reads "none observed", or "not observable" for the first list
when cookies written by JavaScript could not be watched. The names are `--tx2` (the panel's
text color), run on as prose, and each is kept whole on a line (`.idtok`), comma included.
The signed and unsigned keys are listed together, as in every panel, and with the signal on
a name set only on requests without it is followed by "(request without GPC)". Cookies the
site set and removed within moments follow under the panel's own "Written and removed (not
counted)", only when there are any. The cap note follows the list that was full. The section
is hidden in the pending, no-data, ineligible and needs-reload states, when there is
nothing to list, and for a capture from before the summary. The headline's line "Also N
first-party cookies written by advertising or analytics scripts" is drawn only where the
section is not, so an older capture keeps it: the view model gives it a count of 0 where the
section lists the cookies.

### The panel's cookie table

Every panel's Cookies set list is a two-column grid, the name and its attributes. The name
column is `minmax(0, max-content)` and the attributes `minmax(48%, 1fr)`: the names take
what they need and never more than the attributes leave, and a name too long for its column
wraps anywhere, since an identifier has no word breaks to wait for. Three things may end a
cookie's attribute line or the list: "request without GPC", last on the line of a cookie
set on a request that did not carry the signal while it was on (the row above lists only
the signed ones); "request lost", last on the line of a cookie known only from a response
whose request went out before a worker restart, so its signal was not observed (a row with
only such cookies reads "cookies set, request lost"); and, after the list, "More cookies
were set than the extension can list. This list is incomplete." in hint text and upright, a
limit of the extension, neither an absence nor a could-not-look notice.

## 9. What is left out

**No vendor avatars.** No initial in a square beside a vendor's name. Nothing may make the
interface resemble Disconnect's own product: the extension uses and credits Disconnect's
list, whose license forbids implying an endorsement, and it blocks nothing. It is an
instrument readout, not a protection dashboard.

**No pill on the per-vendor check.** The vendor's GPC-check value is a plain right-aligned
`--tx2` label: a pill reads as a status badge, and "GPC Not Read" is an observation, not a
status. `.tag` is kept for the one place that is really a chip, the signal source beside the
status row.

**No hover-only list credit, and none behind a marker.** The credit for Disconnect's list is
a plain line at the foot of the Overview naming the list, its version and its license, never
shown only on hover or behind an (i) on a heading. The full statement is in Settings under
Credits, its last group. The list's license (CC BY-NC-SA 4.0) makes a visible credit a
condition of using the list.

---

## 10. A terse value needs a hover; a hover needs no mark

Six vendor check states have to fit a narrow column, so they are three words each, and
three words cannot say why "No script ran" is not an accusation, or why a tag that asked
cannot be named. Each carries a `title` explanation.

**A hover explanation gets no visual marker.** A dotted underline and a help cursor are an
affordance cue, and every place a hint lives here is either inside a row that is itself a
button (the vendor check) or the only underlined thing in its panel (the resource-types
label). Both would read as links that are not links, the false affordance §2 rules out.

So discoverability comes from layout instead, and the `title` is a bonus for whoever hovers:

- **The column heading carries the subject**, so each value can be an answer to it.
  "Requested GPC" over "No GPP call seen" is legible; the same value in an unlabeled
  column makes the reader reconstruct the question from the answer.
- **The expanded panel opens with the explanation in full.** The reader clicked to find out
  more, and that is more. It is the honest home for a sentence that will not fit in a cell.

This is not a license to write cryptic labels and explain them elsewhere. The label is
still what most people read; the long form is for the part that genuinely does not fit.

## 11. Reviewing a change against this

- Does any new color mean more than one thing? Name its meaning in one clause.
- Does everything amber pass "a key finding the reader should look at more closely"? Is any
  value amber because of what it says (that is red and green)? Is there an amber ground?
  Is amber on a could-not-look notice? Cover the amber with a hand: is what is left still
  the supporting detail?
- Is "we could not look" anything other than the dashed box?
- **Rank the blocks on the screen by how loud they look. Does that order match how much
  they matter?** This is the check that a per-tone definition cannot make for you.
- Is accent on anything that is not interactive or active?
- Is italic on anything that is not an absence?
- Is monospace on anything a translator would translate?
- Is there a seventh font size?
- Does a new expandable row use the shared caret, hover, and focus ring?
- Does it hold in the side panel at 320, 360, 420 and 600px (§12)? Is every domain whole,
  and does anything scroll sideways?
- Is a rule that differs by host under `[data-host="panel"]`, and nowhere else?
- Open `npm run harness` and look at the contact sheet before and after. Most of what this
  document rules out is invisible one screen at a time.

---

## 12. Two hosts: the popup and the side panel

One page, `popup.html`, runs in two places: the toolbar popup, and Chrome's side panel
(`?host=panel`, the manifest's `side_panel.default_path`). The same view model and the same
renderers draw both, so the two cannot disagree about what anything means. `popup.ts` marks
the root element with its host before any screen is shown, and every rule that differs is in
one block of `popup.css` under `[data-host="panel"]`. The panel keeps the popup's two tabs,
made fluid.

### What the panel changes

| | popup | side panel |
|---|---|---|
| width | fixed, 420px | the reader's, from 320px |
| scrolls | the document | the body of the open tab; header, tabs and footer stay |
| header | mark, name, site, panel button, settings | site, settings |
| request group row | one line | two lines below 400px, one line from there |
| record | read once, at open | follows the window's active tab, redrawn as it changes |

**Width.** Chrome sets the panel's width and the reader drags it. The content is never
narrower than 320px and opens at about 360px. Nothing in the panel may assume 420px.

**The site leads the header.** Chrome draws its own bar over every side panel with the
extension's icon and name, so the popup's header would say both again one row below. The
panel also follows the active tab, so which site this is changes under the reader. The mark
and the name go, and the site takes the row at full text strength, uncapped. On Settings and
on the report the header is the screen's title, and stays.

**Bars stay, one body scrolls.** The header, the tabs, the filter bar and the footer hold
their places. The document itself does not scroll, so there is still one scrollbar and one
gesture. The rule `popup.css` states at `.req-list`, no scrolling pane inside a scrolling
page, is kept and not broken.

**Two-line request groups, below 400px.** The domain is what a reader scans the list for,
so it is never the part that gives way. Below 400px it keeps the first line with the request
count and the caret, and the cookies and the vendor take the second. The rule is by width,
not by host, so a panel dragged to the popup's width shows the popup's row.

**A privacy string's label keeps two fifths of its row**, below 400px, so a long value wraps
beside it and the label is not pressed into four lines.

### Redrawing under the reader

The popup is read once. The panel is redrawn while it is being read, as a page loads and
every time the reader changes tab, and each of these is a way to lose the reader's place:

- **The same page keeps its state.** Open rows, the scroll position, the active filter and
  keyboard focus are put back after a redraw. Focus is found again by what the row is (a
  vendor, a domain), not by which node it was.
- **A different page starts closed, at the top.** What was open belonged to the page before.
- **A redraw that would change nothing draws nothing.** The panel hears about every write
  to the tab's record; most change no word on screen.
- **No more than two redraws a second** while a page loads. A tab switch or a navigation is
  drawn at once, since the reader caused it and is waiting.
- **A panel that cannot be seen draws nothing**, and catches up when it is shown.
- **No list is ordered by volume.** The lists are alphabetical within their groups (§6), so
  a page that keeps loading does not reorder them under the reader.

### Checking it

`npm run harness` draws the panel at 320, 360, 420 and 600px. Check a change to any row at
all four. A narrow browser window is not a substitute: a device emulation that makes the
window narrow also lays the page out as a phone would, at 980px, and shows nothing of the
panel's real layout. The frames on the contact sheet are the panel's real widths.
