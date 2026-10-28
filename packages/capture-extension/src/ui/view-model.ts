// SPDX-License-Identifier: GPL-3.0-only
/**
 * The popup's view model (PRD 5.1, 5.6).
 *
 * A pure function from ObservationSet + findings to a description of what the popup should
 * display. No DOM, no chrome.* — so every state, including the awkward ones, is testable
 * in Node. The renderer does nothing but write this into elements.
 *
 * The reason this is a separate module rather than inline in the renderer: the null and
 * edge states (5.6) are the part most likely to be wrong and least likely to be exercised
 * by hand. A site with no ad tech, a site whose signal is off, a page where read tracking
 * is unavailable — each needs a distinct, honest presentation, and "I clicked around and
 * it looked fine" is not evidence that they are all right.
 */

import { gppSectionName, gppSectionId, gppSectionKind, tcfPurposeName } from "./iab-registry.js";
import { checksByContainer, categoryRank, gppCheckTest, primaryGppSection, COUNTING_CATEGORIES, NO_OWNERS, withPersistedShape, type OwnerNames } from "@gpc-inspector/engine";
import { containerRows, type ContainerRow } from "./container-rows.js";
import { registrableDomain } from "@gpc-inspector/lists";
import { gotNoAnswer } from "../observe/well-known.js";
import { unlistedDomainHasRow, callCount, wireValuesOf, entityCategoryKey, isTallied, googleTagObserved, consentModeNeedsDataLayer, FIRST_PARTY_COOKIE_CAP, type LoaderIdentity, type ContainerIdentity, type CaptureMethod, type CookieDetail, type EntityCategoryTally, type IncompleteReason, type TagManagerKind, type UnlistedDomainTally } from "@gpc-inspector/schema";
import type {
  PropertyValue,
  ObservationSet,
  Finding,
  UsPrivacyObservation,
  TcfObservation,
  GppObservation,
  Tallies,
} from "@gpc-inspector/schema";

/** Which top-level presentation the popup is in. */
export type PopupState =
  | "pending" // observation still arriving; the signal status is already known
  | "no-data" // nothing captured for this tab yet
  | "ineligible" // a page the extension cannot inspect (PageKind): one notice and nothing else
  | "needs-reload" // this version did not observe the page load: open before it, or restored from the back/forward cache
  | "site-access-limited" // the browser does not let this extension access the page: nothing was sent or observed
  | "load-failed" // the page did not load; Chrome showed its own error page
  | "signal-off" // the user turned sending off; nothing to observe a response to
  | "no-ad-tech" // nothing observed at all: excluded from every total (5.6 row 1)
  | "observed"; // ad tech present, whether or not it set cookies (5.6 rows 2+)

/**
 * What a tab holds, for the question asked before any other: can the extension inspect it?
 *
 *   website          an http:// or https:// page
 *   new-tab          the browser's new tab page, or a blank tab: nothing is open in it yet
 *   not-inspectable  everything else: the browser's own pages, other extensions' pages, the
 *                    extension stores, local files
 *
 * Read from the tab's address, never from the record. The record of such a page still fills
 * with something: requests the new tab page makes, or the report of a frame inside a page
 * whose own document the browser keeps every extension out of (an extension store). Taken
 * as the page, those put a signal status, a reload prompt and a request count on a page
 * that reloading never makes inspectable.
 */
export type PageKind = "website" | "new-tab" | "not-inspectable";

/** The new tab pages, by scheme and host (about: by path): the browsers this runs in, and a blank tab. */
const NEW_TAB_PAGES: ReadonlySet<string> = new Set([
  "chrome://newtab",
  "chrome://new-tab-page",
  "chrome://new-tab-page-third-party",
  "edge://newtab",
  "about:blank",
]);

/**
 * The extension stores, by host and path: the browser runs no extension's content script in
 * their pages and shows no extension their requests.
 */
const STORE_PAGES: readonly (readonly [host: string, path: string])[] = [
  ["chromewebstore.google.com", "/"],
  ["chrome.google.com", "/webstore"],
  ["microsoftedge.microsoft.com", "/addons"],
];

/** What a tab's address holds (PageKind), or null when the address is not known. */
export function pageKindOf(address: string | undefined): PageKind | null {
  if (address === undefined || address === "") return null;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    const store = STORE_PAGES.some(([host, path]) => url.hostname === host && url.pathname.startsWith(path));
    return store ? "not-inspectable" : "website";
  }
  const page = url.protocol === "about:" ? `about:${url.pathname}` : `${url.protocol}//${url.hostname}`;
  return NEW_TAB_PAGES.has(page) ? "new-tab" : "not-inspectable";
}

/**
 * The toolbar icon's state for one tab: "on" when a GPC signal was set AS THE PAGE
 * LOADED, whoever set it — the property reads `true` (native, another extension, or
 * ours) or the request that fetched the top document carried `Sec-GPC`. Either channel
 * counts, because the two are set by different mechanisms and a page can have one without
 * the other: another extension may set the property and never touch the header, or the
 * reverse.
 *
 * Both inputs are fixed at load. The property is set at document_start and never changes
 * for the life of the page; the document request happens once. So a setting flipped
 * afterwards does not move the icon until a reload — deliberately. The header rule does
 * follow the setting at once, and later requests carry (or drop) the header, but the
 * page's scripts and cookies already ran under the earlier state; an icon that changed
 * color on a page that had not changed would claim a state the page never had. This is
 * the rule the status row already states as "reload the page to apply", applied to the
 * icon. A tab that has not reported keeps the default icon, which is the setting.
 *
 * This is deliberately NOT "is this extension sending". Chrome will send the signal
 * natively, and a gray icon beside a browser that is sending would tell the reader the
 * opposite of the truth. The icon answers the observation question, like everything
 * else here; the status row says who.
 *
 * Lives here, beside the status row it must agree with, so there is one derivation of
 * the fact: two would let the badge and the popup disagree.
 */
export type SignalIconState = "on" | "off";

export function iconStateFor(signal: {
  readonly propertyValue: PropertyValue;
  /** Sec-GPC on the request that loaded the top document; null until observed. */
  readonly documentSigned: boolean | null;
}): SignalIconState {
  return signal.propertyValue === true || signal.documentSigned === true ? "on" : "off";
}

/**
 * The toolbar icon's hover title. A blue icon that no page has reported on yet (the default,
 * and every chrome:// and new-tab page) shows only our own setting, so it says the signal is
 * on and names no page; "set on this page" is kept for a tab whose report says it was. Gray
 * reads the same either way: nothing asserted the signal.
 */
export function actionTitleKey(
  state: SignalIconState,
  reported: boolean,
): "actionTitleOn" | "actionTitleSending" | "actionTitleOff" {
  if (state === "off") return "actionTitleOff";
  return reported ? "actionTitleOn" : "actionTitleSending";
}

export interface StatusRow {
  readonly isSet: boolean;
  /** i18n key for the source tag. */
  readonly sourceKey:
    | "sourceThisExtension"
    | "sourceBrowser"
    | "sourceOtherExtension"
    | "sourceBrowserOff"
    | "sourceOtherExtensionOff"
    | "sourceBrowserOffHeaderSent"
    | "sourceOtherExtensionOffHeaderSent"
    | "sourceOffInSettings"
    | "sourceNeedsReload"
    | "sourceSiteAccessLimited"
    | "sourceUnknown";
  /** Accent the tag only when this extension is the source. */
  readonly accent: boolean;
}

export interface KvRow {
  readonly labelKey: string;
  /** Plain text value, or null when chips are used instead. */
  readonly value: string | null;
  /** i18n key for the value, when the value is a fixed phrase. */
  readonly valueKey?: string;
  /** Substitutions for `valueKey`, e.g. the read count in "$COUNT$ times". */
  readonly valueSubstitution?: readonly string[];
  /**
   * Secondary hint line, composed of one or more translated sentences joined with a space.
   *
   * A list rather than one key because the checked row's hint is assembled from
   * independent facts (who checked, whether a container tag did, whether some checks could
   * not be traced) and a key per combination would be eight keys saying the same things.
   */
  readonly hintParts?: readonly HintPart[];
  /** Render the hint in the monospace face: for a path, never for prose. */
  readonly hintMono?: boolean;
  /** Hover text on the hint: the full list where the hint shows a capped one. */
  readonly hintTitle?: string;
  /**
   * A list-shaped row (the GPC read rows): the label stands on its own line and these
   * render under it, left-aligned and indented, spanning the row. The first line is the
   * answer, the names alone ("Criteo, Permutive") since the row label says which list it
   * is; the rest carry the page's other facts in hint tone. A row with a value can carry
   * hint lines too, under the value.
   */
  readonly lines?: readonly KvLine[];
  /**
   * A group row (the GPC read rows): the label stands alone as the group's
   * heading and these rows render nested under it, indented behind a rule, so they read as
   * parts of one answer and not as findings of their own. A group row's own `lines` are
   * notes about the whole group, drawn at the bottom of it.
   */
  readonly rows?: readonly KvRow[];
}

/** One line of a list-shaped KvRow: pieces joined by their glue, in value or hint tone. */
export interface KvLine {
  readonly parts: readonly HintPart[];
  /** "hint" renders small and muted, like a hint; absent renders like a value. */
  readonly tone?: "hint";
  /**
   * A list the line names in full, drawn where the line's one part has LIST_MARK for a
   * substitution: "Yes: " and then every company with its category. Every item is listed,
   * never three names and "and N more" with the rest in a hover. An item never breaks
   * across two lines.
   */
  readonly list?: readonly KvListItem[];
}

/** Stands in a line's substitution for where its list is drawn. A private-use character. */
export const LIST_MARK = "\uE002";

/** One name on a line: a company with its category, or a domain. */
export interface KvListItem {
  readonly text: string;
  /** i18n key of the category shown after a company's name, in parentheses. */
  readonly categoryKey?: string;
  /** The text is a domain, and is drawn in the monospace face. */
  readonly domain?: true;
  /** The domain is the site's own. */
  readonly thisSite?: true;
}

/**
 * The message key for a category's label: `category_` and the category with its hyphens
 * dropped, since message names allow no hyphen. Every category the engine has needs one,
 * and the labels are Disconnect's own names for its categories, never a description in
 * this extension's words. Written out nowhere else, so the strings report lists the keys
 * as referenced dynamically. "unknown" is not Disconnect's category but the lack of one,
 * and has this extension's word for it.
 */
export function categoryLabelKey(category: string): string {
  return category === "unknown" ? "categoryUncategorized" : `category_${category.replace(/[^a-z]/g, "")}`;
}

/**
 * One piece of a KvRow hint: a translated key, or captured text shown as it is. `glue` is
 * what goes BEFORE the piece: a space by default, "" to run on, ", " inside a list, and
 * "\n" to start a new line. It exists so a list ("2 read GPC, 1 no read observed") can be
 * assembled from per-segment strings that each translate on their own.
 */
export type HintPart =
  | { readonly key: string; readonly substitution?: readonly string[]; readonly glue?: string }
  | { readonly text: string; readonly glue?: string };

/**
 * One line inside an expanded privacy-string row.
 *
 * Three columns, and the third is the point: a plain-language field name, the decoded
 * meaning, and the RAW encoded value beside it. IAB's opt-out encoding runs 0 = not
 * applicable, 1 = opted out, 2 = did NOT opt out, so the integer alone is not merely
 * opaque — it reverses the intuitive reading, where a larger number looks like more
 * opting-out. Showing both means a reader gets the meaning and a skeptic can check our
 * decode against the spec without leaving the popup.
 */
export interface DecodedField {
  /** i18n key for the field's plain-language name. */
  readonly labelKey?: string;
  /** Literal name, for registry data we do not translate (see iab-registry.ts). */
  readonly label?: string;
  /** i18n key for the decoded value. */
  readonly valueKey?: string;
  /** Substitutions for `valueKey`. */
  readonly valueSubstitution?: readonly string[];
  /** Literal decoded value, where the value is data rather than copy. */
  readonly value?: string;
  /** The label is an identifier (`ad_storage`), drawn in the monospace face. */
  readonly labelMono?: boolean;
  /** The value is an absence ("not set"), drawn as one. */
  readonly absence?: boolean;
  /** Raw encoded value, third column. */
  readonly raw?: string;
  /**
   * Carry weight. Marks the fields the collapsed summary was built from, so a reader who
   * expands can see WHICH lines produced it rather than re-deriving that themselves.
   */
  readonly emphasis?: boolean;
}

/** A labeled group of decoded fields, e.g. "GPC" and "Opt-out" inside the GPP row. */
export interface DecodedGroup {
  /** i18n key for the group heading. Omitted for a leading, unheaded group. */
  readonly labelKey?: string;
  /**
   * Summary shown beside the heading, e.g. "none recorded" on the Opt-out group.
   *
   * This is what answers "GPC went in, and then what?" — a question a row that reports a
   * detection and stops invites, and that the flat field list never addressed.
   */
  readonly summaryKey?: string;
  /** A sentence under the heading, before the fields. */
  readonly noteKey?: string;
  readonly fields: readonly DecodedField[];
}

/** One part of a collapsed row's value. Parts are joined with a separator by the renderer. */
export interface SummaryPart {
  readonly key: string;
  readonly substitution?: readonly string[];
}

/**
 * A privacy-string row: GPP, USP or TCF.
 *
 * Separate from KvRow because these rows do something the "what this site did" rows do
 * not — they expand. The split is deliberate and structural: section one reports plain
 * facts about the site's response to GPC, section two reports artifacts the site
 * broadcasts about the reader, and only the second kind has an encoded interior worth
 * opening. Making expandability mean something is cheaper than teaching a reader which
 * rows happen to be clickable.
 */
export interface StringRow {
  /** Stable identity, used to preserve open/closed state across live re-renders. */
  readonly id: "gpp" | "usp" | "tcf" | "gcm";
  readonly labelKey: string;
  /** Dimmed qualifier beside the label: "deprecated", "EU / GDPR". */
  readonly qualifierKey?: string;
  /**
   * Full name, shown at the head of the expansion with the API beside it. Never in the
   * collapsed row. Absent on Google Consent Mode, whose store no API reads (1.25.0): its
   * expansion opens on its first group.
   */
  readonly nameKey?: string;
  /** The API the value came from, shown beside the full name. */
  readonly api?: string;
  /** Collapsed value, in parts. */
  readonly summary: readonly SummaryPart[];
  /**
   * Give the collapsed value weight. Set for the gpp-conflict pair — a GPC field of 1
   * beside a did-not-opt-out of 2. Weight and full contrast, never color: the flagged
   * field is not a cookie, so it must not borrow the cookie accent.
   */
  readonly flagged: boolean;
  /** Expanded content. Absent when there is nothing behind the value to show. */
  readonly groups?: readonly DecodedGroup[];
  /** Raw string, shown at the foot of the expansion. */
  readonly raw?: string;
  /** Scope note at the head of the expansion (TCF's "separate from GPC" line). */
  readonly noteKey?: string;
  readonly linkUrl?: string;
  readonly linkTextKey?: string;
  /**
   * What outbound requests carried for this string, where that is not the page's own
   * reading: a value that is not a string at all (an unfilled `[GPP]`), or a valid one the
   * page never reported. Each line names the host that sent it and, where there is one,
   * shows the value as sent. Rendered in the expanded panel; a row with lines expands.
   */
  readonly wireLines?: readonly WireLine[];
}

export interface WireLine {
  readonly key: string;
  readonly substitution: readonly string[];
  /** The value as sent, shown monospaced after the sentence. Absent when the row shows it. */
  readonly value?: string;
  /** Every host that carried it, and the full value, for the tooltip. */
  readonly title?: string;
}

/** One cookie this entity set, with the attributes that change what it can do. */
export interface VendorCookie {
  readonly name: string;
  /** Domain the cookie was set for. */
  readonly domain: string;
  /**
   * How long it lasts, or "session". Absent, with `sameSite` and `viaKey`, for a cookie
   * kept by name alone: one past the cap on cookie details (1.22.0), whose attributes were
   * not kept and are not guessed at.
   */
  readonly expiry?: CookieExpiry;
  readonly sameSite?: string;
  /**
   * CHIPS. A partitioned cookie cannot be read across sites, so presenting it identically
   * to an unpartitioned identifier would overstate what it can do.
   */
  readonly partitioned: boolean;
  /** How it was set: a Set-Cookie response header, or a page script. */
  readonly viaKey?: CookieViaKey;
  /** True when this arrived on a redirect hop rather than a final response. */
  readonly onRedirect: boolean;
  /**
   * The cookie was removed again after it was set, and how long after. It is listed and
   * counted all the same: it was set. Absent for a cookie not seen removed.
   */
  readonly removed?: CookieRemoved;
  /**
   * Whether this cookie was observed going back to the vendor: its name in the Cookie
   * header of a later request to one of the vendor's hosts that its domain covers
   * (sentToAnyHost). The panel shows only the positive case: a cookie not seen going back
   * may have had no later request, or gone back from a context the capture does not see,
   * such as another tab.
   *
   * Binary on purpose. A count would measure how many requests the page happened to make,
   * not what the site did — and "sent back 47 times" reads as 47 tracking events when it is
   * one page's worth of ad slots.
   */
  readonly sentBack: boolean;
  /**
   * The name is on the list of functional cookie names, and the cookie is one the count
   * includes. See VendorRow.functionalCookies.
   */
  readonly functional: boolean;
  /**
   * Set on a request that did not carry the signal, while the signal was on (1.26.0). The
   * row above lists only the cookies set on requests that carried it; the panel lists both,
   * and says so on this one's line. Absent with sending off, where every cookie is unsigned.
   */
  readonly unsigned?: true;
  /**
   * Known only from a response whose request was lost to a worker reclaim or restart
   * (1.26.0): whether that request carried the signal was not observed, so the cookie is
   * listed and counted nowhere. Never on a cookie also set on an observed request.
   */
  readonly requestLost?: true;
}

/** Everything shown when a vendor row is expanded. */
export interface VendorDetail {
  /** Hostnames belonging to this entity that were seen on the page. */
  readonly domains: readonly string[];
  /** Requests to those hostnames. */
  readonly requestCount: number;
  /** How many of those carried Sec-GPC: 1. */
  readonly signedRequestCount: number;
  /**
   * Distinct resourceTypes Chrome reported for this entity's requests (e.g. "script",
   * "image", "xmlhttprequest"). Surfaced because vendor-signal-check's "Not applicable"
   * state is a direct claim about this list (no script/xhr observed) — a reader checking
   * that claim needs to see the same fact the engine saw, not just the request count.
   */
  readonly resourceTypes: readonly string[];
  readonly cookies: readonly VendorCookie[];
  /** Consent-API calls attributed to this entity, by API name. */
  readonly consentCalls: readonly { readonly api: string; readonly count: number }[];
  /**
   * Sampled reads of navigator.globalPrivacyControl attributed to this entity's scripts.
   *
   * NOT rendered (see popup.ts's vendor panel for why). Kept on the detail because it is
   * the evidence behind a "Read GPC property" tag and the harness and tests assert on it;
   * a LOWER BOUND, not a count, so any rendering must say "at least" and never "exactly N
   * times".
   */
  readonly signalReads: number;
  /**
   * Every loader the insertion records resolved for this vendor's scripts, one line each,
   * with a container's parent chain. The evidence behind the row's `loadedVia`, shown so a
   * reader can see all of it when the row collapsed several loaders into one line.
   */
  readonly loadedVia: readonly LoadedViaLine[];
  /**
   * Cookies this vendor set and removed within moments, and cookie writes the browser
   * refused (1.18.0). Neither is counted; shown so the reader can see what was left out and
   * why. Empty when there were none, or the capture predates the fields.
   */
  readonly probeCookies: readonly string[];
  readonly refusedWrites: readonly string[];
  /**
   * The row is a domain, not a company: Disconnect puts the domain that set these cookies
   * in a counted category but matches it to no entity, so it has no tally entry, no
   * hostnames and nothing to check. Its category comes from the cookies it set. Absent for
   * every listed vendor.
   */
  readonly unlistedDomain?: boolean;
  /**
   * A key was left out of `cookies` because the row's summary was full (1.26.0). The panel
   * says so at the end of the list.
   */
  readonly cookiesCapped?: boolean;
  // No list provenance here. Once per expanded vendor it would repeat what the credit at
  // the foot of the Overview states once for the list it describes, and on a page with
  // several vendors open it would be the most repeated string on screen. The heading's link
  // carries source, version and hash, which is what a dispute needs an address for.
}

/**
 * One row of the vendor list: a company in ONE category. Microsoft with advertising and
 * analytics domains on the page is two rows, each with the cookies, the Read GPC state and
 * the panel of that category's domains, and a company is listed under every category it
 * has third-party domains in, the ones that do not count included.
 */
export interface VendorRow {
  readonly name: string;
  /** Identifies the row: the company and its category. What an open panel is kept by. */
  readonly key: string;
  /**
   * The cookies this row's domains set, one per key: the name, or "name (domain)" where
   * one name was set on two domains. Signed requests, or unsigned with sending off.
   */
  readonly cookies: readonly string[];
  /**
   * Of `cookies`, the ones whose name is on the list of functional cookie names: the
   * cookies of load balancers and bot protection, which a vendor's host sets as any other
   * host behind them does. Labeled "listed as functional", and still counted: the
   * extension reads no values, so a name is all it has to go on, and a name is a string
   * any vendor can reuse. Counted cookies only. On a row the headline does not count the
   * label's own words, "still included in the count", would be false.
   */
  readonly functionalCookies: readonly string[];
  /**
   * The category Disconnect gives this row's domains, in the engine's names; "unknown" for
   * a company it names as an owner and gives no category. Absent only for a capture that
   * cannot say: one recorded before the categories were, with no classifier to ask.
   */
  readonly category?: string;
  /**
   * Whether the headline counts this row's cookies: advertising and analytics, and a row
   * with no category, which the list has always placed with advertising. The renderer
   * draws the cookie names of a row that is not counted in the secondary color.
   */
  readonly counted: boolean;
  /**
   * The row is a third-party domain the list names no company for (1.26.0), in the list's
   * last group, "No company found for this domain", after every category. `name` is the
   * registrable domain. It may be the site's own under another name, or a company the list
   * does not carry; the row says neither. Nothing on it is counted. Its Read GPC state is
   * the engine's for the domain (vendor-signal-check's domain unit), in the same states as
   * every row. Absent for every other row, the counted domain with no company included: that
   * one stays under its category, where the number above it counts its cookies.
   */
  readonly group?: "unlisted";
  /**
   * The line a row with no cookie names shows in their place (1.26.0): "cookies written and
   * removed" for a row of the last group whose only cookies were probes. Absent, the line is
   * "no cookies set", which is also what a row whose only record is a write the browser did
   * not store shows: it says what happened, and the panel carries the attempt. A row whose
   * only cookies came on a response whose request was lost reads "cookies set, request
   * lost", a vendor's row included (1.26.0). A row whose only cookies were set on requests
   * without the signal, while it was on, reads "cookies set, request without GPC", a
   * company's or a domain's, and so does one whose cookies are those and lost ones in any
   * mix.
   */
  readonly emptyKey?: "vendorCookiesSetAndRemoved" | "vendorCookiesRequestLost" | "vendorCookiesWithoutGpc";
  /** Expanded content. Present for every row; the UI decides when to show it. */
  readonly detail: VendorDetail;
  /**
   * Which of five states this vendor's own GPC check is in, from vendor-signal-check
   * (engine/rules/vendor-signal-check.ts) — see that file for the full decision order.
   *
   * No state says "via GTM" on the strength of a PAGE-level fact (whether any consent-API
   * call resolved into a tag-manager container): stamped onto every vendor row, it would
   * read as "this vendor was loaded through GTM". We do not know that. On retailer-m.example no
   * consent call resolved to a container, so no vendor would be tagged, even though the
   * site runs GTM; on news-f.example some did, so every vendor would be tagged regardless
   * of how it actually loaded.
   *
   * vendor-gpc-unread-via-container / vendorGpcCheckUnattributable use a page-wide
   * container fact for a DIFFERENT claim: they never assert how THIS vendor's own script
   * arrived (that still comes from `network` requests to its own domain, not from any
   * container attribution), only that (a) this vendor's own script ran and made no
   * attributable check, and (b) separately, this is what the page's container(s) show.
   *
   * vendor-gpc-unread-via-container shows as vendorGpcNotRead, the same state as
   * vendor-did-not-read-gpc: the reader cares whether a read was observed, and a label of
   * its own such as "No read observed on the page" would read as the same thing while
   * claiming more than the rule checks. Whether the tag was judged directly or through its
   * container is kept in the help text, which checkHelpFor chooses by the flag.
   *
   * vendorGpcCheckUnavailable is not one of vendor-signal-check's five states: it is this
   * view's own fallback for a vendor present via the (persistent) tallies but missing from
   * the (retained-sample) network data the engine runs on — an honest "we cannot check"
   * rather than guessing at one of the five.
   *
   * vendorGpcCheckUntraced is this view's too: a "no read observed" on a page where property
   * reads could not be observed at all (readTracking "unavailable"). GPP calls were still
   * recorded, so a vendor with none of them is not a read, but neither is it an observed
   * absence of one: "Cannot determine", as the container rows say on the same page.
   *
   * vendorGpcUnlistedDomain is likewise this view's own: the row is a counted domain the
   * list names no company for (detail.unlistedDomain, no `group`). The engine's finding for
   * the domain, when it has one, judges it like a company row; this is the state when it has
   * none, and saying "not captured" would claim a capture loss that did not happen.
   */
  /**
   * The hover and panel explanation for `checkKey`, chosen by the artifact: one string per
   * loader kind and route (the container that loaded this vendor read GPC; the container
   * above it did; the vendor that loaded it did; the site's script did; an unrelated
   * container did and set Consent Mode), plus an ordering sentence when the exact call
   * times say the read came before or after this vendor loaded. Falls back to the flag's
   * page-wide help when the artifact carries no loader.
   */
  readonly checkHelp: { readonly key: string; readonly substitution?: readonly string[]; readonly orderKey?: string };
  readonly checkKey:
    | "vendorGpcRead"
    | "vendorGpcReadProperty"
    | "vendorGpcAskedNoGpcField"
    | "vendorGpcAskedNoResponse"
    | "vendorGpcNotRead"
    | "vendorGpcCheckUnattributable"
    | "vendorGpcNotApplicable"
    | "vendorGpcCheckUnavailable"
    | "vendorGpcCheckUntraced"
    | "vendorGpcUnlistedDomain";
  /**
   * USP secondary line — present only when an attributable __uspapi call was observed for
   * this vendor and the page's API answered with a value. Omitted entirely otherwise, never
   * shown as "not checked" (PRD: secondary lines only appear if that specific API was called
   * and attributed to this vendor). A cookie or a request value is not what the call
   * returned, so it never stands in. Same decode as the page-level row (uspOptOutValueKey):
   * no separate vocabulary.
   */
  readonly usp?: {
    readonly valueKey: "valueUspOptedOutY" | "valueUspOptedOutN" | "valueUspNotApplicable";
  };
  /**
   * TCF secondary line — present only when this vendor attributably called __tcfapi with
   * getTCData or addEventListener, the commands whose answer carries the consent data. A
   * ping says only whether a consent tool exists and is not a read. Same purposes-count as
   * the page-level row, which also carries the decoder link: once for the page, not once per
   * vendor. With no purposes reported or none granted it says so in words, never "0/0".
   */
  readonly tcf?: {
    readonly key: "vendorTcfChecked" | "vendorTcfNoPurposes" | "vendorTcfNoneGranted";
    readonly substitution?: readonly string[];
  };
  /**
   * Who loaded this vendor's script, as one line under the row (provenance). Omitted
   * entirely when the insertion records could not tell: an absent line means "we could not
   * tell", never "not through a container". Leads with who, never a count; the one count
   * allowed is the reason for a different sentence (a site script that loads several
   * vendors). Several loaders collapse to the container, then "also by" the rest.
   */
  readonly loadedVia?: LoadedViaLine;
}

/** One translatable fragment; parts of a line are joined with ", " by the renderer. */
export interface LoadedViaLine {
  readonly parts: readonly { readonly key: string; readonly substitution?: readonly string[] }[];
}

export interface Notice {
  readonly kind: "incomplete" | "confirmed" | "finding" | "ownership";
  /**
   * Where the notice belongs relative to the count and the vendor list.
   *
   * "top" is for things the reader needs before the numbers mean anything — a truncated
   * capture, or the site's own confirmation. The tag-platform facts (how tags were loaded,
   * what a container declared) are the Tag containers rows and the Google Consent Mode row,
   * not notices.
   */
  readonly placement: "top";
  /**
   * How the notice is rendered. Each tone means exactly one thing (docs/DESIGN.md §2).
   *
   *   neutral      — ordinary context.
   *   unavailable  — WE COULD NOT LOOK. Amber, and only ever this. Not "bad".
   *   finding      — a contradiction the engine established. Structure, not color.
   *   accent       — reserved for a positive confirmation surfaced by the site itself.
   *
   * Findings never carry `amber`: that would make one color say "we could not
   * look" and "look at this" simultaneously — the two most nearly opposite things this
   * interface has to say. On an ad-dense page three amber finding banners would stack above
   * the fold and read as three warnings, reintroducing through color a verdict layer, which
   * D4 rules out.
   */
  readonly tone: "neutral" | "unavailable" | "finding" | "accent";
  readonly textKey: string;
  readonly substitution?: string | readonly string[];
  readonly subTextKey?: string;
  readonly subText?: string;
  /**
   * Label/value pairs rendered as a small two-column block under the text.
   *
   * For a notice whose whole point is that two values differ: asserting the mismatch in
   * prose and leaving the reader to go and find both is the same failure the USP and GPP
   * disagree findings avoid by substituting the values into their sentence. A pair
   * list rather than more substitutions because these are two NAMED quantities from
   * different places, and a sentence containing both is one a translator cannot reorder.
   *
   */
  readonly pairs?: readonly {
    readonly labelKey: string;
    readonly valueKey: string;
    readonly valueSubstitution?: readonly string[];
  }[];
}

export interface PopupView {
  readonly state: PopupState;
  readonly site: string;
  readonly status: StatusRow;
  readonly notices: readonly Notice[];
  readonly siteDid: readonly KvRow[];
  /** GPP / USP / TCF, each expandable. Empty only when there is no observation at all. */
  readonly privacyStrings: readonly StringRow[];
  /**
   * Which vendors read GPC from the page: one group row (checkedRow), drawn under the
   * privacy strings, since a GPP call is a read only by what the string above it records.
   * Empty only when there is no observation at all.
   */
  readonly gpcReads: readonly KvRow[];
  /**
   * Distinct advertising cookies (name and domain) set on signed requests. The headline.
   *
   * Distinct, not events: an ad slot refreshing re-sets the same identifier every thirty
   * seconds, so an event count measures dwell time and cannot be compared between visits.
   * The event total is not rendered; it stays in the feedback bundle, where a developer
   * reading a report wants to know how busy the page was.
   */
  readonly cookieCount: number;
  /**
   * The same count for requests that did not carry the signal. The headline with sending
   * off, and a supporting line with it on. Never added to the signed count.
   */
  readonly unsignedCookieCount: number;
  /** Third-party ad/analytics requests seen. Distinguishes a counted zero from absence. */
  readonly adTechRequests: number;
  /**
   * First-party cookies written by attributable ad/analytics scripts. Supporting detail.
   * 0 where the First-party cookies section lists them by name (1.26.0), so the line under
   * the headline is drawn only for a capture from before it.
   */
  readonly firstPartyVendorCookies: number;
  /**
   * The sentence under the number, which reads on from it. It says who set the cookies by
   * kind, "4 advertising and 2 analytics vendors", counting the companies that set a
   * counted cookie from each category's domains: one that set cookies from both is one of
   * each. Absent where the count is not shown.
   */
  readonly countCaption?: { readonly key: string; readonly substitution?: readonly string[] };
  readonly vendors: readonly VendorRow[];
  /**
   * The Tag containers section (1.25.0): one row per container, every Google tag id
   * sharing one row, in the order the section draws them. Empty when the page ran none,
   * and the section is left out.
   */
  readonly containers: readonly ContainerRow[];
  /** Container ids found on the page with nothing recorded under them, named on the section's closing line. */
  readonly containersQuiet: readonly string[];
  /**
   * The first-party cookies (1.26.0), the Overview's last section, closed until opened:
   * the names an advertising or analytics script the site serves wrote, and the names the
   * site set. One per key, "name (domain)" where one name was set on two domains, across
   * both lists. The signed and unsigned keys together, as every panel lists them. A key a
   * third party is counted for is listed under that third party, not here. Nothing in it
   * is counted. Absent when there are none, and for a capture from before the summary.
   */
  readonly firstParty?: {
    /** The site's registrable domain, the section's one row. */
    readonly domain: string;
    readonly vendorWritten: readonly string[];
    readonly site: readonly string[];
    /** Of both lists, the names set only on requests without the signal while it was on. */
    readonly unsigned: readonly string[];
    /**
     * Of the second list, the names known only from a response whose request was lost to a
     * worker reclaim or restart (1.26.0): whether it carried the signal was not observed.
     */
    readonly requestLost: readonly string[];
    /** False when script writes could not be observed: an empty first list is then not an observation. */
    readonly scriptWritesObserved: boolean;
    /** Cookies set and removed within moments, by name, as a vendor panel lists them. */
    readonly probeCookies: readonly string[];
    /** A name was left out of the first list, or the second, because it was full. */
    readonly vendorCapped: boolean;
    readonly siteCapped: boolean;
  };
  /**
   * The vendors named under the headline, with their cookies: the vendor list's counted
   * rows that set a cookie, in its order (advertising, then analytics), so the names and
   * the rows under them are one list at two sizes. Every counted cookie is in it once. A
   * company that set cookies from both categories is in it twice, once under each.
   */
  readonly countNames: readonly {
    readonly name: string;
    readonly category?: string;
    /**
     * The row is a domain the list names no company for (VendorDetail.unlistedDomain). Its
     * cookies are in the count; the caption's number of vendors leaves it out, since a
     * domain is not a vendor the list names.
     */
    readonly unlisted?: true;
    readonly cookies: readonly string[];
    /** Of those, the ones listed as functional. See VendorRow.functionalCookies. */
    readonly functionalCookies: readonly string[];
  }[];
}

/** Fields whose value 2 (did-not-opt-out) beside Gpc=1 is the IAB-described conflict. */
const OPT_OUT_FIELDS = ["SaleOptOut", "SharingOptOut", "TargetedAdvertisingOptOut"] as const;

/**
 * Decode character 3 of a US Privacy string (PRD FR-13): the opted-out state. IAB
 * encoding, position 3: 'Y' opted out, 'N' did not opt out, '-' not applicable. Any other
 * value (including a string too short to have a position 3) is treated as unparseable
 * the same as '-' — reporting an invented state from a malformed string would be a
 * decoding mistake presented as a fact.
 */
function uspOptOutChar3(raw: string): "Y" | "N" | null {
  const c = raw.length >= 3 ? raw[2] : undefined;
  return c === "Y" || c === "N" ? c : null;
}

function uspOptOutValueKey(raw: string): "valueUspOptedOutY" | "valueUspOptedOutN" | "valueUspNotApplicable" {
  const c = uspOptOutChar3(raw);
  return c === "Y" ? "valueUspOptedOutY" : c === "N" ? "valueUspOptedOutN" : "valueUspNotApplicable";
}

/**
 * The page-side US Privacy value: whichever of the two page-observable surfaces is
 * present, API preferred. Both are the CMP's own account of its state; the live
 * `__uspapi` call reflects the current moment, while the `usprivacy` cookie is a value
 * someone wrote earlier and may lag it. Used both for the primary display row (falling
 * back further to the wire only when NEITHER page-side surface exists) and for the
 * disagreement notice, where it is deliberately NOT allowed to fall back to the wire —
 * the wire is a THIRD PARTY's copy of the string, not what the page itself claims, and
 * conflating the two is exactly the mistake the three-surface model exists to prevent.
 *
 * This collapses "the page" to one value, and api and cookie can disagree with EACH OTHER
 * rather than with the wire. That case has its own notice (findingUspCookieDisagree) and
 * its own line under the row (lineUspCookieDiffers), so the value this returns is never set
 * against itself.
 */
function uspPageValue(usp: { fromApi: string | null; fromCookie: string | null }): string | null {
  return usp.fromApi ?? usp.fromCookie;
}

/**
 * The first string requests carried, where the page reported none. The first rather than
 * the most recent, so a row showing it does not change as requests arrive (1.29.0).
 */
function firstWire(usp: UsPrivacyObservation): { value: string; hosts: readonly string[] } | undefined {
  return wireValuesOf(usp)[0];
}

/**
 * IAB's public encoder/decoder, for GPP and TCF alike, pre-filled with the raw string.
 * Checked by loading it, not assumed.
 *
 * The string goes in the fragment, which is never sent in the HTTP request, so the link
 * transmits nothing until clicked. Whether the site reads the fragment has changed: on
 * 2026-09-02 the live site ignored it (`#<string>`, `#/decode?gpp=`, `#/decode/<string>`
 * and `#gpp=` all left the `#gpp-string` textarea empty). Verified 2026-09-22: `#<string>`
 * fills `#gpp-string` and decodes the sections.
 *
 * The same fragment serves TCF: verified 2026-09-22 that a bare TC string in `#<string>` is
 * recognized, fills the `#tcfeu-string` field and decodes the TCF EU section. The raw value
 * is shown beside both links for copying.
 *
 * One origin, because iabtcf.com now redirects here and this tool carries both fields. A
 * claim about a link is not a substitute for loading it.
 */
const IAB_DECODER_URL = "https://iabgpp.com/";

/**
 * The decoder opened on `raw`. Encoded defensively: valid GPP and TC strings are all
 * URL-safe characters, but an unparseable one is exactly the case where a reader wants a
 * second opinion. An empty string gets the bare page, not a dangling `#`.
 */
function decoderUrl(raw: string): string {
  return raw ? `${IAB_DECODER_URL}#${encodeURIComponent(raw)}` : IAB_DECODER_URL;
}

// --- privacy-string decoding -----------------------------------------------------
//
// Everything below turns an encoded artifact into a plain-language outcome plus the raw
// value it came from. The governing rule is that a value we could not read and a value
// that states "not applicable" are DIFFERENT CLAIMS and never share a phrase — the same
// observed-versus-unlookable distinction the rest of the popup keeps, applied one level
// down to the interior of a string.

/** IAB opt-out encoding: 0 = not applicable, 1 = opted out, 2 = did NOT opt out. */
function optOutValueKey(v: number): string {
  return v === 1 ? "valueOptedOut" : v === 2 ? "valueNotOptedOut" : "valueFieldNotApplicable";
}

/** IAB notice encoding: 0 = not applicable, 1 = provided, 2 = not provided. */
function noticeValueKey(v: number): string {
  return v === 1
    ? "valueNoticeProvided"
    : v === 2
      ? "valueNoticeNotProvided"
      : "valueFieldNotApplicable";
}

/** MSPA mode encoding: 0 = not applicable, 1 = yes, 2 = no. */
function mspaValueKey(v: number): string {
  return v === 1 ? "valueYes" : v === 2 ? "valueNo" : "valueFieldNotApplicable";
}

/** Fields shown in the GPP "Opt-out" group, in the order the spec lists them. */
const GPP_OPT_OUT_ROWS = [
  { field: "SaleOptOut", labelKey: "gppFieldSaleOptOut", decode: optOutValueKey },
  { field: "SharingOptOut", labelKey: "gppFieldSharingOptOut", decode: optOutValueKey },
  {
    field: "TargetedAdvertisingOptOut",
    labelKey: "gppFieldTargetedAdvertisingOptOut",
    decode: optOutValueKey,
  },
  { field: "SaleOptOutNotice", labelKey: "gppFieldSaleOptOutNotice", decode: noticeValueKey },
  {
    field: "SharingOptOutNotice",
    labelKey: "gppFieldSharingOptOutNotice",
    decode: noticeValueKey,
  },
  {
    field: "TargetedAdvertisingOptOutNotice",
    labelKey: "gppFieldTargetedAdvertisingOptOutNotice",
    decode: noticeValueKey,
  },
  {
    field: "MspaCoveredTransaction",
    labelKey: "gppFieldMspaCoveredTransaction",
    decode: mspaValueKey,
  },
  {
    field: "MspaServiceProviderMode",
    labelKey: "gppFieldMspaServiceProviderMode",
    decode: mspaValueKey,
  },
  {
    field: "MspaOptOutOptionMode",
    labelKey: "gppFieldMspaOptOutOptionMode",
    decode: mspaValueKey,
  },
] as const;

/** "EU TCF v2 (2)", or the bare prefix when the registry has no name for it. */
function sectionLabel(nameOrId: string | number): string {
  if (typeof nameOrId === "number") {
    const n = gppSectionName(nameOrId);
    return n !== null ? `${n} (${nameOrId})` : String(nameOrId);
  }
  const n = gppSectionName(nameOrId);
  const id = gppSectionId(nameOrId);
  return n !== null && id !== null ? `${n} (${id})` : nameOrId;
}

/**
 * The GPC half of the collapsed GPP value.
 *
 * Three readings, kept distinct so that none of them collapses into silence: a field set
 * to 1, a field set to 0, and no field at all. A wording such as "GPC detected" has no
 * natural negative that does not also read as the field being absent.
 *
 * Note what this is NOT: our observation of whether GPC was sent. It is a boolean the
 * site's CMP wrote into its own string — a claim, not a measurement, and one that can
 * disagree with what we actually sent.
 */
function gpcFieldKey(fields: Record<string, number | undefined>): string {
  const g = fields["Gpc"];
  return g === 1 ? "valueGpcFieldYes" : g === 0 ? "valueGpcFieldNo" : "valueGpcFieldAbsent";
}

/**
 * The opt-out half: whichever state the three opt-out fields collectively record. A field
 * at 1 beside another at 2 is its own reading, so "opted out" never stands for a choice
 * the string records only in part.
 */
function gppOptOutKey(fields: Record<string, number | undefined>): string {
  const optedOut = OPT_OUT_FIELDS.some((k) => fields[k] === 1);
  if (optedOut && OPT_OUT_FIELDS.some((k) => fields[k] === 2)) return "valueGppOptedOutSome";
  if (optedOut) return "valueGppOptedOut";
  if (OPT_OUT_FIELDS.some((k) => fields[k] === 2)) return "valueGppNotOptedOut";
  return "valueGppNoOptOut";
}

/** Shared shape for a row that has a value but nothing behind it to open. */
function bareStringRow(
  id: StringRow["id"],
  labelKey: string,
  nameKey: string,
  api: string,
  valueKey: string,
  qualifierKey?: string,
  raw?: string,
): StringRow {
  return {
    id,
    labelKey,
    nameKey,
    api,
    ...(qualifierKey ? { qualifierKey } : {}),
    summary: [{ key: valueKey }],
    flagged: false,
    ...(raw !== undefined ? { raw } : {}),
  };
}

/**
 * Decoder link for a GPP row, attached only where there is a string to decode, and carrying
 * that string in the fragment so the decoder opens on it.
 *
 * With no string there is nothing to decode, so the link would be an invitation to a blank
 * form.
 */
function gppDecoderLink(rawString: string): Pick<StringRow, "linkUrl" | "linkTextKey"> | Record<string, never> {
  return rawString
    ? { linkUrl: decoderUrl(rawString), linkTextKey: "linkGppDecoder" }
    : {};
}

/** Characters of an invalid value shown in the panel; the tooltip carries the rest. */
const WIRE_VALUE_SHOWN = 120;

/**
 * One line per value outbound requests carried that is not a string (see InvalidWireValue):
 * which host sent it and exactly what it was, so "the tag never filled in its macro" and
 * "the string arrived mangled" read as the different facts they are.
 */
function invalidWireLines(
  list: readonly { value: string; hosts: readonly string[]; placeholder: boolean }[] | undefined,
  keys: { placeholder: string; invalid: string },
): WireLine[] {
  return (list ?? []).map((w) => ({
    key: w.placeholder ? keys.placeholder : keys.invalid,
    substitution: [w.hosts[0] ?? ""],
    value: w.value.slice(0, WIRE_VALUE_SHOWN),
    title: [w.value, ...w.hosts].join("\n"),
  }));
}

/**
 * One line per string requests carried that differs from the page's own: the notice above
 * the rows names one, and a page whose partners sent several different ones shows each here.
 * Compared with the string the row decodes; nothing when it decodes none.
 */
function differingWireLines(
  wire: readonly { value: string; hosts: readonly string[] }[],
  page: string | null,
  key: string,
): WireLine[] {
  if (page === null) return [];
  return wire
    .filter((w) => w.value !== page)
    .map((w) => ({
      key,
      substitution: [w.hosts[0] ?? ""],
      value: w.value.slice(0, WIRE_VALUE_SHOWN),
      title: [w.value, ...w.hosts].join("\n"),
    }));
}

/** A row with the wire lines added, and made expandable if it was not. */
function withWireLines(row: StringRow, lines: readonly WireLine[]): StringRow {
  return lines.length === 0 ? row : { ...row, wireLines: lines };
}

function gppRow(obs: ObservationSet): StringRow {
  const gpp = obs.gpp;
  const lines = [
    ...(gpp === null ? [] : differingWireLines(wireValuesOf(gpp), gpp.rawString || null, "lineGppWireDiffers")),
    // The page reported none: each string requests carried, which is what a
    // gpp-requests-disagree notice names. The row itself reads "only seen on a request".
    ...(gpp === null || gpp.rawString !== "" ? [] : differingWireLines(wireValuesOf(gpp), "", "lineGppWireCarried")),
    ...invalidWireLines(gpp?.invalidWire, { placeholder: "lineGppWirePlaceholder", invalid: "lineGppWireInvalid" }),
  ];
  // Only invalid values were seen: the page reported no string and no request carried one.
  // That is "not present", with the lines saying what was sent instead.
  if (
    gpp !== null &&
    gpp.rawString === "" &&
    gpp.fromWire === null &&
    gpp.applicableSections.length === 0 &&
    Object.keys(gpp.sections).length === 0
  ) {
    return withWireLines(
      bareStringRow("gpp", "labelPrivacyString", "nameGpp", "__gpp", obs.capabilities.gpp ? "valueNotPresent" : "valueNotObservable"),
      lines,
    );
  }
  return withWireLines(gppRowFromString(obs), lines);
}

function gppRowFromString(obs: ObservationSet): StringRow {
  const gpp = obs.gpp;
  const base = { id: "gpp" as const, labelKey: "labelPrivacyString", nameKey: "nameGpp", api: "__gpp" };

  // Absent, and the reason matters: an interceptor that never installed observed nothing,
  // and reporting that silence as "not present" would state a fact about the site we never
  // established.
  if (gpp === null) {
    return bareStringRow(
      "gpp",
      base.labelKey,
      base.nameKey,
      base.api,
      obs.capabilities.gpp ? "valueNotPresent" : "valueNotObservable",
    );
  }

  // A string arrived that we could not decode. Deliberately NOT "malformed": whether the
  // fault is the site's string or our decoder is exactly what the "Looks wrong" flow
  // exists to find out, and asserting the former would be a verdict on the site's
  // engineering rather than a report of what we could do.
  if (gpp.unparseable) {
    return {
      ...base,
      summary: [{ key: "valueStringNotReadable" }],
      flagged: false,
      // The decoder matters MOST here: if we could not read it, the reader's next move is
      // a second opinion from the IAB's own implementation.
      ...(gpp.rawString ? { raw: gpp.rawString, ...gppDecoderLink(gpp.rawString) } : {}),
    };
  }

  const primary = primaryGppSection(gpp.sections);

  // The page named which section applies but reported no fields with it. Never a raw chip
  // such as "sections: 8": a registry integer shown to a consumer reads as an outcome
  // rather than as the absence of one.
  if (primary === null) {
    // Everything the string carries, whichever surface named it. applicableSections is the
    // CMP's own list of ids; parsedSections is what it actually handed us. Either can be
    // the fuller one, so both feed the list rather than picking a favorite.
    //
    // Deduped by id, and ordered by it: ids are the string's own order, whereas sorting the
    // display labels would order US Privacy before EU TCF purely because "U" follows "E".
    //
    // -1 and 0 are not sections: -1 is the API's "no section applies", and 0 names none in
    // the registry. They are kept out of the list, so a raw "-1" never reads as a section.
    const ids = new Set<number>();
    const unknown = new Set<string>();
    let namedNone = false;
    for (const id of gpp.applicableSections) {
      if (id > 0) ids.add(id);
      else namedNone = true;
    }
    for (const key of Object.keys(gpp.sections)) {
      const id = gppSectionId(key);
      if (id !== null) ids.add(id);
      else unknown.add(key);
    }
    const present = [
      ...[...ids].sort((a, b) => a - b).map((id) => sectionLabel(id)),
      ...[...unknown].sort(),
    ];

    if (present.length === 0 && !namedNone) {
      // No string and no sections. Chosen by the capability like the other rows; and when the
      // page reported none but a request carried a valid one, the row says that rather than
      // "not present" (the lines under it show each string).
      const valueKey = !obs.capabilities.gpp
        ? "valueNotObservable"
        : gpp.rawString === "" && wireValuesOf(gpp).length > 0
          ? "valueGppWireOnly"
          : "valueNotPresent";
      return bareStringRow("gpp", base.labelKey, base.nameKey, base.api, valueKey, undefined, gpp.rawString || undefined);
    }

    const kinds = [...ids].map((id) => gppSectionKind(id));
    // applicableSections names a us-state section the page reported no fields for (a parsed
    // one would have been primary). The string says which law applies and nothing under it.
    const usNamed = kinds.includes("us-state");
    // Sections are present, but none of them is a us-state section — so this string cannot
    // express an opt-out or a GPC field at all. Saying "no opt-out recorded" here would
    // report an absence that was never expressible, and on a string whose uspv1 section may
    // well record an opt-out that the USP row goes on to show. Name what IS carried and
    // point at where the answer lives. The no-US note needs a consent section to stand on:
    // a string naming only -1 or an unknown section gets no note.
    const noteKey = usNamed
      ? undefined
      : kinds.includes("us-legacy")
        ? "gppOnlyLegacyUsNote"
        : kinds.includes("consent")
          ? "gppNoUsSectionNote"
          : undefined;

    return {
      ...base,
      summary: [{ key: usNamed ? "valueGppUsSectionNoFields" : "valueGppNoUsSection" }],
      flagged: false,
      ...(noteKey ? { noteKey } : {}),
      groups:
        present.length === 0
          ? []
          : [
              {
                // ONE row, not one per section. A field each would repeat the "Section"
                // label down the panel, which reads as duplicated rows rather than as a
                // list of what the string contains.
                fields: [
                  {
                    labelKey: present.length === 1 ? "gppLabelSection" : "gppLabelSections",
                    value: present.join(", "),
                  },
                ],
              },
            ],
      ...(gpp.rawString ? { raw: gpp.rawString, ...gppDecoderLink(gpp.rawString) } : {}),
    };
  }

  const [sectionKey, fields] = primary;
  const sectionName = gppSectionName(sectionKey);
  const sectionId = gppSectionId(sectionKey);

  const gpcKey = gpcFieldKey(fields);
  const optOutKey = gppOptOutKey(fields);

  // The IAB-described conflict, given weight in the collapsed row so it is legible without
  // expanding. Matches gppConflict's condition exactly (engine/rules/gpp-conflict.ts) —
  // Gpc === 1 alongside any opt-out field of 2, within the same section — rather than
  // approximating it, so the row and the finding notice above it can never disagree.
  const flagged = fields["Gpc"] === 1 && OPT_OUT_FIELDS.some((k) => fields[k] === 2);

  const optOutFields: DecodedField[] = [];
  for (const row of GPP_OPT_OUT_ROWS) {
    const v = fields[row.field];
    if (v === undefined) continue;
    optOutFields.push({
      labelKey: row.labelKey,
      valueKey: row.decode(v),
      raw: String(v),
      emphasis: (OPT_OUT_FIELDS as readonly string[]).includes(row.field) && v !== 0,
    });
  }

  /*
   * The string's own fields, and only those.
   *
   * Not what THIS BROWSER sent. That is a fact about the page, not a field of the GPP
   * string, so filing it inside the string's decode would miscategorize it; and beside the
   * string's own Gpc field it would be redundant: the first line of the popup already says
   * the GPC signal is set, on the same screen, above this row.
   *
   * The comparison still holds. A string recording `Gpc: 0` while we were sending shows
   * "GPC field" with "no" here and "Global Privacy Control (GPC) signal is set" at the top
   * of the same popup; the two facts are not adjacent, which is a cost worth paying to
   * avoid restating the page's premise inside every string's decode.
   *
   * The row is named like its neighbors, "GPC field", matching the collapsed summary's own
   * vocabulary and the opt-out field rows below it, because that is what it is.
   */
  const groups: DecodedGroup[] = [
    {
      fields: [
        {
          labelKey: "gppLabelSection",
          value:
            sectionName !== null && sectionId !== null
              ? `${sectionName} (${sectionId})`
              : sectionKey,
          // The API prefix alongside the friendly name, so a reader checking against the
          // spec has the identifier the spec actually uses. Omitted when the name IS the
          // prefix, which would print it twice.
          ...(sectionName !== null ? { raw: sectionKey } : {}),
        },
        {
          labelKey: "gppFieldGpc",
          valueKey:
            fields["Gpc"] === 1 ? "valueYes" : fields["Gpc"] === 0 ? "valueNo" : "valueGpcFieldAbsent",
          ...(fields["Gpc"] !== undefined ? { raw: String(fields["Gpc"]) } : {}),
          emphasis: fields["Gpc"] === 1,
        },
      ],
    },
  ];

  if (optOutFields.length > 0) {
    groups.push({
      labelKey: "gppGroupOptOut",
      ...(optOutKey === "valueGppNoOptOut" ? { summaryKey: "valueOptOutNoneRecorded" } : {}),
      fields: optOutFields,
    });
  }

  // The mismatch, stated where the field itself is on screen. Same slot as TCF's scope
  // line. Derived from the SAME comparison the engine's rule makes, so the row and the
  // notice above it cannot disagree — the pattern `flagged` already follows for
  // gpp-conflict.
  const mismatch = gpcVsGppState(obs);

  return {
    ...base,
    summary: [{ key: gpcKey }, { key: optOutKey }],
    flagged,
    ...(mismatch === "sent-field-no"
      ? { noteKey: "gppNoteMismatchSignalSet" }
      : mismatch === "not-sent-field-yes"
        ? { noteKey: "gppNoteMismatchSignalNotSet" }
        : {}),
    groups,
    // We decode the fields this row shows; the decoder shows the ones it does not — MSPA
    // detail, the TCF sections traveling in the same string, and its own reading of the
    // same bits for anyone checking ours.
    ...(gpp.rawString ? { raw: gpp.rawString, ...gppDecoderLink(gpp.rawString) } : {}),
  };
}

/**
 * USP: four characters, decoded position by position.
 *
 * Every position is shown, not only character 3: without WHICH character, or that three
 * others exist, "Opted out of sale: N" reads as an assertion of ours rather than as a read
 * of a four-character string the site published.
 */
function uspRow(obs: ObservationSet): StringRow {
  const usp = obs.usPrivacy;
  const lines: WireLine[] = [
    // The page's two surfaces disagreeing with each other: the row decodes the API's.
    ...(usp !== null && usp.fromApi !== null && usp.fromCookie !== null && usp.fromCookie !== usp.fromApi
      ? [{ key: "lineUspCookieDiffers", substitution: [], value: usp.fromCookie.slice(0, WIRE_VALUE_SHOWN), title: usp.fromCookie }]
      : []),
    // Against the string the row decodes: the page's, else the first a request carried.
    ...(usp === null ? [] : differingWireLines(wireValuesOf(usp), uspPageValue(usp) ?? firstWire(usp)?.value ?? null, "lineUspWireDiffers")),
    ...invalidWireLines(usp?.invalidWire, { placeholder: "lineUspWirePlaceholder", invalid: "lineUspWireInvalid" }),
  ];
  const row = uspRowFromString(obs);
  // A valid string only a request carried, never the page: shown decoded, but said to be
  // what a vendor request carried rather than what the site reports (news-b.example: a
  // `us_privacy=1NNN` hardcoded in a sync redirect, on a page with no __uspapi at all).
  const first = usp === null ? undefined : firstWire(usp);
  if (usp !== null && uspPageValue(usp) === null && first !== undefined && row.groups !== undefined) {
    const host = first.hosts[0];
    return withWireLines(
      { ...row, summary: [{ key: "valueUspWireOnly" }] },
      // Whether __uspapi was watched decides what "the page reported none" rests on.
      [
        ...(host ? [{ key: obs.capabilities.uspapi ? "lineUspWireOnly" : "lineUspWireOnlyUnwatched", substitution: [host] }] : []),
        ...lines,
      ],
    );
  }
  return withWireLines(row, lines);
}

function uspRowFromString(obs: ObservationSet): StringRow {
  const usp = obs.usPrivacy;
  const base = {
    id: "usp" as const,
    labelKey: "labelUsPrivacy",
    nameKey: "nameUsp",
    api: "__uspapi",
    qualifierKey: "labelDeprecated",
  };

  const raw = usp === null ? null : (uspPageValue(usp) ?? firstWire(usp)?.value ?? null);
  if (raw === null) {
    return bareStringRow(
      "usp",
      base.labelKey,
      base.nameKey,
      base.api,
      obs.capabilities.uspapi ? "valueNotPresent" : "valueNotObservable",
      base.qualifierKey,
    );
  }

  // A string too short to have a character 3, or carrying something other than Y/N/-, is
  // not the same fact as one that says "-". The engine may treat both as not-applicable;
  // the UI must not, because "this site says the rule does not apply to you" and "we could
  // not read this" are different claims.
  const c3 = raw.length >= 3 ? raw[2] : undefined;
  if (c3 !== "Y" && c3 !== "N" && c3 !== "-") {
    return bareStringRow(
      "usp",
      base.labelKey,
      base.nameKey,
      base.api,
      "valueStringNotReadable",
      base.qualifierKey,
      raw,
    );
  }

  const yn = (c: string | undefined): { valueKey: string } =>
    c === "Y"
      ? { valueKey: "valueYes" }
      : c === "N"
        ? { valueKey: "valueNo" }
        : { valueKey: "valueFieldNotApplicable" };

  /** A character position, omitted entirely when the string is shorter than it. */
  const at = (i: number): { raw: string } | Record<string, never> => {
    const c = raw[i];
    return c === undefined ? {} : { raw: c };
  };

  return {
    ...base,
    summary: [{ key: uspOptOutValueKey(raw) }],
    flagged: false,
    // The label carries a dimmed "deprecated"; this says by whom, when, and what replaced
    // it — the detail a reader wants once, on opening, not on every glance at the row.
    noteKey: "hintUspDeprecated",
    groups: [
      {
        fields: [
          { labelKey: "uspLabelVersion", ...(raw[0] !== undefined ? { value: raw[0] } : {}), ...at(0) },
          { labelKey: "uspLabelNotice", ...yn(raw[1]), ...at(1) },
          { labelKey: "uspLabelOptOut", ...yn(raw[2]), ...at(2), emphasis: true },
          { labelKey: "uspLabelLspa", ...yn(raw[3]), ...at(3) },
        ],
      },
    ],
    raw,
  };
}

/** TCF: purposes by name, plus the scope note that keeps it out of the GPC conversation. */
function tcfRow(obs: ObservationSet): StringRow {
  const tcf = obs.tcf;
  const base = {
    id: "tcf" as const,
    labelKey: "labelTcf",
    nameKey: "nameTcf",
    api: "__tcfapi",
    qualifierKey: "labelTcfScope",
  };

  // The consent tool answered that GDPR does not apply and issued no string. Expandable
  // (empty groups) so the sentence has a place.
  if (tcf !== null && tcf.tcString === "" && tcf.gdprApplies === false) {
    return { ...base, summary: [{ key: "valueTcfGdprNotApplies" }], flagged: false, noteKey: "tcfGdprNotAppliesNote", groups: [] };
  }

  if (tcf === null) {
    return bareStringRow(
      "tcf",
      base.labelKey,
      base.nameKey,
      base.api,
      obs.capabilities.tcfapi ? "valueNotPresent" : "valueNotObservable",
      base.qualifierKey,
    );
  }

  const entries = Object.entries(tcf.purposeConsents);

  // A string arrived but the CMP's purpose map was empty. "Reported", not "decoded": we
  // decoded nothing because there was nothing in it, and "decoded" confesses to a failure
  // that is not ours.
  if (entries.length === 0) {
    return {
      ...base,
      summary: [{ key: "valueTcfNoPurposes" }],
      flagged: false,
      noteKey: "tcfScopeNote",
      raw: tcf.tcString,
      linkUrl: decoderUrl(tcf.tcString),
      linkTextKey: "linkTcfDecoder",
    };
  }

  const granted = entries.filter(([, g]) => g).length;
  entries.sort(([a], [b]) => Number(a) - Number(b));

  const fields: DecodedField[] = entries.map(([id, isGranted]) => ({
    label: tcfPurposeName(id) ?? `Purpose ${id}`,
    valueKey: isGranted ? "valueGranted" : "valueDenied",
    raw: id,
  }));

  if (tcf.gdprApplies !== null) {
    fields.push({
      labelKey: "tcfLabelGdprApplies",
      valueKey: tcf.gdprApplies ? "valueYes" : "valueNo",
    });
  }

  return {
    ...base,
    // A count of granted purposes only: "3 of 11" reads as a score, and the panel lists each.
    summary: [
      granted === 0
        ? { key: "valueTcfNoneGranted" }
        : granted === 1
          ? { key: "valueTcfGrantedOne" }
          : { key: "valueTcfGranted", substitution: [String(granted)] },
    ],
    flagged: false,
    noteKey: "tcfScopeNote",
    groups: [{ fields }],
    raw: tcf.tcString,
    linkUrl: decoderUrl(tcf.tcString),
    linkTextKey: "linkTcfDecoder",
  };
}

/**
 * The privacy-string rows: what the site reports about the reader to its ad vendors.
 *
 * A section apart from "what this site did", so one flat list does not answer two
 * unrelated questions: how the site responded to GPC, and what it broadcasts about the
 * reader. This section's heading is the only place that says what these strings ARE; a
 * reader seeing "GPP" has no other route to that.
 */
function privacyStringRows(obs: ObservationSet): StringRow[] {
  return [gppRow(obs), uspRow(obs), tcfRow(obs), consentModeRow(obs)];
}

/** Google's four consent types and three storage types, in the order its documentation lists them. */
const CONSENT_TYPES = ["ad_storage", "ad_user_data", "ad_personalization", "analytics_storage"] as const;
const STORAGE_TYPES = ["functionality_storage", "personalization_storage", "security_storage"] as const;

/**
 * Google Consent Mode, the fourth row of Privacy strings (1.25.0). One page-wide store holds
 * the consent state for every Google tag on the page (verified live 2026-09-12), so it is a
 * fact about the page and sits with GPP, USP and TCF.
 *
 * The values are Google's consent store, `gtm.effectiveConsent`, which holds the state by
 * every route, a tag template's included: on 9 of 35 corpus pages with a Google tag and no
 * consent command on the dataLayer, the store held values the commands never showed
 * (2026-09-28). The dataLayer's commands are the fallback when the store could not be read.
 *
 * What it does not say, on purpose: who set a type (a sender is known only for a command
 * seen on the dataLayer with a stack, most often not for the default, and a Source line
 * would read as the sender of everything), and whether a value came from the default or an
 * update. "no Google tags" and "not set" are different pages and never share a reading,
 * and neither "no Google tags" nor "could not be read" opens. Values are never colored.
 */
function consentModeRow(obs: ObservationSet): StringRow {
  const base = { id: "gcm" as const, labelKey: "rowConsentMode", flagged: false };
  if (!googleTagLoaded(obs)) return { ...base, summary: [{ key: "valueConsentNoGoogleTags" }] };

  const store = obs.gtm.effectiveConsent;
  const commands = obs.gtm.consentMode;
  type Value = "granted" | "denied" | null;
  let valueOf: (type: string) => Value;
  if (store !== undefined && store !== null) {
    // An update overrides the default, whatever the order. `implicit` is not read: it sits
    // beside declared values on corpus pages, and a type with only it was never set.
    valueOf = (type) => {
      const entry = store[type];
      const v = entry?.update ?? entry?.default;
      return v === undefined ? null : v ? "granted" : "denied";
    };
  } else if (commands !== null) {
    valueOf = (type) => {
      const v = commands[type as keyof typeof commands];
      return v === "granted" || v === "denied" ? v : null;
    };
  } else if (obs.capabilities.dataLayer) {
    // The store was not read, but a dataLayer was watched and carried no consent command:
    // looked at, and nothing set.
    valueOf = () => null;
  } else {
    // Neither the store nor a dataLayer could be inspected.
    return { ...base, summary: [{ key: "valueConsentUnread" }] };
  }

  const field = (type: string): DecodedField => {
    const v = valueOf(type);
    return v === null
      ? { label: type, labelMono: true, valueKey: "valueConsentTypeNotSet", absence: true }
      : { label: type, labelMono: true, valueKey: v === "granted" ? "valueGranted" : "valueDenied" };
  };
  const set = CONSENT_TYPES.filter((type) => valueOf(type) !== null);
  const storageSet = STORAGE_TYPES.some((type) => valueOf(type) !== null);
  if (set.length === 0) {
    // Google's tags ran and set no consent type: the row opens to say so, and to show each
    // as not set. The storage types follow only when one of them was set.
    return {
      ...base,
      summary: [{ key: "valueConsentNotSet" }],
      groups: [
        { labelKey: "consentGroupTypes", noteKey: "consentNoneSetNote", fields: CONSENT_TYPES.map(field) },
        ...(storageSet ? [{ labelKey: "consentGroupStorage", fields: STORAGE_TYPES.map(field) }] : []),
      ],
    };
  }
  const granted = CONSENT_TYPES.filter((type) => valueOf(type) === "granted").length;
  return {
    ...base,
    summary: [{ key: "valueConsentGranted", substitution: [String(granted)] }],
    groups: [
      { labelKey: "consentGroupTypes", fields: CONSENT_TYPES.map(field) },
      { labelKey: "consentGroupStorage", fields: STORAGE_TYPES.map(field) },
    ],
  };
}

/**
 * The description under the "Send the signal" toggle when the browser implements GPC, or
 * null to keep the default. With the browser's signal on, the toggle goes inert: turning
 * ours off would not stop the browser's. With it off the toggle stays usable, because our
 * header rule still runs and the toggle is the only control over it.
 */
export function nativeSendSetting(
  signal: Pick<ObservationSet["signal"], "source" | "propertyValue"> | undefined,
): { readonly descKey: "settingSendSignalNative" | "settingSendSignalNativeOff"; readonly inert: boolean } | null {
  if (signal?.source !== "native") return null;
  return signal.propertyValue === true
    ? { descKey: "settingSendSignalNative", inert: true }
    : { descKey: "settingSendSignalNativeOff", inert: false };
}

/** The first-run line when the browser implements GPC, by what its property reads. */
export function nativeFirstRunKey(
  signal: Pick<ObservationSet["signal"], "source" | "propertyValue"> | undefined,
): "firstRunSignalNative" | "firstRunSignalNativeOff" | null {
  if (signal?.source !== "native") return null;
  return signal.propertyValue === true ? "firstRunSignalNative" : "firstRunSignalNativeOff";
}

/** The status row from this extension's own state alone, for a page that reported nothing. */
function settingStatus(sendingSignal: boolean | undefined, signalKnown: boolean | undefined): StatusRow {
  if (signalKnown === false) return { isSet: false, sourceKey: "sourceUnknown", accent: false };
  return sendingSignal === true
    ? { isSet: true, sourceKey: "sourceThisExtension", accent: true }
    : { isSet: false, sourceKey: "sourceOffInSettings", accent: false };
}

function statusFor(
  obs: ObservationSet,
  sendingSignal: boolean | undefined,
  signalKnown: boolean | undefined,
  pageAccess: boolean | undefined,
): StatusRow {
  // Not knowing is not a setting.
  //
  // Handled here and not only on the no-observations path: otherwise, once a page has been
  // observed, an unanswered status query would fall through to "sending off in settings",
  // naming a user choice on the strength of a message that never arrived. That is the same
  // error as reporting an absence we could not look for, one layer up.
  if (signalKnown === false && obs.signal.source === "none") {
    return { isSet: false, sourceKey: "sourceUnknown", accent: false };
  }

  // The page did not load, and Chrome's error page reports nothing, so the page's own
  // reading of the signal is unknown; the "none" in the observations is an empty default,
  // not a report. What can be said is what this extension was sending, as for a tab with no
  // observations at all. Rendering the default gives "signal is not set, reload the page to
  // apply" beside a request that had carried Sec-GPC (ticketing-b.example, 2026-09-25).
  if (obs.context.loadError) return settingStatus(sendingSignal, signalKnown);

  // The browser does not let this extension access the page ("On click" or "On specific
  // sites" in its site access setting, or a host blocked by policy): it applies no header
  // rule and runs no script there, so nothing reported, and a reload alone changes nothing.
  // Only for a page that reported nothing: one that loaded while access was granted keeps
  // its report.
  if (pageAccess === false && sendingSignal === true && obs.signal.source === "none") {
    return { isSet: false, sourceKey: "sourceSiteAccessLimited", accent: false };
  }

  // The load was not observed, so the page's own document never got the property. Frames
  // the page adds AFTERWARDS do get the content scripts and do report "this-extension",
  // which put "signal is set, by this extension" above a notice saying the page was not
  // observed, on a document where navigator.globalPrivacyControl was undefined (seen on a
  // live page, 2026-09-21). A late frame's report is about that frame. Only our own
  // assertion is set aside: a browser or another extension sets the signal for the whole
  // profile, open tabs included, so that report still stands. So does the report of a page
  // restored from the back/forward cache: it is its own top document's, from its load.
  if (
    obs.context.loadObserved === false &&
    obs.context.restoredFromCache !== true &&
    sendingSignal === true &&
    obs.signal.source === "this-extension"
  ) {
    return { isSet: false, sourceKey: "sourceNeedsReload", accent: false };
  }

  // Sending is on but this page was loaded before it was turned on, so its property was
  // never set. Reporting that as "sending off in settings" states a setting value that is
  // the opposite of the truth — the observation is stale, the setting is not.
  if (obs.signal.source === "none" && sendingSignal === true) {
    return { isSet: false, sourceKey: "sourceNeedsReload", accent: false };
  }

  // A browser or another extension owning the property says who decides the value, not
  // what the value is. A browser that implements GPC with it switched off reads false, and
  // naming the owner alone would put "signal is set, by the browser" over that false. Our
  // header rule does not stand down for another owner (sw.ts applySignalPolicyNow). With
  // sending on, the page property reads true over the owner's value too (assert.ts), so this
  // is left for an owner whose property could not be wrapped: sites get Sec-GPC: 1 while
  // page scripts read false, and the tag says both.
  if (obs.signal.source === "native" || obs.signal.source === "other-extension") {
    const browser = obs.signal.source === "native";
    if (obs.signal.propertyValue === true) {
      return { isSet: true, sourceKey: browser ? "sourceBrowser" : "sourceOtherExtension", accent: false };
    }
    const headerSent = sendingSignal === true || obs.signal.secGpcRequestCount > 0;
    if (headerSent) {
      return {
        isSet: false,
        sourceKey: browser ? "sourceBrowserOffHeaderSent" : "sourceOtherExtensionOffHeaderSent",
        accent: false,
      };
    }
    return { isSet: false, sourceKey: browser ? "sourceBrowserOff" : "sourceOtherExtensionOff", accent: false };
  }

  switch (obs.signal.source) {
    case "this-extension":
      return { isSet: true, sourceKey: "sourceThisExtension", accent: true };
    case "none":
    default:
      return { isSet: false, sourceKey: "sourceOffInSettings", accent: false };
  }
}

/**
 * The "what this site did" rows.
 *
 * Every row is an observation. Where a value is absent we say so plainly rather than
 * omitting the row, because a missing row reads as "we didn't check" while "not present"
 * is a fact. That includes "still checking": a row that is briefly missing on every fresh
 * load reads exactly the same as one that is missing for good.
 */
function siteDidRows(obs: ObservationSet, input: BuildInput): KvRow[] {
  // The confirmation comes FIRST: some states require a business to display one, and none
  // requires the published file, so the row a law can turn on leads.
  const rows: KvRow[] = [];

  // GPP, USP and TCF are in their own section (privacyStringRows), not here: this section
  // reports how the site responded to GPC, that one reports artifacts the site broadcasts
  // about the reader, and mixing them would leave flat rows answering two unrelated
  // questions with no hierarchy between them. Which vendors read GPC is under that section
  // (PopupView.gpcReads), not here: the answer depends on the strings.

  // Confirmation notice. The label says "shown on page", which is the whole scope of the
  // claim: §7025(c)(6) says "for example", so a settings-page placement satisfies it and
  // this scan cannot see it. The label carries that caveat, and a hint line repeating it
  // under the negative would cost vertical space, so there is none.
  //
  // "Indeterminate" means the content script has not reported a scan yet. The row is shown
  // then too: omitted, it would be the one row in a section whose rule is "say the absence
  // plainly" that does not.
  if (obs.confirmationNotice === "detected") {
    rows.push({ labelKey: "labelConfirmation", value: null, valueKey: "valueYes" });
  } else if (obs.confirmationNotice === "not-detected") {
    rows.push({ labelKey: "labelConfirmation", value: null, valueKey: "valueNo" });
  } else {
    rows.push({ labelKey: "labelConfirmation", value: null, valueKey: "valueChecking" });
  }

  // The published GPC resource. ALWAYS shown, as one of six states.
  //
  // Shown even when no file was found, though no law requires the file and most sites lack
  // one: with a row that sometimes exists and sometimes doesn't, the reader can't tell "we
  // checked and found nothing" from "we didn't check" from "the check is off in settings",
  // three different facts collapsing into one silence. "Checking" is the fourth of those
  // facts: wellKnown is null until the fetch resolves, and rendering that as "not found"
  // would say an absence we had not yet looked for.
  //
  // The label carries the claim ("Declares GPC support") and the value is the site's own
  // answer, so the site stays the speaker and we stay the reporter. The path travels as a
  // monospace hint: a reader who knows the well-known convention recognizes it, one who
  // does not can ignore it.
  //
  // A cached declaration is an observation with a date rather than a current fact — the site
  // can retract the file at any time — but that caveat is not printed under the row. The
  // policy is stated once, where it belongs, in the settings entry that controls the check
  // (settingWellKnownDesc). The distinction is kept where it matters: the engine's
  // `declared-honor-cookie-set` finding requires wk.fresh, so it never rests on a
  // declaration that may have been withdrawn.
  // The address that was checked, without its scheme, is the hint: the reader sees which
  // host was asked, which is also where a subdomain miss becomes visible. When a redirect
  // led to a file, it is the address the file was served from.
  const wk = obs.wellKnown;
  const path: HintPart = { text: (wk?.url ?? "").replace(/^https?:\/\//, "") };
  if (input.checkWellKnownEnabled === false) {
    rows.push({ labelKey: "labelWellKnown", value: null, valueKey: "valueWellKnownDisabled" });
  } else if (wk === null) {
    rows.push({ labelKey: "labelWellKnown", value: null, valueKey: "valueChecking" });
  } else if (gotNoAnswer(wk)) {
    // No answer at all (a timeout, a network error, a redirect whose target was never
    // reported) is not an absence: nothing was learned about the file. "Not found" here
    // would say a site publishing `gpc: true` had no file.
    rows.push({
      labelKey: "labelWellKnown",
      value: null,
      valueKey: "valueWellKnownUnchecked",
      hintParts: [path, { key: "hintWellKnownNoResponse" }],
      hintMono: true,
    });
  } else if (!wk.present) {
    // Still "not found" for a refusal, but the hint says what the server answered: a 403
    // from bot protection (social-b.example, social-c.example) is a different fact from a 404, and the
    // reader can tell them apart.
    const status = /^status (\d{3})$/.exec(wk.reason ?? "")?.[1];
    const answered: HintPart[] = status ? [{ key: "hintWellKnownStatus", substitution: [status] }] : [];
    rows.push({
      labelKey: "labelWellKnown",
      value: null,
      valueKey: "valueWellKnownNotPresent",
      hintParts: [path, ...answered],
      hintMono: true,
    });
  } else {
    rows.push({
      labelKey: "labelWellKnown",
      value: null,
      valueKey: wk.gpc === true ? "valueYes" : "valueNo",
      hintParts: [path],
      hintMono: true,
    });
  }

  return rows;
}

/**
 * "Did vendors read GPC from the page": which vendors read the signal, which did not, and
 * which we cannot tell, as a group of two or three rows under that heading (PopupView.gpcReads).
 *
 *   Did vendors read GPC from the page
 *   | GPC read           always; "none" when nobody was traced
 *   | No read observed   always; "none" when nobody is in that state
 *   | Cannot determine   only when someone is in that state
 *
 * Under the privacy strings, not among the site's own rows: a GPP call is a read only by
 * what the site's string records (gppCallReads), so the strings are read first and this
 * answer after them.
 *
 * Not one list-shaped row with "Yes:", "No:" and "Cannot determine:" lines under a "Read
 * GPC" label, where Yes and No are hard to tell apart at a glance. A label each makes the
 * difference the layout's; nesting them under one heading keeps them parts of one answer,
 * where three rows of their own would read as three findings. The heading says the rows
 * list vendors (and domains with no company), once, and no label repeats it; the hint
 * lines under a row name the other readers, which are not vendors. Every vendor stays on
 * them, not only some categories: a consent tool reading GPC is often the read that
 * matters most.
 *
 * "From the page" is the scope of every claim here: a script reading the property or
 * calling the GPP API. The Sec-GPC request header is a third channel, acted on server-side
 * where no extension can see it, which is why the second label says "no read observed" and
 * never "did not read". The vendor list's column keeps its own short states.
 *
 * A vendor is a company in one category, named with it: "Microsoft (Analytics)" beside
 * "Microsoft (Advertising)" in the other row is two facts about two products. Every one is
 * listed, alphabetical by company and then by category in the list's order. No company and
 * category is in two rows.
 *
 * The page's other facts go in hint tone under the row they are about. Under the first,
 * more readers: one or more tags in a named container; the domains of scripts that read
 * it and belong to no vendor; a GPP call whose caller could not be identified; reads
 * counted but none traced. Under the second, what weakens a negative: reads not
 * observable, and the read-trace cap. At the bottom of the group, the site's GPP string
 * set against the reads: silent on the choice, or recording it with nothing reading it. Reads that
 * were sampled and resolved to nothing are not mentioned here: that caveat lives in each
 * vendor's help, which is where a reader acts on it.
 *
 * The rows are the vendor rows in a read state, no read state or undetermined one. A
 * script that read and has no row is resolved here: a third-party script of a named
 * company joins the first row under its category; every other script is named by its
 * domain on the line of domains, the site's own first and marked as such. That is where
 * ALL of the site's own scripts go, whether or not Disconnect names an owner for the site:
 * the rows hold third-party vendors and nothing else. The exact read count is never shown:
 * a consent tool polling the property in a loop produces thousands of reads, and the
 * number measures dwell time. It remains in each vendor's detail panel.
 */
function checkedRow(obs: ObservationSet, input: BuildInput, vendorRowsForPage: readonly VendorRow[]): KvRow {
  const signal = obs.signal;
  const signalOn = signal.source !== "none";
  const gppCalls = obs.consentApiCalls.filter((c) => c.api === "__gpp");
  // A call counts by the one rule for which `__gpp` calls are checks (gppCheckTest): a GPP
  // 1.0 ping asked whether a consent manager exists and is no check.
  const isGppCheck = gppCheckTest(obs);
  const gppCalled = gppCalls.some(isGppCheck);
  const record = gppGpcRecord(obs.gpp);
  const readsUnavailable = signal.readTracking === "unavailable";
  const reads = readsUnavailable ? 0 : (signal.readCount ?? 0);
  const capped = signal.readAttribution?.traceCapReached === true;

  // Who read GPC, in three lists that must never share a name. Seen 2026-09-22 on three
  // sites: Criteo under both Yes and No on news-n.example (JWP Connatix on news-m.example,
  // AlibabaGroup on marketplace-c.example). Yes came from here, where a script's `__gpp` ping
  // counted as a read; No came from the vendor row, whose rule did not count a ping
  // (vendor-signal-check). Two definitions of one question.
  //
  // So a vendor with a row is placed by its row alone, below. Resolution here only adds
  // what no row covers. A ping is counted here exactly as the rule counts it, by the one test
  // both call (gppCheckTest): a read under GPP 1.1, where its answer carries the string, and
  // not under 1.0, where it only asks whether a consent tool exists.
  //
  // And only a read that succeeded is a Yes: a GPP call is a read of the choice when the
  // string it got back records one (gppCallReads). A vendor told nothing about GPC is No;
  // one whose call returned no string we could decode is Cannot determine.
  // A domain with no company (1.26.0) is named as a domain, with no category after it.
  type Named = { readonly name: string; readonly category?: string; readonly domain?: true };
  const placed = new Map<string, { readonly who: Named; line: "yes" | "unsure" | "no" }>();
  const RANK = { yes: 0, unsure: 1, no: 2 } as const;
  const place = (who: Named, line: "yes" | "unsure" | "no"): void => {
    const key = who.domain === true ? rowKeyOf(who.name, "unlisted") : rowKeyOf(who.name, who.category);
    const at = placed.get(key);
    // One line for each company and category. A row is one already; this is what holds
    // when two sources name the same one.
    if (at === undefined) placed.set(key, { who, line });
    else if (RANK[line] < RANK[at.line]) at.line = line;
  };
  for (const v of vendorRowsForPage) {
    const who: Named =
      v.group === "unlisted" ? { name: v.name, domain: true } : { name: v.name, ...(v.category !== undefined ? { category: v.category } : {}) };
    switch (v.checkKey) {
      case "vendorGpcRead":
      case "vendorGpcReadProperty":
        place(who, "yes");
        break;
      case "vendorGpcNotRead":
      case "vendorGpcAskedNoGpcField":
        place(who, "no");
        break;
      case "vendorGpcCheckUnattributable":
      case "vendorGpcAskedNoResponse":
      case "vendorGpcCheckUntraced":
        place(who, "unsure");
        break;
      default:
        break;
    }
  }

  // The scripts that read and have no row. A domain with a row of the last group is placed
  // by it above; one without (no summary kept for it, or a bundle from before 1.26.0) stays
  // in "Also scripts from".
  const rowKeys = new Set(vendorRowsForPage.map((v) => v.key));
  // A counted domain with no company is a domain row too, placed by its row.
  const domainRows = new Set(vendorRowsForPage.filter((v) => v.group === "unlisted" || v.detail.unlistedDomain === true).map((v) => v.name));
  // A company whose rows name no category is placed by them, whatever category its script
  // came from: the capture could not say, and a second entry under a category would be the
  // same company twice.
  const uncategorized = new Set(vendorRowsForPage.filter((v) => v.category === undefined).map((v) => v.name));
  let siteDomain: string | null = null;
  const otherDomains = new Set<string>();
  const resolve = (url: string): void => {
    const cls = classOf(url, obs, input);
    if (cls.party === "first") siteDomain = cls.domain;
    else if (cls.entity === null) {
      if (!domainRows.has(cls.domain)) otherDomains.add(cls.domain);
    }
    else if (!rowKeys.has(rowKeyOf(cls.entity, cls.category)) && !uncategorized.has(cls.entity)) {
      place({ name: cls.entity, category: cls.category }, "yes");
    }
  };
  for (const url of Object.keys(signal.readsByScript)) resolve(url);
  // A GPP call with no row, a caller nobody could identify and a call from a container all
  // count as a read only when the string records a GPC value, as a row's call does.
  const gppCallers = new Set<string>();
  let gppUnidentified = false;
  const gppReads = gppCallReads(record, signalOn);
  for (const c of gppCalls) {
    if (!isGppCheck(c) || !gppReads) continue;
    if (c.callerScriptUrl !== null && !c.viaTagManager) gppCallers.add(c.callerScriptUrl);
    else if (c.callerScriptUrl === null && !c.viaTagManager) gppUnidentified = true;
  }
  for (const url of gppCallers) {
    if (!(url in signal.readsByScript)) resolve(url);
  }

  // The same test as every other call (gppCheckTest): a GPP 1.0 ping from a container asked
  // whether a consent tool exists and is not a read.
  const viaTagManager =
    (signal.readAttribution?.viaTagManager ?? 0) > 0 || (gppReads && gppCalls.some((c) => isGppCheck(c) && c.viaTagManager));
  // Which containers those checks came from, by id, where the frame URL named one. Empty
  // for a bundle recorded before 1.12.0 or a container that names nothing, in which case
  // the wording falls back to "the tag manager".
  const containerIds = namedContainersWithChecks(obs);

  const on = (line: "yes" | "unsure" | "no"): Named[] =>
    [...placed.values()]
      .filter((p) => p.line === line)
      .map((p) => p.who)
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
          categoryRank(a.category ?? "advertising") - categoryRank(b.category ?? "advertising"),
      );
  // The names alone, drawn where the line has no text of its own: the row label says
  // which list it is.
  const names = (who: readonly Named[]): KvLine => ({
    parts: [],
    list: who.map((w) => ({
      text: w.name,
      ...(w.domain === true ? { domain: true as const } : w.category !== undefined ? { categoryKey: categoryLabelKey(w.category) } : {}),
    })),
  });
  // A row with nobody in it is an ordinary label and value, "none", and keeps its
  // hint lines: a tag or a script of no vendor can still have read it.
  const row = (labelKey: string, who: readonly Named[], hints: readonly KvLine[]): KvRow =>
    who.length === 0
      ? { labelKey, value: null, valueKey: "valueReadNone", ...(hints.length > 0 ? { lines: hints } : {}) }
      : { labelKey, value: null, lines: [names(who), ...hints] };
  const yes = on("yes");
  const unsure = on("unsure");

  const hint = (part: HintPart): KvLine => ({ parts: [part], tone: "hint" });
  const readers: KvLine[] = [];
  if (viaTagManager) {
    // "also" only when a vendor is named above it.
    const also = yes.length > 0;
    readers.push(
      hint(
        containerIds.length === 1
          ? { key: also ? "hintCheckedContainerAlso" : "hintCheckedContainerRead", substitution: [containerIds[0] as string] }
          : containerIds.length > 1
            ? { key: also ? "hintCheckedContainersAlso" : "hintCheckedContainersRead", substitution: [containerIds.join(", ")] }
            : { key: also ? "hintCheckedTagManagerAlso" : "hintCheckedTagManagerRead" },
      ),
    );
  }
  // The scripts no vendor row covers, by domain and never by count: a count hides who, and
  // who is often the site's consent tool. A domain is named once however many of its files
  // read, the site's own first, then alphabetical.
  const others: KvListItem[] = [
    ...(siteDomain !== null ? [{ text: siteDomain as string, domain: true as const, thisSite: true as const }] : []),
    ...[...otherDomains].sort().map((d) => ({ text: d, domain: true as const })),
  ];
  if (others.length > 0) {
    readers.push({ parts: [{ key: "hintCheckedOtherDomains", substitution: [LIST_MARK] }], tone: "hint", list: others });
  }
  if (gppUnidentified) readers.push(hint({ key: "hintGppCalledUnidentified" }));
  // Reads were counted and not one of them was traced to anything: a fact the rows cannot
  // show, since "none" would otherwise read as "nothing read it".
  const noneTraced = reads > 0 && yes.length === 0 && !viaTagManager && others.length === 0;
  if (noneTraced) readers.push(hint({ key: "hintReadsNoneTraced" }));
  // A property read whose stack named no script, beside reads that did name one. Where
  // nothing was named, the line above already says so.
  else if (unidentifiedPropertyReads(obs)) readers.push(hint({ key: "hintReadsUnidentified" }));

  // What weakens a negative. Past the trace cap a read may have gone untraced, so a vendor
  // in this row may have read; that is a fact about the measurement, not the vendors.
  const negatives: KvLine[] = [];
  if (readsUnavailable) negatives.push(hint({ key: "hintReadsUnavailable" }));
  if (capped) negatives.push(hint({ key: "hintReadsCapped" }));

  // The site's GPP string against the reads: about the whole group, so at the bottom of it
  // and under none of its rows, where it would read as a note on that row's vendors.
  const strings: KvLine[] = [];
  if (gppCalled && signalOn && record === "silent") strings.push(hint({ key: "hintGppStringSilent" }));
  // Only where reads are observable: with them untraced, "no script read it" is not known.
  if (!readsUnavailable && reads === 0 && !gppCalled && record === "records") strings.push(hint({ key: "hintNoCheckGppRecords" }));

  const parts: KvRow[] = [row("labelReadObserved", yes, readers), row("labelReadNotObserved", on("no"), negatives)];
  if (unsure.length > 0) parts.push(row("labelReadUndetermined", unsure, []));
  return { labelKey: "labelCheckedForGpc", value: null, rows: parts, ...(strings.length > 0 ? { lines: strings } : {}) };
}

/**
 * Whether a traced read of the GPC property named no script (bundled, inline or evaluated
 * code). Such a read may have been any vendor's, so it weakens every "no read observed",
 * the way the trace cap does, without moving any vendor out of that state: who made it is
 * not known.
 */
function unidentifiedPropertyReads(obs: ObservationSet): boolean {
  return obs.signal.readTracking !== "unavailable" && (obs.signal.readAttribution?.unattributed ?? 0) > 0;
}

/**
 * Findings the engine produced that deserve their own line.
 *
 * What the ENGINE concluded is rendered, not re-derived from observations, so a
 * site-level contradiction it establishes never stays invisible.
 *
 * Only site-level contradictions are surfaced here. Per-vendor findings already have a
 * home in the vendor rows, and repeating them would double-count in the reader's eye.
 *
 * Note what is NOT here: a container's Consent Mode state paired with a cookie count.
 * Consent Mode propagates a choice to Google's tags and does not bind other vendors, so
 * that pairing would assert a contradiction that has not been established. The container's
 * state is reported as context instead.
 */
const SURFACED_FLAGS: Record<string, string> = {
  "gpp-conflict": "findingGppConflict",
  "gpp-surfaces-disagree": "findingGppDisagree",
  "usp-surfaces-disagree": "findingUspDisagree",
  "usp-requests-disagree": "findingUspRequestsDisagree",
  "gpp-requests-disagree": "findingGppRequestsDisagree",
  // declared-honor-cookie-set is NOT here. The site's statement has its row under "What
  // this site did" and the cookies have the count, so a notice would repeat both.
  // signal-not-read is NOT here. "No script on this page read the GPC signal" would restate
  // the GPC read rows as a finding, and read as "the site ignored the signal", which
  // a property nobody read cannot establish: the Sec-GPC header is a second channel.
  // Both directions share one sentence. What differs between them is the pair of values
  // underneath, which is where the difference actually is.
  "gpc-sent-gpp-field-no": "findingGpcGppMismatch",
  "gpc-not-sent-gpp-field-yes": "findingGpcGppMismatch",
};


function findingNotices(findings: readonly Finding[]): Notice[] {
  const seen = new Set<string>();
  const out: Notice[] = [];
  for (const f of findings) {
    const key = SURFACED_FLAGS[f.flag];
    if (key === undefined || seen.has(f.flag)) continue;
    seen.add(f.flag);

    // The bare accusation isn't actionable — a reader has to go open the Requests tab and
    // search for `us_privacy=` themselves to find out what actually disagreed with what.
    // The finding's own artifact already carries both values; show them instead of making
    // the reader re-derive what the engine already computed.
    if (f.flag === "usp-surfaces-disagree" && f.artifact.kind === "usp") {
      const { fromApi, fromCookie, fromWire } = f.artifact;
      // Every request carried what the API reports, and the cookie holds something else:
      // the disagreement is the page's own two surfaces, and the request sentence below
      // would set one value against itself.
      if ((fromWire === null || fromWire === fromApi) && fromApi !== null && fromCookie !== null && fromCookie !== fromApi) {
        out.push({ kind: "finding", tone: "finding", placement: "top", textKey: "findingUspCookieDisagree", substitution: [fromApi, fromCookie] });
        continue;
      }
      const page = uspPageValue(f.artifact) ?? "?";
      const wire = f.artifact.fromWire ?? "?";
      // Which host carried the value shown, from the finding itself (1.29.0), not from the
      // most recent request, which need not be the one that carried this value.
      const host = f.artifact.fromWireHost;
      out.push({
        kind: "finding",
        tone: "finding",
        placement: "top",
        textKey: host ? "findingUspDisagreeHost" : key,
        substitution: host ? [page, host, wire] : [page, wire],
      });
      continue;
    }

    // The page reported no string and requests carried different ones. The first two, each
    // with the first host that was sent it; the panel under the row lists every one.
    if (f.artifact.kind === "wire-values") {
      const [a, b] = f.artifact.values;
      if (a === undefined || b === undefined) continue;
      out.push({
        kind: "finding",
        tone: "finding",
        placement: "top",
        textKey: key,
        substitution: [a.value, a.hosts[0] ?? "?", b.value, b.hosts[0] ?? "?"],
      });
      continue;
    }

    // Same reasoning as usp-surfaces-disagree above, one surface fewer (no cookie — see
    // GppObservation.fromWire). Both values on the "gpp-wire" artifact are guaranteed
    // non-null: gppSurfacesDisagree only fires when both rawString and fromWire are
    // present.
    if (f.flag === "gpp-surfaces-disagree" && f.artifact.kind === "gpp-wire") {
      out.push({
        kind: "finding",
        tone: "finding",
        placement: "top",
        ...(f.artifact.fromWireHost
          ? { textKey: "findingGppDisagreeHost", substitution: [f.artifact.fromApi, f.artifact.fromWireHost, f.artifact.fromWire] }
          : { textKey: key, substitution: [f.artifact.fromApi, f.artifact.fromWire] }),
      });
      continue;
    }

    // The GPC/GPP mismatch, in the same treatment as every other notice in this section.
    //
    // Not the neutral tone, though this is context rather than something the site is
    // answerable for: the tone is not a verdict. DESIGN.md §2 defines `finding` as the
    // loudest block on the page carrying NO hue and therefore no severity: "a fact stated
    // firmly, not a warning". A disagreement between two values we both observed is exactly
    // that, and rendering it gray among dark blocks would make the one notice about the
    // reader's own signal the quietest thing in the list.
    //
    // The sentence still says only that they do not match, and no cause is offered: several
    // innocent ones exist and we cannot tell them apart (see engine rules/gpc-vs-gpp.ts).
    if (f.artifact.kind === "gpc-vs-gpp") {
      const propertyValue = f.artifact.propertyValue;
      out.push({
        kind: "finding",
        tone: "finding",
        placement: "top",
        textKey: key,
        pairs: [
          {
            labelKey: "labelGpcSignalValue",
            ...(propertyValue === true
              ? {
                  valueKey: "valueGpcSignalSet",
                  valueSubstitution: [String(f.artifact.secGpcRequestCount)],
                }
              : { valueKey: "valueGpcSignalNotSet" }),
          },
          {
            labelKey: "labelGppGpcFieldValue",
            // One key per value rather than a decoded word substituted into a wrapper: the
            // view-model resolves no copy, and nesting one key inside another's
            // substitution is not something the i18n layer can express.
            valueKey: f.artifact.gpcField === 1 ? "valueGppGpcFieldSet" : "valueGppGpcFieldNotSet",
          },
        ],
      });
      continue;
    }

    out.push({ kind: "finding", tone: "finding", placement: "top", textKey: key });
  }

  return out;
}

/**
 * What a failed capability means, in the reader's terms.
 *
 * The plain phrase LEADS and the API identifier is dropped. "documentCookie (cookies set
 * by JavaScript), gpp (the privacy string) or dataLayer (Consent Mode)" would put three
 * camelCase internals in a consumer sentence, each with its own meaning in parentheses
 * behind it, which is backwards: the identifier is the part the reader cannot use and the
 * explanation is the part they need. Nobody debugging this extension learns anything from
 * the popup that they would not get from the record a finding report carries, which holds
 * the raw capability keys already (`capabilities`).
 *
 * `technical` is retained solely as the de-duplication key: documentCookie and cookieStore
 * are two interceptors for one observable fact, and naming it twice would imply two
 * separate gaps.
 */
const CAPABILITY_NAMES: Record<string, { technical: string; plain: string }> = {
  documentCookie: { technical: "documentCookie", plain: "cookies set by JavaScript" },
  cookieStore: { technical: "documentCookie", plain: "cookies set by JavaScript" },
  gpp: { technical: "gpp", plain: "the GPP privacy string" },
  uspapi: { technical: "uspapi", plain: "the US Privacy string" },
  tcfapi: { technical: "tcfapi", plain: "the TCF string" },
  dataLayer: { technical: "dataLayer", plain: "Consent Mode" },
};

/**
 * Whether a page at `url` is a secure context, where `cookieStore` exists: https, and http
 * only on a loopback host, which browsers treat as secure.
 */
function isSecureContextUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:") return true;
    const host = u.hostname;
    return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
  } catch {
    return true;
  }
}

/**
 * The capabilities as the popup reads them. A bundle recorded before 1.35.0 holds
 * `cookieStore: false` for every http:// page, where the API does not exist and there was
 * nothing to observe; read as the capture records it since then, true. The capture's own
 * false, a store that exists and could not be wrapped, still stands on an https page.
 */
export function capabilitiesAsRead(obs: ObservationSet): ObservationSet["capabilities"] {
  if (obs.capabilities.cookieStore || isSecureContextUrl(obs.context.finalUrl)) return obs.capabilities;
  return { ...obs.capabilities, cookieStore: true };
}

export function describeFailedCapabilities(
  capabilities: ObservationSet["capabilities"],
): string | null {
  const seen = new Set<string>();
  const parts: string[] = [];

  for (const [key, ok] of Object.entries(capabilities)) {
    if (ok !== false) continue;
    const named = CAPABILITY_NAMES[key];
    if (!named || seen.has(named.technical)) continue;
    seen.add(named.technical);
    parts.push(named.plain);
  }

  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0] as string;
  const last = parts.pop() as string;
  return `${parts.join(", ")} or ${last}`;
}

/**
 * Whether a Google tag loaded: a container or gtag id was seen, or its script was fetched
 * (scriptFetched, recorded as the request was seen, 1.22.0, so a worker reclaim does not
 * lose it).
 */
function googleTagLoaded(obs: ObservationSet): boolean {
  return googleTagObserved(obs.gtm);
}

/**
 * The site's own company is also on the page's ad and analytics vendor list.
 *
 * Third-party is decided by domain, so a company's other domains count as a third-party
 * vendor on its own site: seen 2026-09-22 on yahoo.com (Yahoo's consent cookies from
 * consent.cmp.oath.com), amazon.com, ebay.com, tiktok.com, reddit.com and aliexpress.us.
 * Whether a transfer inside one company is a sale or share turns on facts this extension
 * cannot see (common branding, service-provider contracts), so the counts stay as they are
 * and this says what the classification means. docs/LIMITATIONS.md has the long form.
 *
 * Keyed on the owner Disconnect gives the top site, not on the top site's own category:
 * Disconnect files yahoo.com, amazon.com and reddit.com as Content, so a category test would
 * miss four of the six sites above.
 */
function sameOwnerNotice(
  obs: ObservationSet,
  input: BuildInput,
  vendors: readonly VendorRow[],
): Notice | null {
  if (obs.context.topSite === "") return null;
  const owner = input.classify?.(`https://${obs.context.topSite}/`)?.entity ?? null;
  if (owner === null) return null;
  // The owner's COUNTED rows, and only those. The notice explains a count, and says the
  // owner is categorized as an advertising or analytics vendor: a row under Content would
  // have it say that of yahoo.com on the strength of yimg.com.
  const mine = vendors.filter((v) => v.name === owner && v.counted && v.detail.unlistedDomain !== true);
  if (mine.length === 0) return null;
  // Name what Disconnect lists the owner's request domains as: ad or analytics when they
  // are all one, both when they are some of each (tiktok.com: Bytedance's requests went to
  // advertising and analytics domains). Unknown goes with ad, as it does in the name order
  // under the headline.
  const analytics = mine.some((v) => v.category === "analytics");
  const advertising = mine.some((v) => v.category !== "analytics");
  return {
    kind: "ownership",
    tone: "neutral",
    placement: "top",
    textKey: analytics && advertising ? "noticeSameOwnerBoth" : analytics ? "noticeSameOwnerAnalytics" : "noticeSameOwnerAdvertising",
    substitution: [owner],
  };
}

/**
 * The Overview's notice for an incomplete capture, or null when it needs none (1.22.0).
 *
 * A worker reclaim loses only the request list: the counts, the findings and every vendor
 * judgment are built from what survives it, so the Overview says nothing and the Requests
 * tab says what is missing (requestsDropped). Every other reason loses something the
 * Overview is built from, and one notice names the most serious, in this order. A bundle
 * from before the reasons were recorded gets the general one.
 */
const INCOMPLETE_NOTICES: readonly (readonly [readonly IncompleteReason[], string])[] = [
  [["write-failed", "read-failed", "prerender-lost"], "stateSaveFailed"],
  [["delivery-gap"], "stateDeliveryGap"],
  [["consent-calls-capped"], "stateConsentCallsCapped"],
];

function incompleteNoticeKey(obs: ObservationSet): string | null {
  if (!obs.context.incomplete) return null;
  const reasons = obs.context.incompleteReasons;
  if (reasons === undefined || reasons.length === 0) return "stateIncomplete";
  for (const [matching, key] of INCOMPLETE_NOTICES) {
    if (matching.some((r) => reasons.includes(r))) return key;
  }
  return null;
}

function noticesFor(obs: ObservationSet, findings: readonly Finding[]): Notice[] {
  // The load was not observed, and this is the ONLY notice. It is the same class of fact as
  // the two below (part of this page was not observed) taken to its limit, so it takes their
  // tone and their slot, at the top where a reader returning after an update looks first.
  // Everything else a notice could say would be about a load nobody watched: a finding
  // built from a handful of late requests is not a finding.
  if (obs.context.loadObserved === false) {
    return [
      { kind: "incomplete", tone: "unavailable", placement: "top", textKey: "stateNeedsReload" },
    ];
  }
  // The same limit reached another way: the page did not load, so there was nothing to
  // observe, and a few requests made before the failure are not a page.
  if (obs.context.loadError) {
    return [{ kind: "incomplete", tone: "unavailable", placement: "top", textKey: "stateLoadFailed" }];
  }

  const out: Notice[] = [];

  // An interceptor that failed to install means part of this page was not observable.
  // Saying so is the difference between a partial view and a wrong one.
  // A page with no Google tag has no dataLayer to watch, and the capability stays false.
  // That is nothing to observe, not a failure to observe: "We could not observe Consent
  // Mode" topped about half the popups in the 2026-09-22 run, marketplace-a.example's included. And a
  // page whose consent store was read did have its Consent Mode observed, dataLayer or not.
  // The capture applies the same test since 1.31.0; it is repeated here for older bundles.
  // The same holds for cookieStore on an http:// page, where the API does not exist
  // (capabilitiesAsRead, 1.35.0).
  const failed = describeFailedCapabilities(
    consentModeNeedsDataLayer(obs.gtm) ? capabilitiesAsRead(obs) : { ...capabilitiesAsRead(obs), dataLayer: true },
  );
  if (failed !== null) {
    out.push({
      kind: "incomplete",
      tone: "unavailable",
      placement: "top",
      textKey: "stateCaptureUnavailable",
      substitution: failed,
    });
  }

  // Also "unavailable", not neutral. An incomplete capture and a failed interceptor are the
  // same class of fact — part of this page was not observed — and rendering one amber and
  // the other plain would give one meaning two treatments on the same surface.
  const incompleteKey = incompleteNoticeKey(obs);
  if (incompleteKey !== null) {
    out.push({
      kind: "incomplete",
      tone: "unavailable",
      placement: "top",
      textKey: incompleteKey,
    });
  }

  // The confirmation notice is NOT a notice. It is something the site did, and it already
  // has a row under "what this site did with it": a banner above the numbers would
  // duplicate it and, with sending off, claim the site had processed a signal we were not
  // sending.

  out.push(...findingNotices(findings));

  return out;
}

/**
 * The ids of containers that made at least one GPC check, in first-seen order, from the
 * engine's per-container count. A container whose frames name no id (a Google helper, a
 * pre-1.12.0 bundle) is not listed; its checks still count toward "via tag manager". The
 * first GPC read row's hint names them.
 */
function namedContainersWithChecks(obs: ObservationSet): string[] {
  const ids: string[] = [];
  for (const entry of checksByContainer(obs).values()) {
    if (entry.identity.id !== null && entry.checks > 0) ids.push(entry.identity.id);
  }
  return ids;
}

function loadersOnArtifact(f: Finding): readonly LoaderIdentity[] {
  const a = f.artifact;
  if (a.kind === "network" || a.kind === "tally" || a.kind === "vendor-check-container") return a.loadedVia ?? [];
  // A read carries its loaders too (1.26.0), so a row that read GPC names who loaded it.
  if (a.kind === "consent-api" || a.kind === "signal-read") return a.loadedVia ?? [];
  if (a.kind === "vendor-check-loader") return a.loadedVia ?? [a.loader];
  return [];
}

/**
 * The help text for a vendor's check state, from its artifact.
 *
 * The flag's own help (`<checkKey>Help`) is the page-wide sentence. When the engine judged
 * the vendor by its loader chain, the artifact says which loader and by which route, and
 * each combination is its own sentence, because "the CMP sits beside this tag", "the
 * wrapper that loaded this tag read it" and "the site's own script read it" are different
 * facts a reader should be able to tell apart. A CMP one level up, in a parent container,
 * is context on the scoped no-read state rather than a state of its own.
 */
function checkHelpFor(
  checkKey: VendorRow["checkKey"],
  f: Finding | undefined,
  opts: { readonly traceCapReached?: boolean; readonly unidentifiedReads?: boolean; readonly gppSilentSignalOff?: boolean } = {},
): VendorRow["checkHelp"] {
  const fallback = { key: `${checkKey}Help` };
  // Reads could not be observed at all: no loader or container sentence can say more.
  if (checkKey === "vendorGpcCheckUntraced") return fallback;
  // Past the trace cap, a "no read" is a read that may have gone untraced, and the sentence
  // has to say why and where the reader can change it. It replaces the loader and
  // container variants: the cap is the larger fact.
  if (opts.traceCapReached === true && checkKey === "vendorGpcNotRead") {
    return { key: "vendorGpcNotReadHelpCapped" };
  }
  // A property read that named no script may have been this vendor's. Like the cap, it
  // replaces the loader and container variants and leaves the state as it is.
  if (opts.unidentifiedReads === true && checkKey === "vendorGpcNotRead") {
    return { key: "vendorGpcNotReadHelpUnidentified" };
  }
  // A GPP read with the signal off, of a string silent on GPC: it read what was true, and the
  // sentence must not say the string includes a choice it does not record.
  if (checkKey === "vendorGpcRead" && opts.gppSilentSignalOff === true) return { key: "vendorGpcReadHelpSignalOff" };
  if (!f) return fallback;
  const a = f.artifact;
  if (a.kind === "vendor-check-loader") {
    const l = a.loader;
    // The order sentence names what was loaded: "this tag" after a container loader, the
    // row's own noun after a vendor, host or site loader (domainHelp swaps it on a domain row).
    const ORDER_KEYS = {
      parent: ["vendorGpcCheckOrderParentBefore", "vendorGpcCheckOrderParentAfter"],
      tag: ["vendorGpcCheckOrderBefore", "vendorGpcCheckOrderAfter"],
      row: ["vendorGpcCheckOrderBeforeVendor", "vendorGpcCheckOrderAfterVendor"],
    } as const;
    const order = (before: boolean | null, loaded: keyof typeof ORDER_KEYS): { orderKey?: string } =>
      before === null ? {} : { orderKey: ORDER_KEYS[loaded][before ? 0 : 1] };
    // The loader's id, and the id of the container that loaded the vendor. Either can be
    // null (a container whose address names nothing): a sentence then leaves the id out
    // rather than print "()".
    const id = l.kind === "container" ? l.identity.id : null;
    const ownId = a.loadedVia?.find((x): x is Extract<LoaderIdentity, { kind: "container" }> => x.kind === "container")?.identity.id ?? null;
    if (f.flag === "vendor-gpc-unread-via-container") {
      if (a.route === "ancestor") {
        // The loader is the parent that read; the vendor's own container is on loadedVia.
        const parent = id ?? "";
        return ownId === null
          ? { key: "vendorGpcNotReadViaContainerHelpParentReadUnnamed", substitution: [parent], ...order(a.checkedBeforeLoad, "parent") }
          : { key: "vendorGpcNotReadViaContainerHelpParentRead", substitution: [ownId, parent], ...order(a.checkedBeforeLoad, "parent") };
      }
      return id === null ? { key: "vendorGpcNotReadViaContainerHelpContainerUnnamed" } : { key: "vendorGpcNotReadViaContainerHelpContainer", substitution: [id] };
    }
    if (a.route === "consent-mode") {
      const other = id ?? "";
      return ownId === null
        ? { key: "vendorGpcCheckUnattributableHelpConsentModeUnnamed", substitution: [other], ...order(a.checkedBeforeLoad, "tag") }
        : { key: "vendorGpcCheckUnattributableHelpConsentMode", substitution: [ownId, other], ...order(a.checkedBeforeLoad, "tag") };
    }
    switch (l.kind) {
      case "container":
        return id === null
          ? { key: "vendorGpcCheckUnattributableHelpContainerUnnamed", ...order(a.checkedBeforeLoad, "tag") }
          : { key: "vendorGpcCheckUnattributableHelpContainer", substitution: [id], ...order(a.checkedBeforeLoad, "tag") };
      case "entity":
        return { key: "vendorGpcCheckUnattributableHelpVendor", substitution: [l.name], ...order(a.checkedBeforeLoad, "row") };
      case "host":
        return { key: "vendorGpcCheckUnattributableHelpVendor", substitution: [l.domain], ...order(a.checkedBeforeLoad, "row") };
      case "site":
        return { key: "vendorGpcCheckUnattributableHelpSite", ...order(a.checkedBeforeLoad, "row") };
    }
  }
  if (f.flag === "vendor-did-not-read-gpc" && (a.kind === "network" || a.kind === "tally") && a.loadedVia && a.loadedVia.length > 0) {
    const first = a.loadedVia[0]!;
    const who = first.kind === "entity" ? first.name : first.kind === "host" ? first.domain : null;
    // "Neither did X" only when the engine judged the vendor by its loader chain and so
    // checked X. A loader named on a vendor whose chain did not resolve was never checked.
    if (who !== null) return { key: a.chainChecked === true ? "vendorGpcNotReadHelpLoader" : "vendorGpcNotReadHelpLoaderUnchecked", substitution: [who] };
  }
  // Shares its label with vendor-did-not-read-gpc, so its page-wide help is chosen here by
  // the flag rather than by `<checkKey>Help`.
  if (f.flag === "vendor-gpc-unread-via-container") return { key: "vendorGpcNotReadViaContainerHelp" };
  return fallback;
}

/**
 * Every loader identity the engine attached to this vendor's finding, deduplicated. The
 * vendor is a company in a category; a finding that names no category (a bundle from before
 * 1.20.0) is the company's, and every one of its rows takes it. With `unlisted`, the vendor
 * is a domain with no company, and only the engine's finding for that domain is read.
 */
function loadersOf(findings: readonly Finding[], name: string, category?: string, unlisted = false): readonly LoaderIdentity[] {
  const out: LoaderIdentity[] = [];
  const seen = new Set<string>();
  for (const f of findings) {
    if (f.entity?.name !== name) continue;
    // A domain with no company is a unit of its own (1.26.0), never a company's.
    if ((f.entity.unlisted === true) !== unlisted) continue;
    if (f.entity.category !== undefined && category !== undefined && f.entity.category !== category) continue;
    for (const l of loadersOnArtifact(f)) {
      const k = JSON.stringify(l);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(l);
    }
  }
  return out;
}

/** Display names for the managers the schema recognizes. Brand names, never translated. */
const MANAGER_NAMES: Readonly<Record<string, string>> = {
  tealium: "Tealium",
  "adobe-launch": "Adobe Launch",
  segment: "Segment",
  matomo: "Matomo Tag Manager",
  "piwik-pro": "Piwik PRO",
  ensighten: "Ensighten",
  "commanders-act": "Commanders Act",
};

/** The fragment naming one container: the manager and its id, then its parent if any. */
function containerParts(id: ContainerIdentity, ancestors: readonly ContainerIdentity[]) {
  const parts: { key: string; substitution?: string[] }[] = [];
  if (id.id === null) parts.push({ key: "vendorLoadedViaTagManager" });
  else if (id.manager === "gtm") parts.push({ key: "vendorLoadedViaGtm", substitution: [id.id] });
  else if (id.manager === "gtag") parts.push({ key: "vendorLoadedViaGoogleTag", substitution: [id.id] });
  else parts.push({ key: "vendorLoadedViaManager", substitution: [MANAGER_NAMES[id.manager] ?? id.manager, id.id] });
  const parent = ancestors[0];
  if (parent && parent.id !== null) parts.push({ key: "vendorLoadedViaParent", substitution: [parent.id] });
  return parts;
}

/**
 * One line per loader identity, for the expanded panel. A site file that also loaded
 * other vendors says so, the one count allowed here, because the count is the reason for
 * the different sentence.
 */
export function loaderLines(loaders: readonly LoaderIdentity[], findings: readonly Finding[], domainRow = false): LoadedViaLine[] {
  // A company that loaded this vendor from two of its categories is two loaders to the
  // engine and one name to a reader.
  const seen = new Set<string>();
  const out: LoadedViaLine[] = [];
  for (const l of loaders) {
    const line = { parts: partsFor(l, findings, domainRow) };
    const key = JSON.stringify(line);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

function partsFor(l: LoaderIdentity, findings: readonly Finding[], domainRow: boolean): { key: string; substitution?: string[] }[] {
  switch (l.kind) {
    case "container":
      return containerParts(l.identity, l.ancestors);
    case "entity":
      return [{ key: "vendorLoadedViaVendor", substitution: [l.name] }];
    case "host":
      return [{ key: "vendorLoadedViaHost", substitution: [l.domain] }];
    case "site": {
      if (l.url === null) return [{ key: "vendorLoadedBySite" }];
      const others = vendorsLoadedByFile(l.url, findings, domainRow);
      if (others === 0) return [{ key: "vendorLoadedBySite" }];
      return others === 1 ? [{ key: "vendorLoadedBySiteScriptOne" }] : [{ key: "vendorLoadedBySiteScript", substitution: [String(others)] }];
    }
  }
}

/**
 * How many OTHER vendors the same first-party file loaded, from every finding's loaders. The
 * vendors are companies: a domain with no company (1.26.0) is never counted, so a company's
 * line counts only other companies, and on a domain's row (`domainRow`) every company
 * counted is another vendor.
 */
function vendorsLoadedByFile(url: string, findings: readonly Finding[], domainRow: boolean): number {
  const names = new Set<string>();
  for (const f of findings) {
    if (!f.entity || f.entity.unlisted === true) continue;
    if (loadersOnArtifact(f).some((l) => l.kind === "site" && l.url === url)) names.add(f.entity.name);
  }
  return domainRow ? names.size : Math.max(0, names.size - 1);
}

/**
 * The row's single line. Any container wins the line, with a second id named when two
 * containers loaded this vendor and an "also by" for a non-container loader beside it;
 * otherwise the first loader, with "also by" for the rest. Undefined when there is no
 * loader, so the row shows nothing rather than a guess.
 */
export function loadedViaRowLine(loaders: readonly LoaderIdentity[], findings: readonly Finding[], domainRow = false): LoadedViaLine | undefined {
  if (loaders.length === 0) return undefined;
  const containers = loaders.filter((l): l is Extract<LoaderIdentity, { kind: "container" }> => l.kind === "container");
  const others = loaders.filter((l) => l.kind !== "container");
  const parts: { key: string; substitution?: string[] }[] = [];
  if (containers.length >= 2 && containers.every((c) => c.identity.id !== null)) {
    parts.push({ key: "vendorLoadedViaContainers", substitution: [containers.map((c) => c.identity.id as string).join(", ")] });
  } else if (containers.length >= 1) {
    parts.push(...containerParts(containers[0]!.identity, containers[0]!.ancestors));
  } else {
    parts.push(...partsFor(others[0]!, findings, domainRow));
  }
  const rest = containers.length >= 1 ? others : others.slice(1);
  // Each loader is named once: two first-party scripts never read "loaded by the site
  // itself, also by eBay, also by the site" (ebay.com, 2026-09-22).
  let siteNamed = containers.length === 0 && others[0]?.kind === "site";
  const named = new Set<string>();
  const first = containers.length === 0 ? others[0] : undefined;
  if (first !== undefined && first.kind !== "site") named.add(first.kind === "entity" ? first.name : first.domain);
  for (const l of rest) {
    if (l.kind === "site") {
      if (siteNamed) continue;
      siteNamed = true;
      parts.push({ key: "vendorLoadedAlsoBySite" });
      continue;
    }
    const who = l.kind === "entity" ? l.name : l.domain;
    if (named.has(who)) continue;
    named.add(who);
    parts.push({ key: "vendorLoadedAlsoByVendor", substitution: [who] });
  }
  return { parts };
}

/**
 * Roll findings up into per-vendor rows.
 *
 * Cookie names are deduped per entity, matching the badge's distinct count so the two can
 * never disagree. A vendor's check status comes from the consent-API calls: a call
 * attributable to a script on one of its domains is "asked"; a call that resolved only
 * into a tag-manager container is "via GTM" and attributes nothing; otherwise there is no
 * attributable check, which is NOT the same as "did not check" and is worded accordingly.
 */
/** How long a cookie lasts, as a message: the unit's key, with the number where it has one. */
export interface CookieExpiry {
  readonly key:
    | "cookieExpirySession"
    | "cookieExpiryUnknown"
    | "cookieExpiryExpired"
    | "cookieExpiryMinutes"
    | "cookieExpiryHours"
    | "cookieExpiryDays"
    | "cookieExpiryMonths"
    | "cookieExpiryYears";
  readonly substitution?: readonly [string];
}

/** A cookie's expiry for display. A duration is more legible than a timestamp. */
export function cookieExpiry(expiresMs: number | "session" | null): CookieExpiry {
  if (expiresMs === "session") return { key: "cookieExpirySession" };
  if (expiresMs === null) return { key: "cookieExpiryUnknown" };
  const ms = expiresMs - Date.now();
  if (ms <= 0) return { key: "cookieExpiryExpired" };
  const n = (count: number): readonly [string] => [String(count)];
  // Under a day, in minutes and then hours. Rounded to days, anything that expires within
  // twelve hours would read "expired": Cloudflare's __cf_bm, which lasts thirty minutes,
  // would be listed under Cookies set as a cookie that had already gone.
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return { key: "cookieExpiryMinutes", substitution: n(Math.max(1, minutes)) };
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return { key: "cookieExpiryHours", substitution: n(hours) };
  const days = Math.round(ms / 86_400_000);
  if (days < 45) return { key: "cookieExpiryDays", substitution: n(days) };
  if (days < 365) return { key: "cookieExpiryMonths", substitution: n(Math.round(days / 30)) };
  const years = days / 365;
  return { key: "cookieExpiryYears", substitution: n(years < 1.5 ? 1 : Math.round(years)) };
}

/** That a cookie was removed again, as a message: how long after it was last set. */
export interface CookieRemoved {
  readonly key: "cookieRemovedAtOnce" | "cookieRemovedAfterSeconds" | "cookieRemovedAfterMinutes" | "cookieRemovedAfterHours";
  readonly substitution?: readonly [string];
}

/**
 * How long after its last set a cookie was removed, for display, from
 * CookieDetail.removedAfterMs. Under a second has no number: a zero would read as "never".
 */
export function cookieRemoved(afterMs: number): CookieRemoved {
  const n = (count: number): readonly [string] => [String(count)];
  const seconds = Math.round(afterMs / 1000);
  if (seconds < 1) return { key: "cookieRemovedAtOnce" };
  if (seconds < 60) return { key: "cookieRemovedAfterSeconds", substitution: n(seconds) };
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return { key: "cookieRemovedAfterMinutes", substitution: n(minutes) };
  return { key: "cookieRemovedAfterHours", substitution: n(Math.round(minutes / 60)) };
}

/** The `removed` field of a panel's cookie, present only for a cookie seen removed. */
export function removedOf(d: Pick<CookieDetail, "removedAfterMs">): { readonly removed?: CookieRemoved } {
  return d.removedAfterMs === undefined ? {} : { removed: cookieRemoved(d.removedAfterMs) };
}

/**
 * Whether a cookie set for `domain` goes on a request to one of `hosts`, by the browser's
 * rule: to the domain's own host and every host under it. The capture records only the
 * NAMES a request's Cookie header carried, so a name seen going back marks each of the
 * vendor's cookies of that name that could have gone, and never one on another site's
 * domain, such as a cookie a vendor's script wrote on the page's own site.
 */
export function sentToAnyHost(domain: string, hosts: readonly string[]): boolean {
  const d = domain.toLowerCase().replace(/^\./, "");
  return d !== "" && hosts.some((h) => h === d || h.endsWith(`.${d}`));
}

/** The words for how a cookie was set, the same in every panel that lists cookies. */
export type CookieViaKey = "cookieViaHeader" | "cookieViaScript";

/** How a cookie was set: written by a page script, or by a response's Set-Cookie header. */
export function cookieViaKey(via: CaptureMethod): CookieViaKey {
  return via === "documentCookie" || via === "cookieStore" ? "cookieViaScript" : "cookieViaHeader";
}

const signedKeyIndex = new WeakMap<Tallies, ReadonlySet<string>>();

/**
 * Whether a panel's cookie was set on a request without the signal, while the signal was on
 * (1.26.0): a key no record holds as set on a signed request. The signed records are the
 * counted keys, the first-party keys a vendor's script wrote (kept on signed requests only),
 * built once per tallies, and the row's own summary's. A capture with no tallies records a
 * signed set for no key, so none is marked; nor with sending off, where every cookie is
 * unsigned.
 */
function unsignedTest(obs: ObservationSet, summarySigned: readonly string[]): (key: string) => boolean {
  const t = obs.tallies;
  if (obs.signal.source === "none" || !isTallied(t)) return () => false;
  let signed = signedKeyIndex.get(t);
  if (signed === undefined) {
    signed = new Set([...t.adCookieKeys, ...t.firstPartyVendorCookieKeys]);
    signedKeyIndex.set(t, signed);
  }
  const global = signed;
  const own = new Set(summarySigned);
  return (key) => !global.has(key) && !own.has(key);
}

/**
 * Whether a key is known only from a response whose request was lost (1.26.0), one rule for
 * every panel: its detail says so, and a set on an observed request, under any row, cleared
 * that. With no detail (the first party's keys take none), whether a summary listed it as
 * lost and no observed list of the same summary holds it.
 */
function isLostKey(d: CookieDetail | null | undefined, listedLost: boolean): boolean {
  return d === null || d === undefined ? listedLost : d.requestLost === true;
}

/**
 * Build the expanded detail for one entity.
 *
 * Everything here is an artifact: hostnames seen, requests made, cookies with the
 * attributes that change what they can do, and where the entity rollup came from. The last
 * of those matters because most "your tool is wrong" reports are really "your list is
 * wrong", and naming the source turns an argument with us into an edit against a
 * dated third-party list.
 */
/**
 * Whether a URL is a row's: the panel is the ROW's, a company's requests, cookies and calls
 * from the domains of one category. The list's answer: third party, this company, this
 * category. A row with no category is the whole company.
 */
function rowScriptTest(entityName: string, category: string | undefined, input: BuildInput): (url: string) => boolean {
  return (url) => {
    const cls = input.classify?.(url);
    if (cls === undefined || cls.entity !== entityName) return false;
    return category === undefined || (cls.party === "third" && cls.category === category);
  };
}

/** Whether a URL is a domain row's, by the list's own answer: third party, no company, this registrable domain. */
function domainScriptTest(domain: string, obs: ObservationSet, input: BuildInput): (url: string) => boolean {
  return (url) => {
    const cls = classOf(url, obs, input);
    return cls.party === "third" && cls.entity === null && cls.domain === domain;
  };
}

function vendorDetail(
  entityName: string,
  category: string | undefined,
  obs: ObservationSet,
  input: BuildInput,
  // A counted domain with no company is the domain's scripts, not a company's.
  mine: (url: string) => boolean = rowScriptTest(entityName, category, input),
): Omit<VendorDetail, "loadedVia"> {
  // Counts, hostnames, resource types, and since 1.22.0 the cookies and their attributes,
  // all come from the tallies (complete, and derived from the requests for an older bundle
  // by withPersistedShape), so the panel is the same after a worker reclaim. The request
  // list is not read here.
  const summary = category === undefined ? undefined : obs.tallies.byEntityCategory?.[entityCategoryKey(entityName, category)];
  // Whether the headline counts this row's cookies, which is when one can be labeled.
  const counted = category === undefined || COUNTING_CATEGORIES.has(category);
  // A capture from before the summaries has one tally for the company. Its hostnames are
  // narrowed to this row's where the list can say; its counts are the company's.
  const whole = summary === undefined ? obs.tallies.byEntity[entityName] : undefined;
  const tallied = summary ?? whole;
  const hosts = summary?.hosts ?? (whole?.hosts ?? []).filter((h) => category === undefined || input.classify === undefined || mine(`https://${h}/`));
  const domains = new Set<string>(hosts);
  const cookies: VendorCookie[] = [];
  const seenCookies = new Set<string>();
  const requestCount = tallied?.requests ?? 0;
  const signedRequestCount = tallied?.signedRequests ?? 0;
  const resourceTypes = new Set<string>(tallied?.resourceTypes ?? []);
  const unsignedOf = unsignedTest(obs, summary?.cookieKeys ?? []);
  // The functional-cookie note says the cookie is "still included in the count", so it goes
  // only on a key the headline counts: the signed keys with the signal on, the unsigned ones
  // with it off. Not on a key set without the signal while it was on, nor on a first-party
  // key a vendor's script wrote. A capture with no tallies has no such record, and takes the
  // simpler rule: counted, and not lost.
  const headline = isTallied(obs.tallies)
    ? new Set(obs.signal.source === "none" ? (obs.tallies.adCookieKeysUnsigned ?? []) : obs.tallies.adCookieKeys)
    : undefined;

  const addCookie = (key: string, d: CookieDetail | null, listedLost = false): void => {
    if (seenCookies.has(key)) return;
    seenCookies.add(key);
    // Known only from a lost request (a capture with no tallies has only the detail).
    const lost = isLostKey(d, listedLost);
    const cut = key.indexOf("\u0000");
    const name = key.slice(0, cut);
    const base = {
      sentBack: (tallied?.cookiesReturned ?? []).includes(name) && sentToAnyHost(key.slice(cut + 1), hosts),
      name,
      domain: key.slice(cut + 1),
      functional: counted && !lost && (headline === undefined || headline.has(key)) && input.isListedFunctional?.(name) === true,
      ...(lost ? { requestLost: true as const } : unsignedOf(key) ? { unsigned: true as const } : {}),
    };
    cookies.push(
      d === null
        ? { ...base, partitioned: false, onRedirect: false }
        : {
            ...base,
            expiry: cookieExpiry(d.expiresMs),
            sameSite: d.sameSite,
            partitioned: d.partitioned,
            viaKey: cookieViaKey(d.via),
            onRedirect: d.onRedirect,
            ...removedOf(d),
          },
    );
  };

  // The row's own cookie keys, the ones its names and the headline are built from, each
  // with its details; a key past the cap on details is listed by name alone.
  const details = obs.tallies.cookieDetails ?? {};
  for (const key of rowCookieKeys(obs, entityName, category, summary, mine, input.owners ?? NO_OWNERS)) addCookie(key, details[key] ?? null);
  // The keys known only from a response whose request was lost (1.26.0), after the rest: a
  // key also set on an observed request is listed where that set was, as that set.
  for (const key of [...(summary?.cookieKeysRequestLost ?? [])].sort()) {
    if (isLostKey(details[key], true)) addCookie(key, details[key] ?? null, true);
  }

  const byApi = new Map<string, number>();
  for (const call of obs.consentApiCalls) {
    if (call.callerScriptUrl === null || call.viaTagManager) continue;
    if (!mine(call.callerScriptUrl)) continue;
    byApi.set(call.api, (byApi.get(call.api) ?? 0) + callCount(call));
  }

  // Reads attributed to this row's own scripts. Same resolution the consent calls above
  // use, so the two halves of "did this vendor check" are counted the same way.
  let signalReads = 0;
  for (const [scriptUrl, count] of Object.entries(obs.signal.readsByScript)) {
    if (!mine(scriptUrl)) continue;
    signalReads += count;
  }

  return {
    domains: [...domains].sort(),
    requestCount,
    signedRequestCount,
    resourceTypes: [...resourceTypes].sort(),
    cookies,
    consentCalls: [...byApi].map(([api, count]) => ({ api, count })),
    signalReads,
    probeCookies: summary?.probeCookies ?? obs.tallies.probeCookies?.[entityName] ?? [],
    refusedWrites: summary?.refusedWrites ?? obs.tallies.refusedCookieWrites?.[entityName] ?? [],
    ...(summary?.requestLostCapped === true ? { cookiesCapped: true } : {}),
  };
}

const rowKeyIndex = new WeakMap<Tallies, Map<string, string[]>>();

/**
 * The counted keys by the company that set them, and by company and category, sorted.
 * Built once per tallies rather than filtered once per vendor row.
 */
function countedKeysByRow(t: Tallies): Map<string, string[]> {
  const known = rowKeyIndex.get(t);
  if (known !== undefined) return known;
  const out = new Map<string, string[]>();
  const add = (row: string, key: string): void => void out.set(row, [...(out.get(row) ?? []), key]);
  for (const key of new Set([...t.adCookieKeys, ...(t.adCookieKeysUnsigned ?? [])])) {
    const entity = t.adCookieEntities?.[key];
    if (entity === undefined) continue;
    add(entity, key);
    const category = t.adCookieCategories?.[key];
    if (category !== undefined) add(entityCategoryKey(entity, category), key);
  }
  for (const keys of out.values()) keys.sort();
  rowKeyIndex.set(t, out);
  return out;
}

/**
 * The cookie keys a vendor row lists: the same keys its names and the headline come from,
 * so the panel never disagrees with the row above it.
 *
 *   a category that does not count   the summary's own keys (1.20.0)
 *   a counting category, or none     the counted keys the tallies give this company (1.19.0),
 *                                    in this category when the row has one
 *   before 1.19.0                    the counted keys carrying the company's cookie names
 *   no tallies at all                the details whose host is this row's: nothing else
 *                                    says who set what
 *
 * Plus, for a counting row, the first-party cookies a vendor's script wrote: the tallies
 * keep those keys with no vendor, so the host that wrote each one says whose it is.
 */
function rowCookieKeys(
  obs: ObservationSet,
  entityName: string,
  category: string | undefined,
  summary: EntityCategoryTally | undefined,
  mine: (url: string) => boolean,
  owners: OwnerNames,
): string[] {
  const t = obs.tallies;
  if (!isTallied(t)) {
    // A key written inside a container is its owner's by the owner's list, and nobody's
    // otherwise (1.25.0): the host is the container's, not a company's.
    return Object.entries(t.cookieDetails ?? {})
      .filter(([key, d]) => {
        if (d.container === undefined) return d.host !== "" && mine(`https://${d.host}/`);
        const own = owners.match(d.container.slice(0, d.container.indexOf(":")) as TagManagerKind, key.slice(0, key.indexOf("\u0000")));
        return own !== null && own.entity.name === entityName && (category === undefined || own.category === category);
      })
      .map(([key]) => key);
  }
  if (category !== undefined && !COUNTING_CATEGORIES.has(category)) {
    return [...new Set([...(summary?.cookieKeys ?? []), ...(summary?.cookieKeysUnsigned ?? [])])].sort();
  }
  const written = t.firstPartyVendorCookieKeys.filter((key) => {
    const host = t.cookieDetails?.[key]?.host ?? "";
    return host !== "" && mine(`https://${host}/`);
  });
  if (t.adCookieEntities !== undefined) {
    const own = countedKeysByRow(t).get(category === undefined ? entityName : entityCategoryKey(entityName, category)) ?? [];
    return written.length === 0 ? own : [...new Set([...own, ...written])].sort();
  }
  const entity = t.byEntity[entityName];
  const names = new Set([...(entity?.cookieNames ?? []), ...(entity?.cookieNamesUnsigned ?? [])]);
  const named = [...t.adCookieKeys, ...(t.adCookieKeysUnsigned ?? [])].filter((key) => names.has(key.slice(0, key.indexOf("\u0000"))));
  return [...new Set([...named, ...written])].sort();
}

/** Maps each vendor-signal-check flag to its display key — see VendorRow.checkKey. */
const VENDOR_SIGNAL_FLAG_TO_KEY: Readonly<Record<string, VendorRow["checkKey"]>> = {
  "vendor-read-gpc": "vendorGpcRead",
  "vendor-did-not-read-gpc": "vendorGpcNotRead",
  "vendor-no-script-observed": "vendorGpcNotApplicable",
  "vendor-gpc-unread-via-container": "vendorGpcNotRead",
  "vendor-gpc-check-unattributable": "vendorGpcCheckUnattributable",
};

/**
 * The GPC-signal / GPP-string disagreement, in the popup's own terms.
 *
 * Mirrors engine rules/gpc-vs-gpp.ts exactly, including requiring BOTH sent-surfaces to
 * agree before calling it sent. The engine owns the finding; this exists so the expanded
 * GPP row can carry the same line without waiting on a finding to be threaded down to it,
 * and the two must never diverge — if the rule's condition changes, change this with it.
 */
function gpcVsGppState(obs: ObservationSet): "sent-field-no" | "not-sent-field-yes" | null {
  const gpp = obs.gpp;
  if (!gpp || gpp.unparseable) return null;
  // The engine's primary section: the one the row displays and the rule reads.
  const field = primaryGppSection(gpp.sections)?.[1]["Gpc"];
  if (field !== 0 && field !== 1) return null;

  const sent = obs.signal.propertyValue === true && obs.signal.secGpcRequestCount > 0;
  const notSent = obs.signal.propertyValue !== true && obs.signal.secGpcRequestCount === 0;
  if (sent && field === 0) return "sent-field-no";
  if (notSent && field === 1) return "not-sent-field-yes";
  return null;
}

/**
 * What the site's GPP string says about GPC — as three answers, not two.
 *
 *   "records"     a decoded section carries Gpc = 1: the site's tool says it saw the signal
 *   "silent"      we decoded a string and it records no GPC choice
 *   "no-string"   nothing decodable arrived, so there is nothing to report either way
 *
 * The third is separate on purpose. Collapsing it into "silent" would let the popup tell a
 * reader that a vendor "asked and was not told" on the strength of a string we never saw —
 * an absence of data reported as a fact, which is the failure this whole product is built
 * around avoiding.
 *
 * The Gpc = 1 test is gated to us-state sections, as primaryGppSection is: only those
 * can carry the field, so a TCF section's silence is not a statement about GPC.
 */
export type GppGpcRecord = "records" | "silent" | "no-string";

export function gppGpcRecord(gpp: GppObservation | null): GppGpcRecord {
  if (!gpp || gpp.unparseable) return "no-string";
  if (Object.keys(gpp.sections).length === 0) return "no-string";
  const records = Object.entries(gpp.sections).some(
    ([name, fields]) => gppSectionKind(name) === "us-state" && fields["Gpc"] === 1,
  );
  return records ? "records" : "silent";
}

/**
 * Whether a GPP call on this page read the reader's GPC choice: the string records a GPC
 * value. Gpc = 1 does; a string silent on GPC does too with the signal off, since it then
 * told the caller exactly what was true. With the signal on, a silent string told it nothing
 * of the choice, and with no decodable string what it was told is unknown. One rule for the
 * vendor rows, the Overview's Read GPC lines and the container rows.
 */
export function gppCallReads(record: GppGpcRecord, signalOn: boolean): boolean {
  return record === "records" || (record === "silent" && !signalOn);
}

/**
 * The vendor-signal-check finding for a row: a company in a category. By engine contract
 * there is one per company and category. A finding that names no category is from a bundle
 * recorded before the engine judged per category, and is the company's: each of its rows
 * takes it. A row that names none takes whichever the company has.
 *
 * `vendor-read-gpc` splits four ways in `checkKeyOf`, because "this vendor checked" is one
 * engine state covering two mechanisms, and one of them depends on what came back:
 *
 *   - a direct property read              -> vendorGpcReadProperty
 *   - a GPP call, string recorded GPC     -> vendorGpcRead
 *   - a GPP call, string recorded none    -> vendorGpcAskedNoGpcField
 *   - a GPP call, no string captured      -> vendorGpcAskedNoResponse
 *
 * The last two exist because saying a GPP call's response carried the reader's GPC choice
 * is only true when the string it returned recorded one. On a page whose string says
 * `Gpc: 0` the vendor asked and was told no: a fact about the SITE's string, not about the
 * vendor, so the help text sends the reader to the GPP row rather than leaving an
 * overstatement on the vendor. And where no string was captured at all, neither claim is
 * available and the copy says only what was seen: it asked.
 */
function checkFindingFor(findings: readonly Finding[], name: string, category: string | undefined): Finding | undefined {
  // Last first: among equals the last one wins.
  const mine = findings.filter((f) => f.entity?.name === name && f.entity.unlisted !== true && f.flag in VENDOR_SIGNAL_FLAG_TO_KEY).reverse();
  return (
    mine.find((f) => f.entity?.category === category) ??
    mine.find((f) => f.entity?.category === undefined) ??
    (category === undefined ? mine[0] : undefined)
  );
}

/**
 * The help a domain row shows (1.26.0): the vendor row's, except where that names a vendor.
 * A company row says "this vendor" and a domain row "this domain"; a sentence about what a
 * container loaded says "this tag" on either, so it has no entry here. The order sentence
 * appended after a vendor, host or site loader names the row too.
 */
const DOMAIN_HELP: Readonly<Record<string, string>> = {
  vendorGpcReadHelp: "vendorGpcReadHelpDomain",
  vendorGpcReadHelpSignalOff: "vendorGpcReadHelpSignalOffDomain",
  vendorGpcReadPropertyHelp: "vendorGpcReadPropertyHelpDomain",
  vendorGpcAskedNoGpcFieldHelp: "vendorGpcAskedNoGpcFieldHelpDomain",
  vendorGpcAskedNoResponseHelp: "vendorGpcAskedNoResponseHelpDomain",
  vendorGpcNotReadHelp: "vendorGpcNotReadHelpDomain",
  vendorGpcNotReadHelpLoader: "vendorGpcNotReadHelpLoaderDomain",
  vendorGpcNotReadHelpLoaderUnchecked: "vendorGpcNotReadHelpLoaderUncheckedDomain",
  vendorGpcNotReadHelpCapped: "vendorGpcNotReadHelpCappedDomain",
  vendorGpcNotReadHelpUnidentified: "vendorGpcNotReadHelpUnidentifiedDomain",
  vendorGpcNotReadViaContainerHelp: "vendorGpcNotReadViaContainerHelpDomain",
  vendorGpcCheckUnattributableHelp: "vendorGpcCheckUnattributableHelpDomain",
  vendorGpcCheckUnattributableHelpVendor: "vendorGpcCheckUnattributableHelpVendorDomain",
  vendorGpcCheckUnattributableHelpSite: "vendorGpcCheckUnattributableHelpSiteDomain",
  vendorGpcCheckUntracedHelp: "vendorGpcCheckUntracedHelpDomain",
  vendorGpcNotApplicableHelp: "vendorGpcNotApplicableHelpDomain",
  vendorGpcCheckUnavailableHelp: "vendorGpcCheckUnavailableHelpDomain",
};
const DOMAIN_ORDER: Readonly<Record<string, string>> = {
  vendorGpcCheckOrderBeforeVendor: "vendorGpcCheckOrderBeforeDomain",
  vendorGpcCheckOrderAfterVendor: "vendorGpcCheckOrderAfterDomain",
};
function domainHelp(help: VendorRow["checkHelp"], u?: UnlistedDomainTally): VendorRow["checkHelp"] {
  // Nothing was judged because the extension's own cap left the domain's requests out: a
  // refresh meets the same cap, so the sentence says so rather than asking for one.
  if (help.key === "vendorGpcCheckUnavailableHelp" && u?.requestsCapped === true) return { key: "vendorGpcCheckUnavailableHelpDomainCapped" };
  const key = DOMAIN_HELP[help.key] ?? help.key;
  const orderKey = help.orderKey === undefined ? undefined : (DOMAIN_ORDER[help.orderKey] ?? help.orderKey);
  return { ...help, key, ...(orderKey !== undefined ? { orderKey } : {}) };
}

/**
 * The line of a row with no cookie names (see VendorRow.emptyKey): when every cookie its panel
 * lists is known only from a lost request, it says so, before a probe does; when every one is
 * unsigned or lost, in any mix, "cookies set, request without GPC"; a probe next; else "no
 * cookies set".
 */
function emptyKeyOf(detail: VendorDetail, probed: boolean): Pick<VendorRow, "emptyKey"> {
  if (detail.cookies.length > 0 && detail.cookies.every((c) => c.requestLost === true)) return { emptyKey: "vendorCookiesRequestLost" };
  // Set only on requests without the signal while it was on, or on lost ones beside them:
  // the row lists the signed ones, and "no cookies set" would deny what the panel lists.
  if (detail.cookies.length > 0 && detail.cookies.every((c) => c.unsigned === true || c.requestLost === true)) {
    return { emptyKey: "vendorCookiesWithoutGpc" };
  }
  return probed ? { emptyKey: "vendorCookiesSetAndRemoved" } : {};
}

/** The engine's vendor-signal-check finding for a domain with no company (1.26.0). */
function domainFindingFor(findings: readonly Finding[], domain: string): Finding | undefined {
  return findings.find((f) => f.entity?.unlisted === true && f.entity.name === domain && f.flag in VENDOR_SIGNAL_FLAG_TO_KEY);
}

function checkKeyOf(f: Finding | undefined, gpp: GppObservation | null, signalOn: boolean): VendorRow["checkKey"] | undefined {
  if (f === undefined) return undefined;
  const key = VENDOR_SIGNAL_FLAG_TO_KEY[f.flag];
  if (key === undefined || f.flag !== "vendor-read-gpc") return key;
  if (f.artifact.kind === "signal-read") return "vendorGpcReadProperty";
  const record = gppGpcRecord(gpp);
  // "Asked, not told" only exists while the signal is on. With sending off, a string whose
  // GPC field is 0 told the vendor exactly what was true.
  if (gppCallReads(record, signalOn)) return "vendorGpcRead";
  // A call that was not told leaves a direct read of the property standing (1.36.0).
  if (f.artifact.kind === "consent-api" && (f.artifact.readCount ?? 0) > 0) return "vendorGpcReadProperty";
  return record === "silent" ? "vendorGpcAskedNoGpcField" : "vendorGpcAskedNoResponse";
}

/**
 * USP secondary line for a vendor known to have called __uspapi attributably: what the API
 * answered. The cookie and the requests' value are the site's string by other routes, not
 * what the call returned, so with no API answer the line is omitted rather than guessed.
 */
function uspSecondaryLine(usp: UsPrivacyObservation | null): VendorRow["usp"] {
  const raw = usp?.fromApi ?? null;
  if (raw === null) return undefined;
  return { valueKey: uspOptOutValueKey(raw) };
}

/** The __tcfapi commands whose answer carries the TC data. A ping only says a tool exists. */
const TCF_DATA_COMMANDS: ReadonlySet<string> = new Set(["getTCData", "addEventListener"]);

/** Whether a script of the row's (`mine`) called __tcfapi for its data, attributably. */
function readTcfData(obs: ObservationSet, mine: (url: string) => boolean): boolean {
  return obs.consentApiCalls.some(
    (c) => c.api === "__tcfapi" && c.command !== null && TCF_DATA_COMMANDS.has(c.command) && c.callerScriptUrl !== null && !c.viaTagManager && mine(c.callerScriptUrl),
  );
}

/** TCF secondary line for a vendor known to have read the TC data attributably. */
function tcfSecondaryLine(tcf: TcfObservation | null): VendorRow["tcf"] {
  if (tcf === null || tcf.tcString === "") return undefined;
  const entries = Object.entries(tcf.purposeConsents);
  if (entries.length === 0) return { key: "vendorTcfNoPurposes" };
  const granted = entries.filter(([, g]) => g).length;
  if (granted === 0) return { key: "vendorTcfNoneGranted" };
  return { key: "vendorTcfChecked", substitution: [`${granted}/${entries.length}`] };
}

/**
 * A cookie as a row or a panel shows it: its name, and its domain where another cookie in
 * `all` has that name. Two cookies of one name set for two domains, or one host-only and
 * one for the domain (`b.vendor.example` against `.vendor.example`), are different cookies
 * with their own attributes, and each line must say which it is. The rows, the panels and
 * the summary all write names by it.
 */
export function shownName(c: { readonly name: string; readonly domain: string }, all: readonly { readonly name: string }[]): string {
  return all.filter((o) => o.name === c.name).length > 1 ? `${c.name} (${c.domain})` : c.name;
}

/**
 * Names as a row shows them: one per key, the domain added where one name has two among
 * `among` (the keys themselves unless given).
 */
function shownNames(keys: readonly string[], among: readonly string[] = keys): string[] {
  const split = (key: string) => {
    const cut = key.indexOf("\u0000");
    return { name: key.slice(0, cut), domain: key.slice(cut + 1) };
  };
  const all = among.map(split);
  return [...new Set(keys.map((key) => shownName(split(key), all)))].sort();
}

/**
 * See PopupView.firstParty. Each key is listed once: under a third party the count
 * includes it for, else under the site's script that wrote it, else as the site's.
 */
function firstPartyOf(obs: ObservationSet, input: BuildInput): PopupView["firstParty"] {
  const t = obs.tallies;
  const f = t.firstParty;
  if (f === undefined) return undefined;
  const counted = new Set([...t.adCookieKeys, ...(t.adCookieKeysUnsigned ?? [])]);
  const vendorKeys = [...new Set([...t.firstPartyVendorCookieKeys, ...f.vendorCookieKeysUnsigned])].filter((key) => !counted.has(key));
  const written = new Set(vendorKeys);
  const observedSiteKeys = [...new Set([...f.cookieKeys, ...f.cookieKeysUnsigned])].filter((key) => !counted.has(key) && !written.has(key));
  // A key known only from a lost request came on a response, and joins the second list (1.26.0).
  const listed = new Set([...observedSiteKeys, ...written]);
  const details = t.cookieDetails ?? {};
  const lostKeys = [...new Set(f.cookieKeysRequestLost ?? [])].filter((key) => !counted.has(key) && isLostKey(details[key], !listed.has(key)));
  const siteKeys = [...observedSiteKeys, ...lostKeys];
  const probeCookies = [...(f.probeCookies ?? [])].sort();
  if (vendorKeys.length === 0 && siteKeys.length === 0 && probeCookies.length === 0) return undefined;
  const all = [...vendorKeys, ...siteKeys];
  // Marked as a panel marks them: set only on requests without the signal, while it was on,
  // or known only from a lost request, whose signal was not observed.
  const signed = new Set([...t.firstPartyVendorCookieKeys, ...f.cookieKeys]);
  const lost = new Set(lostKeys);
  const unsigned = obs.signal.source !== "none" ? all.filter((key) => !signed.has(key) && !lost.has(key)) : [];
  // The signed vendor-written keys are not capped, and one flag covers both unsigned lists:
  // the one holding FIRST_PARTY_COOKIE_CAP keys is the one that was full.
  const vendorCapped = f.cappedUnsigned === true && f.vendorCookieKeysUnsigned.length >= FIRST_PARTY_COOKIE_CAP;
  const siteCapped =
    f.capped === true ||
    f.requestLostCapped === true ||
    (f.cappedUnsigned === true && (f.cookieKeysUnsigned.length >= FIRST_PARTY_COOKIE_CAP || !vendorCapped));
  return {
    domain: classOf(`https://${obs.context.topSite}/`, obs, input).domain,
    vendorWritten: shownNames(vendorKeys, all),
    site: shownNames(siteKeys, all),
    unsigned: shownNames(unsigned, all),
    requestLost: shownNames(lostKeys, all),
    // Either interceptor failing is a gap in script writes, as the incomplete notice reads it.
    scriptWritesObserved: obs.capabilities.documentCookie && capabilitiesAsRead(obs).cookieStore,
    probeCookies,
    vendorCapped,
    siteCapped,
  };
}

/**
 * The names on the First party row, as a vendor row lists its cookies: both lists, each name
 * once, in their order. The marks stay in the panel. Empty when only probes were seen.
 */
export function firstPartyRowNames(fp: NonNullable<PopupView["firstParty"]>): readonly string[] {
  return [...new Set([...fp.vendorWritten, ...fp.site])];
}

/**
 * The mark after a name in the First party lists, as a panel's cookie line marks it
 * (1.26.0): set only on requests without the signal while it was on, or known only from a
 * lost request. null for an unmarked name. The popup and the summary both read it.
 */
export function firstPartyMarkKey(
  fp: NonNullable<PopupView["firstParty"]>,
  name: string,
): "vdetailCookieUnsigned" | "requestLost" | null {
  if (fp.unsigned.includes(name)) return "vdetailCookieUnsigned";
  return fp.requestLost.includes(name) ? "requestLost" : null;
}

/**
 * The panel of a domain the list names no company for (1.26.0), from its own summary, so
 * it is the same after a worker reclaim. The calls and reads are those of scripts from the
 * domain, by the list's own answer: third party, no company, this registrable domain.
 */
function unlistedDetail(u: UnlistedDomainTally, obs: ObservationSet, input: BuildInput): Omit<VendorDetail, "loadedVia"> {
  const mine = domainScriptTest(u.domain, obs, input);
  const details = obs.tallies.cookieDetails ?? {};
  // The signed and unsigned keys together, as every panel lists them, the unsigned marked.
  // With the signal off, the unsigned ones alone, as the row (unlistedDomainHasRow): one set
  // on a request that carried the signal was sent before it was switched off, and listed
  // here it would sit under a row that says no cookies were set.
  const unsignedOf = unsignedTest(obs, u.cookieKeys);
  const signalOn = obs.signal.source !== "none";
  // And the keys known only from a response whose request was lost (1.26.0), marked.
  const observed = new Set([...(signalOn ? u.cookieKeys : []), ...u.cookieKeysUnsigned]);
  const lostKeys = (u.cookieKeysRequestLost ?? []).filter((key) => isLostKey(details[key], !observed.has(key)));
  const cookies: VendorCookie[] = [...new Set([...observed, ...lostKeys])].sort().map((key) => {
    const cut = key.indexOf("\u0000");
    const name = key.slice(0, cut);
    const lost = isLostKey(details[key], !observed.has(key));
    const base = {
      sentBack: u.cookiesReturned.includes(name) && sentToAnyHost(key.slice(cut + 1), u.hosts),
      name,
      domain: key.slice(cut + 1),
      functional: false,
      ...(lost ? { requestLost: true as const } : unsignedOf(key) ? { unsigned: true as const } : {}),
    };
    const d = details[key];
    return d === undefined
      ? { ...base, partitioned: false, onRedirect: false }
      : {
          ...base,
          expiry: cookieExpiry(d.expiresMs),
          sameSite: d.sameSite,
          partitioned: d.partitioned,
          viaKey: cookieViaKey(d.via),
          onRedirect: d.onRedirect,
          ...removedOf(d),
        };
  });
  const byApi = new Map<string, number>();
  for (const call of obs.consentApiCalls) {
    if (call.callerScriptUrl === null || call.viaTagManager || !mine(call.callerScriptUrl)) continue;
    byApi.set(call.api, (byApi.get(call.api) ?? 0) + callCount(call));
  }
  let signalReads = 0;
  for (const [scriptUrl, count] of Object.entries(obs.signal.readsByScript)) if (mine(scriptUrl)) signalReads += count;
  return {
    domains: [...u.hosts].sort(),
    requestCount: u.requests,
    signedRequestCount: u.signedRequests,
    resourceTypes: [...u.resourceTypes],
    cookies,
    consentCalls: [...byApi].map(([api, count]) => ({ api, count })),
    signalReads,
    probeCookies: u.probeCookies,
    refusedWrites: u.refusedWrites,
    unlistedDomain: true,
    ...(u.capped === true || u.requestLostCapped === true ? { cookiesCapped: true } : {}),
  };
}

/** A row's key: the company and its category, which is none for a capture that cannot say. */
function rowKeyOf(name: string, category: string | undefined): string {
  return entityCategoryKey(name, category ?? "");
}

/**
 * What the list says of a URL, or the little a URL says of itself when there is no list:
 * its registrable domain, by the same Public Suffix List the classifier uses.
 */
function classOf(url: string, obs: ObservationSet, input: BuildInput): UrlClass {
  const cls = input.classify?.(url);
  if (cls !== undefined) return cls;
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* an unparseable URL has no host, and is nobody's */
  }
  const domain = registrableDomain(host);
  const first = domain !== "" && domain === registrableDomain(obs.context.topSite);
  return { party: first ? "first" : "third", category: "unknown", entity: null, domain: domain === "" ? url : domain };
}

/**
 * Vendors present on the page, with what each of them set. One row for each company and
 * category (see VendorRow).
 *
 * Built from REQUESTS, not from cookie findings. Derived from findings, the list would leave
 * out a vendor that set no cookie, so news-g.example would show "No ad or analytics vendors
 * seen" directly above "87 requests to advertising domains", two statements contradicting
 * each other on one screen.
 *
 * Presence and behavior are different facts. A vendor being on the page is worth reporting
 * whether or not it set anything, and "contacted, set nothing" is a meaningfully different
 * observation from "not here" — arguably the more interesting one, since it is what a
 * vendor honoring the signal looks like.
 */
function vendorRows(findings: readonly Finding[], input: BuildInput): VendorRow[] {
  interface Draft {
    readonly name: string;
    readonly category: string | undefined;
    /** Cookies by key, so one name on two domains is told apart. */
    readonly keyed: { name: string; domain: string }[];
    /** Cookies known by name alone: a capture from before the keys named their vendor. */
    readonly named: Set<string>;
    unlisted: boolean;
  }
  const drafts = new Map<string, Draft>();
  const draftOf = (name: string, category: string | undefined): Draft => {
    const key = rowKeyOf(name, category);
    const draft = drafts.get(key) ?? { name, category, keyed: [], named: new Set<string>(), unlisted: false };
    drafts.set(key, draft);
    return draft;
  };
  /** The company's rows so far, in the list's order. */
  const draftsOf = (name: string): Draft[] =>
    [...drafts.values()]
      .filter((d) => d.name === name)
      .sort((a, b) => categoryRank(a.category ?? "advertising") - categoryRank(b.category ?? "advertising"));
  const addKey = (draft: Draft, key: string): void => {
    const [name = "", domain = ""] = key.split("\u0000");
    draft.keyed.push({ name, domain });
  };

  // Every vendor contacted, from the TALLIES rather than the retained sample. A vendor
  // whose requests were all evicted would otherwise disappear from a list that is supposed
  // to say who was on the page.
  // With sending off, a vendor's cookies are the ones set on unsigned requests: the
  // headline reports that count, and the rows under it have to be the same visit.
  const obs = input.observations;
  const tallied = obs !== null && isTallied(obs.tallies);
  if (obs !== null) {
    const signalOn = obs.signal.source !== "none";
    const t = obs.tallies;
    const owners = t.adCookieEntities;
    const summaries = t.byEntityCategory;

    // The summaries name every row (1.20.0), in every category.
    for (const p of Object.values(summaries ?? {})) {
      const draft = draftOf(p.entity, p.category);
      // Cookies the headline does not count are kept by the summary. The counted ones are
      // the headline's own keys, below.
      if (!COUNTING_CATEGORIES.has(p.category)) {
        for (const key of signalOn ? p.cookieKeys : p.cookieKeysUnsigned) addKey(draft, key);
      }
    }

    // The cookies under each vendor are the headline's own keys, each under the vendor that
    // set it (1.19.0) in the category it was set from (1.17.0). Rebuilt from name lists and
    // findings, they drift from the number: on sports-a.example Braze's ab._gd probe was out of
    // the count and still listed, five counted under six names (2026-09-23). A key with no
    // named vendor goes under its domain, so the count never has a cookie the list does
    // not show.
    if (owners !== undefined) {
      for (const key of signalOn ? t.adCookieKeys : (t.adCookieKeysUnsigned ?? [])) {
        const category = t.adCookieCategories?.[key];
        const owner = owners[key];
        if (owner === undefined) {
          // By registrable domain, as the engine judges and names a domain: a host-only
          // cookie's domain is a subdomain, and two of them are one row.
          const domain = registrableDomain((key.split("\u0000")[1] ?? "").replace(/^\./, ""));
          const draft = draftOf(domain, category);
          draft.unlisted = true;
          addKey(draft, key);
        } else {
          addKey(draftOf(owner, category), key);
        }
      }
    }

    // A capture from before the summaries names companies, not rows. Each company gets a
    // row for every category the list gives its hostnames, beside the ones its cookies gave
    // it above, and one row with no category when neither says.
    if (summaries === undefined) {
      for (const [name, entity] of Object.entries(t.byEntity)) {
        for (const host of entity.hosts) {
          const cls = input.classify?.(`https://${host}/`);
          if (cls !== undefined && cls.party === "third" && cls.entity === name) draftOf(name, cls.category);
        }
        const mine = draftsOf(name);
        // Where the list gave it a category, a row with none is the same cookies without
        // their label, and they go under the first of the rows that have one.
        const bare = mine.find((d) => d.category === undefined);
        const first = mine.find((d) => d.category !== undefined);
        if (bare !== undefined && first !== undefined) {
          first.keyed.push(...bare.keyed);
          drafts.delete(rowKeyOf(name, undefined));
        }
        const row = first ?? bare ?? draftOf(name, undefined);
        if (owners === undefined) {
          for (const n of signalOn ? entity.cookieNames : (entity.cookieNamesUnsigned ?? [])) row.named.add(n);
        }
      }
    }
  }

  // A capture from before the tallies has only its findings to name cookies from, the same
  // retained requests its headline was counted from. With tallies they would add names the
  // count does not have.
  if (!tallied) {
    for (const f of findings) {
      if (f.flag !== "cookie-set-with-signal" && f.flag !== "cookie-set-on-redirect") continue;
      const name = f.entity?.name;
      if (!name) continue;
      const row = draftsOf(name)[0] ?? draftOf(name, undefined);
      if (f.artifact.kind === "cookie") row.named.add(f.artifact.cookieName);
    }
  }

  // Per-vendor GPC-check state comes from the engine's findings, not re-derived here:
  // vendor-signal-check resolves entity identity through the classifier, so an unrelated
  // host merely containing a vendor's name never marks that vendor as having checked.
  const gpp = input.observations?.gpp ?? null;
  const signalOn = input.observations?.signal.source !== "none";
  // A "no read observed" on a page where property reads could not be observed is not an
  // observed absence: GPP calls were recorded and the vendor made none, and that is all.
  const readsUnavailable = input.observations?.signal.readTracking === "unavailable";
  const traced = (key: VendorRow["checkKey"]): VendorRow["checkKey"] =>
    readsUnavailable && key === "vendorGpcNotRead" ? "vendorGpcCheckUntraced" : key;
  const helpOpts = {
    traceCapReached: obs?.signal.readAttribution?.traceCapReached === true,
    unidentifiedReads: obs !== null && unidentifiedPropertyReads(obs),
    gppSilentSignalOff: !signalOn && gppGpcRecord(gpp) === "silent",
  };

  const rows: VendorRow[] = [];
  for (const draft of drafts.values()) {
    const { name, category } = draft;
    const loaders = draft.unlisted ? loadersOf(findings, name, undefined, true) : loadersOf(findings, name, category);
    const detail: VendorDetail =
      input.observations === null
        ? {
            domains: [],
            requestCount: 0,
            signedRequestCount: 0,
            resourceTypes: [],
            cookies: [],
            consentCalls: [],
            signalReads: 0,
            loadedVia: [],
            probeCookies: [],
            refusedWrites: [],
          }
        : {
            ...vendorDetail(name, category, input.observations, input, draft.unlisted ? domainScriptTest(name, input.observations, input) : undefined),
            loadedVia: loaderLines(loaders, findings, draft.unlisted),
            ...(draft.unlisted ? { unlistedDomain: true } : {}),
          };

    // USP/TCF secondary lines: same "was this API called by this vendor, attributably"
    // question vendorDetail already answers for the expanded panel's consentCalls list —
    // read from there rather than re-scanning consentApiCalls a second way.
    // TCF is narrower: only a getTCData or addEventListener call reads the data.
    const calledApis = new Set(detail.consentCalls.map((c) => c.api));
    const uspLine = calledApis.has("__uspapi") ? uspSecondaryLine(obs?.usPrivacy ?? null) : undefined;
    const tcfRead =
      obs !== null && calledApis.has("__tcfapi") && readTcfData(obs, draft.unlisted ? domainScriptTest(name, obs, input) : rowScriptTest(name, category, input));
    const tcfLine = tcfRead ? tcfSecondaryLine(obs?.tcf ?? null) : undefined;

    const rowLine = loadedViaRowLine(loaders, findings, draft.unlisted);
    // A counted domain with no company is judged like a company row when the engine has a
    // finding for the domain; "No company listed" is only for when it has none.
    const finding = draft.unlisted ? domainFindingFor(findings, name) : checkFindingFor(findings, name, category);
    const checkKey: VendorRow["checkKey"] = traced(
      checkKeyOf(finding, gpp, signalOn) ?? (draft.unlisted ? "vendorGpcUnlistedDomain" : "vendorGpcCheckUnavailable"),
    );
    const help = checkHelpFor(checkKey, finding, helpOpts);
    // One entry per key: a name set on two domains is two cookies, told apart by domain.
    const counted = category === undefined || COUNTING_CATEGORIES.has(category);
    const listed = (cookieName: string): boolean => counted && input.isListedFunctional?.(cookieName) === true;
    const cookies = new Set<string>(draft.named);
    const functional = new Set<string>([...draft.named].filter(listed));
    for (const c of draft.keyed) {
      const shown = shownName(c, draft.keyed);
      cookies.add(shown);
      if (listed(c.name)) functional.add(shown);
    }
    rows.push({
      name,
      key: rowKeyOf(name, category),
      cookies: [...cookies].sort(),
      functionalCookies: [...functional].sort(),
      ...(category !== undefined ? { category } : {}),
      counted,
      ...(cookies.size === 0 ? emptyKeyOf(detail, false) : {}),
      checkKey,
      checkHelp: draft.unlisted ? domainHelp(help) : help,
      ...(uspLine ? { usp: uspLine } : {}),
      ...(tcfLine ? { tcf: tcfLine } : {}),
      ...(rowLine ? { loadedVia: rowLine } : {}),
      detail,
    });
  }

  // The domains the list names no company for (1.26.0), each a row of the last group. One
  // with a cookie of this visit, a probe or a refused write, or whose script read GPC: a
  // domain that was only contacted has nothing to list, and the Requests tab has its
  // requests. Its Read GPC
  // state and who loaded it are the engine's, judged per domain as a company is per
  // category, so the row reads as every row does.
  if (obs !== null) {
    for (const u of Object.values(obs.tallies.byUnlistedDomain ?? {})) {
      const keys = signalOn ? u.cookieKeys : u.cookieKeysUnsigned;
      // The engine's own rule, so a row and a judged domain are one set. Its read of GPC is
      // what gives a domain that set nothing a row, and the finding says it.
      const finding = domainFindingFor(findings, u.domain);
      if (!unlistedDomainHasRow(u, signalOn, finding?.flag === "vendor-read-gpc")) continue;
      const checkKey = traced(checkKeyOf(finding, gpp, signalOn) ?? "vendorGpcCheckUnavailable");
      const loaders = loadersOf(findings, u.domain, undefined, true);
      const detail: VendorDetail = { ...unlistedDetail(u, obs, input), loadedVia: loaderLines(loaders, findings, true) };
      const calledApis = new Set(detail.consentCalls.map((c) => c.api));
      const uspLine = calledApis.has("__uspapi") ? uspSecondaryLine(obs.usPrivacy) : undefined;
      const tcfLine = calledApis.has("__tcfapi") && readTcfData(obs, domainScriptTest(u.domain, obs, input)) ? tcfSecondaryLine(obs.tcf) : undefined;
      const rowLine = loadedViaRowLine(loaders, findings, true);
      rows.push({
        name: u.domain,
        key: rowKeyOf(u.domain, "unlisted"),
        cookies: shownNames(keys),
        functionalCookies: [],
        category: "unknown",
        counted: false,
        group: "unlisted",
        // A probe is a cookie that was set; a refused write is one that was not.
        ...(keys.length === 0 ? emptyKeyOf(detail, u.probeCookies.length > 0) : {}),
        checkKey,
        checkHelp: domainHelp(checkHelpFor(checkKey, finding, helpOpts), u),
        ...(uspLine ? { usp: uspLine } : {}),
        ...(tcfLine ? { tcf: tcfLine } : {}),
        ...(rowLine ? { loadedVia: rowLine } : {}),
        detail,
      });
    }
  }

  // By category, in the list's order: advertising, analytics, then the categories that do
  // not count, "unknown" last, and after every category the domains with no company. The list draws a label over each group, so rows with no
  // category are a group of their own, first and unlabeled: among the advertising rows they
  // would sit under a label the capture cannot vouch for. Inside a category, the rows that
  // set a cookie first, then alphabetical.
  //
  // Two concerns with setters first, and their answers. Setters-first can read as
  // severity: so the order inside a category follows the headline's own question (which
  // vendors set these cookies), never how many each set. And a vendor moves up the moment
  // it sets something: the headline count changes in that same moment, and a list that does
  // not move with it would be answering a different visit.
  const rank = (row: VendorRow): number =>
    row.group === "unlisted" ? Number.MAX_SAFE_INTEGER : row.category === undefined ? -1 : categoryRank(row.category);
  return rows.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      Number(b.cookies.length > 0) - Number(a.cookies.length > 0) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

/**
 * The sentence under the number. See PopupView.countCaption.
 *
 * It does not repeat the number above it. A counted zero reads the same whether or not
 * vendors were contacted: the requests are their own line below, never the headline,
 * because a request count grows for as long as the page is open. The cookie count grows
 * too while a page loads, by each cookie once the browser's jar is found to hold it, and it
 * never falls: a cookie that was counted is not taken back out, whatever removes it. The
 * "advertising or analytics domains" captions remain for the case where no counted cookie
 * resolved to a company's row, every one to no row or to a domain the list names no company
 * for, so the caption never says zero vendors under a count that is not zero. One cookie has
 * one vendor, so that pair needs no plural.
 */
/**
 * The caption's messages, written out: the strings report finds a message by its key in
 * the source, and a key put together from parts is one it cannot find.
 */
const CAPTIONS = {
  on: {
    zero: "countCookiesZero",
    domains: "countCookies",
    oneByDomain: "countCookiesOne",
    byVendors: "countCookiesByVendors",
    byOneVendor: "countCookiesByOneVendor",
    oneByVendor: "countCookiesOneByVendor",
    byBoth: "countCookiesByBoth",
    byBothOneAnalytics: "countCookiesByBothOneAnalytics",
    advertising: { by: "countCookiesByAdvertising", byOne: "countCookiesByOneAdvertising", oneBy: "countCookiesOneByAdvertising" },
    analytics: { by: "countCookiesByAnalytics", byOne: "countCookiesByOneAnalytics", oneBy: "countCookiesOneByAnalytics" },
  },
  off: {
    zero: "countCookiesOffZero",
    domains: "countCookiesOff",
    oneByDomain: "countCookiesOffOne",
    byVendors: "countCookiesOffByVendors",
    byOneVendor: "countCookiesOffByOneVendor",
    oneByVendor: "countCookiesOffOneByVendor",
    byBoth: "countCookiesOffByBoth",
    byBothOneAnalytics: "countCookiesOffByBothOneAnalytics",
    advertising: { by: "countCookiesOffByAdvertising", byOne: "countCookiesOffByOneAdvertising", oneBy: "countCookiesOffOneByAdvertising" },
    analytics: { by: "countCookiesOffByAnalytics", byOne: "countCookiesOffByOneAnalytics", oneBy: "countCookiesOffOneByAnalytics" },
  },
} as const;

function countCaptionFor(
  state: PopupState,
  count: number,
  names: PopupView["countNames"],
): PopupView["countCaption"] {
  // A site with no ad tech is not "clean": there was nothing to observe a response to.
  if (state === "no-ad-tech") return { key: "stateNoAdTech" };
  if (state !== "observed" && state !== "signal-off") return undefined;
  const c = CAPTIONS[state === "signal-off" ? "off" : "on"];
  if (count === 0) return { key: c.zero };
  // The vendors are the companies the list names. A domain it names none for keeps its
  // cookies in the count and is not one of them, so a count made only of such domains'
  // cookies takes the caption that names no vendors.
  const listed = names.filter((n) => n.unlisted !== true);
  if (listed.length === 0) return { key: count === 1 ? c.oneByDomain : c.domains };

  const companies = (category?: string): number =>
    new Set(listed.filter((n) => category === undefined || n.category === category).map((n) => n.name)).size;
  // A capture that cannot say which kind a vendor is names no kind.
  if (listed.some((n) => n.category === undefined)) {
    const vendors = companies();
    return count === 1
      ? { key: c.oneByVendor }
      : vendors === 1
        ? { key: c.byOneVendor }
        : { key: c.byVendors, substitution: [String(vendors)] };
  }
  const advertising = companies("advertising");
  const analytics = companies("analytics");
  if (advertising > 0 && analytics > 0) {
    return analytics === 1
      ? { key: c.byBothOneAnalytics, substitution: [String(advertising)] }
      : { key: c.byBoth, substitution: [String(advertising), String(analytics)] };
  }
  const kind = advertising > 0 ? c.advertising : c.analytics;
  const vendors = advertising + analytics;
  return count === 1
    ? { key: kind.oneBy }
    : vendors === 1
      ? { key: kind.byOne }
      : { key: kind.by, substitution: [String(vendors)] };
}

/**
 * The one notice on a page the extension cannot inspect. A new tab or a blank tab has no
 * page in it yet, so it says what to do; every other page says it cannot be inspected,
 * which reloading does not change. Unavailable, as the notices for a load that was not
 * observed and a page that did not load are: the same limit, reached before any load.
 */
function ineligibleNotice(kind: PageKind | null): Notice {
  return {
    kind: "incomplete",
    tone: "unavailable",
    placement: "top",
    textKey: kind === "new-tab" ? "stateNewTab" : "stateIneligible",
  };
}

/**
 * Whether the record holds nothing the page itself produced: no request, no count and no
 * report from its scripts. What a page the browser withholds from this extension leaves.
 */
function nothingFromThePage(obs: ObservationSet): boolean {
  return obs.network.length === 0 && obs.tallies.totalRequests === 0 && obs.signal.source === "none";
}

/** The one notice on a page the browser does not let this extension access. */
const SITE_ACCESS_NOTICE: Notice = {
  kind: "incomplete",
  tone: "unavailable",
  placement: "top",
  textKey: "stateSiteAccessLimited",
  subTextKey: "stateSiteAccessLimitedHint",
};

/** Determine which presentation applies (PRD 5.6). */
function stateFor(
  obs: ObservationSet | null,
  adTechRequests: number,
  pending: boolean,
  kind: PageKind | null,
  pageAccess: boolean | undefined,
): PopupState {
  // Whether the page can be inspected at all, before the record is read or waited for: no
  // record and no amount of waiting makes a new tab or a browser page inspectable.
  if (kind === "new-tab" || kind === "not-inspectable") return "ineligible";
  // Then a null record, before anything reads it. Before the worker has answered, the popup
  // draws one frame with no record and pending set, and that is "still looking". After it
  // has answered, the popup sets pending only for a record with nothing to show yet
  // (popup.ts, viewOf), so a null is "no data": nothing was received, and no amount of
  // waiting fills it in.
  if (obs === null) return pending ? "pending" : "no-data";
  // A page the browser does not let us access, before pending: nothing will arrive from it,
  // however long the popup waits. Only while the record holds nothing from the page.
  if (pageAccess === false && obs.context.topSite !== "" && nothingFromThePage(obs)) return "site-access-limited";
  // Then pending, before anything that reads the record. A page mid-load has almost no
  // observations yet, and rendering that as "nothing here" states an absence we have not
  // established. "Still looking" is the honest description of not knowing yet.
  if (pending) return "pending";
  // The worker's word for the same, where the tab's address is not known: it records no
  // site for a page it does not track.
  if (obs.context.topSite === "") return "ineligible";
  // Before anything that reads the observations. A tab that was open when the extension
  // was installed or updated has, at most, the requests it made afterwards and no report
  // from the page. Rendering those as "signal off" or "no ad tech" would state what the
  // page did on the strength of a load nobody watched. Only an explicit false: a bundle
  // recorded before 1.14.0 has no field and was observed.
  if (obs.context.loadObserved === false) return "needs-reload";
  // Before the signal test for the same reason: on Chrome's error page no content script
  // ran, and its empty defaults read as "signal off" (ticketing-b.example, 2026-09-25).
  if (obs.context.loadError) return "load-failed";
  if (obs.signal.source === "none") return "signal-off";
  // Only "nothing was there" earns the excluded-from-totals state. A site with ad tech
  // that set no cookies is a counted zero, which is a different and better result.
  if (adTechRequests === 0) return "no-ad-tech";
  return "observed";
}

/** What the classification list says of one URL. See BuildInput.classify. */
export interface UrlClass {
  readonly party: "first" | "third";
  /** The category, in the engine's names; "unknown" where the list gives none. */
  readonly category: string;
  /** The company the list names for the domain, or null where it names none. */
  readonly entity: string | null;
  /** The registrable domain. */
  readonly domain: string;
}

export interface BuildInput {
  readonly observations: ObservationSet | null;
  readonly findings: readonly Finding[];
  readonly distinctCookies: number;
  /** Cookies set on requests that did not carry the signal. See PopupView. */
  readonly distinctCookiesUnsigned?: number;
  /**
   * How many third-party requests classified as advertising or analytics were observed,
   * REGARDLESS of whether they set cookies.
   *
   * This must not be derived from cookie findings. Doing so would collapse two distinct
   * states from PRD 5.6 into one: "no ad tech present" and "ad tech present but no cookies
   * set". apparel-c.example would report "no third-party ad or analytics requests observed" while
   * 18 scripts were reading the signal, a site full of ad tech described as empty. The
   * second state is the more interesting result of the two and deserves its own
   * presentation.
   */
  readonly adTechRequests: number;
  /**
   * True while the page is still loading and observations are still arriving.
   *
   * A page mid-load has almost no observations yet, and rendering that as "nothing here"
   * asserts an absence that has not been established. "Still looking" is the honest
   * description of not yet knowing.
   *
   * With no observations, true means the worker has not answered yet, and false that it
   * answered with nothing (state "no-data").
   */
  readonly pending?: boolean;
  /**
   * Whether this extension is sending the signal, known WITHOUT observing the page: the
   * DNR rule is installed globally, so this is a fact available before the first request
   * completes. It is what lets the status row render immediately instead of blank.
   */
  readonly sendingSignal?: boolean;
  /**
   * Whether the signal state could be determined at all.
   *
   * False means the service worker was unreachable, which is a different claim from
   * "sending is off" and must not be rendered as a user setting.
   */
  readonly signalKnown?: boolean;
  /** First-party cookies written by attributable ad/analytics scripts. */
  readonly firstPartyVendorCookies?: number;
  /**
   * What the classification list says of a URL: whose it is, in which category, first
   * party or third, and its registrable domain. Supplied by the caller so this module stays
   * free of the list, and ONE function, so every question asked of the list here gets the
   * answer the count and the Requests tab got: three surfaces disagreeing about who is a
   * vendor is how a reader stops trusting any of them.
   */
  readonly classify?: (url: string) => UrlClass | undefined;
  /**
   * Whether a cookie name is on the list of functional cookie names. Supplied by the
   * caller so this module stays free of the list. By name alone: the list has no domain
   * condition and the extension reads no value. Absent, nothing is labeled.
   */
  readonly isListedFunctional?: (cookieName: string) => boolean;
  /**
   * The container owners' cookie names (1.25.0), the list the worker charged the tallies
   * by. Supplied by the caller so this module stays free of the list, and read only where
   * a capture has no tallies to say whom a cookie is charged to. Absent, a cookie written
   * inside a container is no company's.
   */
  readonly owners?: OwnerNames;
  /**
   * Whether the "check published GPC file" setting is on.
   *
   * Distinct from `observations.wellKnown` being null: that can also mean the check is on
   * but hasn't resolved yet, or found nothing. The row needs to tell all three apart rather
   * than rendering "not present" for a check the user turned off themselves.
   */
  readonly checkWellKnownEnabled?: boolean;
  /**
   * The tab's address as the browser reports it, read by the popup from the tab itself.
   * Whether the page can be inspected at all is decided from it (pageKindOf) before anything
   * reads the observations. Absent, the record's empty site decides.
   */
  readonly tabAddress?: string;
  /**
   * Whether the browser lets this extension access the page shown, as the popup asks it
   * (chrome.permissions.contains for the page's origin). The reader's site access setting
   * and an administrator's blocked hosts both withhold it. Absent where not asked.
   */
  readonly pageAccess?: boolean;
}

export function buildPopupView(given: BuildInput): PopupView {
  // Every reader below sees the persisted fields; an older bundle has them derived, once.
  const obs = given.observations === null ? null : withPersistedShape(given.observations);
  const input: BuildInput = { ...given, observations: obs };
  const kind = pageKindOf(input.tabAddress);
  const state = stateFor(obs, input.adTechRequests, input.pending === true, kind, input.pageAccess);

  // A page the extension cannot inspect is one notice and nothing else, and nothing below
  // reads its record: no reload prompt in the status row or the notice, which a page that
  // was never inspectable cannot answer, and no section built from what a frame inside it
  // reported. The status the view carries is the setting's, as for a tab with no record;
  // the renderer draws no status row in this state.
  if (obs === null || state === "ineligible") {
    // Even with no observations we can describe the signal: sending is our own state, not
    // something we learn from the page.
    const status = settingStatus(input.sendingSignal, input.signalKnown);
    return {
      state,
      site: "",
      status,
      notices: state === "ineligible" ? [ineligibleNotice(kind)] : [],
      siteDid: [],
      privacyStrings: [],
      gpcReads: [],
      cookieCount: 0,
      unsignedCookieCount: 0,
      adTechRequests: 0,
      firstPartyVendorCookies: 0,
      vendors: [],
      containers: [],
      containersQuiet: [],
      countNames: [],
    };
  }

  const vendors = vendorRows(input.findings, input);
  const owner = sameOwnerNotice(obs, input, vendors);
  // A capture from before the container record, with no requests to derive it from: the
  // rows draw without cookies and say so (1.25.0).
  const given0 = given.observations;
  const predates = given0 !== null && given0.tallies.byContainer === undefined && given0.network.length === 0;
  const containers = containerRows(obs, input, input.findings, (url) => classOf(url, obs, input), predates);
  // The counted rows and no others: the names under the headline are what the number
  // counts.
  const countNames = vendors
    .filter((v) => v.counted && v.cookies.length > 0)
    .map((v) => ({
      name: v.name,
      ...(v.category !== undefined ? { category: v.category } : {}),
      ...(v.detail.unlistedDomain === true ? { unlisted: true as const } : {}),
      cookies: v.cookies,
      functionalCookies: v.functionalCookies,
    }));
  const firstParty = firstPartyOf(obs, input);
  const caption = countCaptionFor(
    state,
    state === "signal-off" ? (input.distinctCookiesUnsigned ?? 0) : input.distinctCookies,
    countNames,
  );
  return {
    state,
    site: obs.context.topSite,
    status: statusFor(obs, input.sendingSignal, input.signalKnown, input.pageAccess),
    notices:
      state === "site-access-limited"
        ? [SITE_ACCESS_NOTICE]
        : owner
          ? [...noticesFor(obs, input.findings), owner]
          : noticesFor(obs, input.findings),
    siteDid: siteDidRows(obs, input),
    privacyStrings: privacyStringRows(obs),
    gpcReads: [checkedRow(obs, input, vendors)],
    cookieCount: input.distinctCookies,
    unsignedCookieCount: input.distinctCookiesUnsigned ?? 0,
    adTechRequests: input.adTechRequests,
    // The section names these cookies, so the line under the headline is left out (1.26.0).
    firstPartyVendorCookies: firstParty === undefined ? (input.firstPartyVendorCookies ?? 0) : 0,
    ...(caption !== undefined ? { countCaption: caption } : {}),
    vendors,
    containers: containers.rows,
    containersQuiet: containers.quiet,
    ...(firstParty !== undefined ? { firstParty } : {}),
    countNames,
  };
}
