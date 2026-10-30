// SPDX-License-Identifier: GPL-3.0-only
/**
 * The schema version. Every ObservationSet and EvidenceBundle carries this.
 *
 * Why it exists (PRD NFR-2, D8, FR-23): capture and engine communicate ONLY through
 * this contract, and evidence bundles must be replayable through the engine offline,
 * possibly months later. A bundle recorded under one schema version must be readable
 * (or explicitly rejected) by a later engine. Bump MAJOR on any breaking field change.
 *
 * This is distinct from the rule-set version (which lives in the engine) and the list
 * version (which lives in @gpc-inspector/lists). A bundle records all three.
 */
// 1.1.0 adds CookieRecord.writerScriptUrl / writerViaTagManager for JavaScript-set
// cookies. Additive and optional, so bundles recorded under 1.0.0 still validate.
// 1.2.0 removes the "gtm-consent-denied-cookies-set" finding flag. Consent Mode is a
// propagation mechanism for Google's tags, not the obligation itself, so pairing it with
// an unrelated vendor's cookie asserted a contradiction that had not been established.
// 1.3.0 completes GtmConsentState with the storage types Google documents
// (functionality_storage, personalization_storage, security_storage).
// 1.4.0 adds GtmObservation.gtagIds. Consent Mode is a tag-platform feature reachable
// through gtag.js with no Tag Manager container present, and reporting it as "Tag Manager"
// mislabeled those sites.
// 1.5.0 adds ObservationSet.capabilities, so a failed interceptor is reported as
// "unavailable" rather than silently rendering as an absence on the site's part.
// 1.6.0 adds ObservationSet.wellKnown for the published GPC resource.
// 1.7.0 adds ObservationSet.tallies. Counts are maintained at capture time and are complete;
// `network` is a retained sample. Truncation now changes what can be enumerated, never what
// is counted.
// 1.8.0 adds NetworkObservation.cookiesSent: which cookie NAMES a request carried back to
// the domain that set them. Values are never captured.
// 1.9.0 adds ObservationSet.tcf (TcfObservation | null). TCF is a GDPR mechanism with no
// obligation relationship to GPC, decoded and carried as plain observation data (same
// treatment as gpp/usPrivacy) for display alongside the per-vendor GPC-read findings.
// 1.10.0 adds SignalObservation.readAttribution and gives readsByScript a populated
// meaning. Reads of navigator.globalPrivacyControl are now attributed to the calling script
// on a bounded sample, so the engine can treat a direct property read as a GPC check
// alongside a __gpp call. readAttribution carries what the sample covered; without it an
// empty readsByScript could not be told apart from an attributed nothing. Additive: a
// bundle recorded under 1.9.0 still validates and simply attributes no reads.
// 1.11.0 adds Tallies.adCookieEventsUnsigned / adCookieKeysUnsigned and
// EntityTally.cookieNamesUnsigned: the cookie counts for requests that did not carry
// Sec-GPC, so a visit with sending off has a headline to compare against a visit with it
// on. Additive; readers treat a missing field as zero.
// 1.12.0 keeps what attribution already saw and then discarded:
// ConsentApiCall.containerUrls and ReadAttribution.viaTagManagerByContainer carry the
// container frame URLs, whose queries name the container (gtm.js?id=GTM-ABC), so a check
// can be counted per container instead of page-wide. GtmObservation gains
// consentModeDefaultSetBy / consentModeUpdateSetBy (which container's frame pushed each
// consent command) and effectiveConsent (the shared page-level consent store read
// directly, keyed by arbitrary string because sites add their own consent types to it).
// The same version adds the insertion record: ObservationSet.scriptInsertions and
// scriptInsertionCoverage, CaptureCapabilities.scriptInsertion, and the
// vendor-check-loader artifact with LoaderIdentity / LoaderRoute, plus loadedVia on the
// network artifact. All optional; a 1.11.0 bundle reads as one that recorded none of them.
// 1.13.0 adds the per-vendor summary to the tallies: EntityTally.resourceTypes and
// EntityTally.scriptRan, maintained as requests arrive and persisted with the counts, so
// a vendor can be judged and its panel filled after the retained request list is lost to
// a worker restart. The "tally" finding artifact carries that judgment when no request
// remains to point at. Optional; a 1.12.0 bundle reads as one whose tallies say nothing
// about execution, and the engine then judges from retained requests only, as before.
// The same version adds ReadAttribution.traceCapReached: read tracing now covers every
// read up to a cap, and this says whether the page went past it.
// 1.14.0 adds CaptureContext.loadObserved: false when the document was already open
// before this version of the extension could observe it (install, update, re-enable), so
// a capture made of late requests only is not read as a capture of the page. Optional; a
// 1.13.0 bundle reads as one whose load was observed.
// 1.15.0 adds ConsentApiCall.count and lastTimeMs: identical consent-API calls are merged at
// capture time instead of stored one by one, which bounded storage by callers rather than
// by calls. Optional; a 1.14.0 bundle reads as one record per call (count 1).
// 1.16.0 validates privacy strings taken from outbound requests: GppObservation and
// UsPrivacyObservation gain fromWireHost (who carried the wire value) and invalidWire
// (values that are not strings, such as an unfilled `[GPP]` placeholder, kept apart so they
// never feed a disagreement). Optional; a 1.15.0 bundle reads as one that saw none.
// 1.17.0 adds Tallies.adCookieCategories: which category (advertising or analytics) set
// each counted cookie, so the headline, which counts both, can show the split. Optional; a
// 1.16.0 bundle shows no split.
// 1.18.0 adds Tallies.probeCookies and refusedCookieWrites: per vendor, the cookies taken
// out of the counts as probes and the writes the browser refused, so the popup can show
// them as not counted. Optional; a 1.17.0 bundle shows neither.
// 1.19.0 adds Tallies.adCookieEntities: the vendor that set each counted cookie key, so the
// names under the headline and the vendor rows list exactly the keys the number counts.
// Optional; a 1.18.0 bundle falls back to the per-vendor name lists.
// 1.20.0 adds Tallies.byEntityCategory, FindingEntity.category and the category on a loader
// that is a company (LoaderIdentity, kind "entity"). The unit the popup lists
// and the engine judges is a company in one category, for every category: Microsoft's
// Advertising domains apart from its Analytics ones, and companies in categories that do
// not count (Social, Consent Managers, Content and the rest). The summary holds what a row
// needs once the requests are gone, and the cookie keys of the categories that do not
// count. It counts nothing: the counted keys, adVendorRequests and byEntity are written as
// before. Both optional; a 1.19.0 bundle has one state per company and no rows outside
// advertising and analytics.
// 1.21.0 adds Provenance.functionalList: which list of functional cookie names produced a
// "listed as functional" label, by source, version, commit and hash, beside the
// classification list's. Optional; a 1.20.0 bundle names no such list.
// 1.22.0 adds Tallies.cookieDetails, GtmObservation.scriptFetched,
// CaptureContext.incompleteReasons, and on EntityCategoryTally firstObservationId,
// executionObservationId and scriptRanOutsideXhr: what the Overview and the engine read from
// the request list is now also recorded as it arrives, so counts and findings are the same
// after a worker reclaim loses the list, and the popup can say what an incomplete capture
// lost. Cookie findings become one per distinct signed cookie rather than one per Set-Cookie
// event. All optional; the engine's withPersistedShape derives them from an older bundle's
// requests, so every reader sees one shape.
// 1.23.0 moves capture's document.cookie accessor to the object that owns the native
// property, behind any consent tool that wraps it, and adds what that needs recorded:
// CookieRecord.writerWrapperUrl (the tool's cookie wrapper attribution stepped over to find
// the writer) and ObservationSet.cookieCoverage (whether another accessor sat in front of
// capture's, or the document carried its own). Both optional; a 1.22.0 bundle reads as one
// that stepped over nothing and recorded no coverage.
// 1.24.0 adds CaptureContext.scanId: one id per capture, which EvidenceBundle.scanId now
// repeats. Before it the bundle's id was generated at each export, so two exports of one
// capture read as two scans. Optional; a 1.23.0 bundle has the bundle-level id only.
// 1.25.0 charges a cookie written inside a tag container by the owner's list: it counts
// only when its name is the container owner's own (Google's `_ga` inside a Google tag), and
// any other is recorded with the container as its writer, counted nowhere. Adds
// Tallies.byContainer (ContainerTally: what was written inside each container, counted or
// not), CookieDetail.container (the writer's container, so the findings charge the key the
// way the tally did) and ObservationSet.ownerList (which list of owners' names did the
// charging). CookieRecord.writerViaTagManager stays and is not read by the rule: the
// container is taken from writerScriptUrl, so a capture from before the change reads the
// same. All optional; the engine's withPersistedShape derives the first two from an older
// bundle's requests.
// 1.26.0 gives every cookie a place. Adds Tallies.byUnlistedDomain (UnlistedDomainTally:
// what each third-party domain the list names no company for did, by registrable domain),
// Tallies.unlistedDomainsCapped and Tallies.firstParty (FirstPartyTally: the site's own
// cookies, and the ones an advertising or analytics script wrote while the signal was
// off). They count nothing, and no count reads them. All optional, and NOT derived for an
// older bundle: which domain is third party and unlisted is the list's answer, and
// withPersistedShape has no list. An older bundle shows neither. vendor-signal-check judges
// each unlisted domain with a row (a cookie, a probe or a refused write) as it judges a
// company in a category (FindingEntity.unlisted), from the summary's scriptRan and
// observation ids where the requests are gone; a bundle without byUnlistedDomain gets no
// such finding. A vendor-read-gpc finding's artifact
// ("consent-api" or "signal-read") now carries loadedVia, as the other vendor states do, so a
// row that read GPC names who loaded it; optional, and absent in older bundles. A response
// whose request was lost to a worker reclaim or restart is kept (NetworkObservation
// .requestLost), and its cookies by name in the summaries' cookieKeysRequestLost (a full
// list sets requestLostCapped), with CookieDetail.requestLost: counted nowhere, since
// whether the request carried the signal was not observed.
// 1.27.0 keeps the Requests tab's cookies past a worker reclaim. Adds
// ObservationSet.keptCookieResponses (KeptCookieResponse: each observation that set a cookie,
// its URL without the query and its cookies without their values, written to session storage
// beside the tab's state, at most KEPT_COOKIE_RESPONSE_CAP per tab) and
// keptCookieResponsesIncomplete. The Requests tab lists an entry whose id the request list
// lacks; nothing counts from them and the engine never reads them. Optional; an older bundle
// has none.
// 1.28.0 adds Provenance.publicSuffixList: which Public Suffix List decided registrable
// domains, by source, version and commit. Since the full list replaced a short table of the
// extension's own, a new list can move which host is first party and which domain a finding
// names. Optional; a 1.27.0 bundle names no list.
// 1.29.0 keeps every distinct privacy string outbound requests carried:
// UsPrivacyObservation.wireValues and GppObservation.wireValues (WireValue: the value and the
// hosts that carried it). A disagreement judged from the most recent request alone came and
// went as requests arrived. The list starts over when the page's own string changes. The
// usp and gpp-wire finding artifacts gain fromWireHost, so a notice names the host of the
// value it shows rather than of whichever request came last. Adds the findings
// usp-requests-disagree and gpp-requests-disagree, with the "wire-values" artifact: the page
// reported no string and requests carried different ones. Optional; a 1.28.0 bundle is
// judged from fromWire, as before, and never raises the new findings.
// 1.30.0 checks each cookie against the browser's cookie jar. Adds CookieRecord.jar
// (JarState: landed, not-stored or unknown). A cookie the jar does not hold is taken back
// out of every count and summary, as a probe is, and stays on its request marked
// not-stored. Optional; an older bundle, and any cookie not checked, count as before.
// 1.31.0 adds CaptureContext.loadError: the top document did not load and Chrome showed its
// own error page, where no content script runs, so nothing about the page was observed.
// Optional; a 1.30.0 bundle reads as one whose page loaded. The same version narrows two
// meanings without changing a type. CaptureCapabilities.dataLayer is false only when a
// Google tag loaded, its consent store was not read, and no dataLayer it used could be
// watched; a page with no Google tag has nothing to observe, and one whose store was read had
// Consent Mode observed, and both read true (they read false before, as a failure). WellKnownGpc.fresh
// is true for a recent reading, cached or not, where before it was true only for a reading
// fetched during this navigation.
// 1.32.0 adds two optional GPP section fields to GppSectionFields: MspaCoveredTransaction,
// renamed from MspaCoveredTransactions, a misspelling of the IAB field name, so capture
// never kept the value a CMP reported; and MspaOptOutOptionMode, which capture did not
// keep at all. The popup's two MSPA rows for them never rendered. A 1.31.0 bundle that
// stored the plural key reads it as the singular through the engine's withPersistedShape.
// 1.33.0 narrows GtmObservation.effectiveConsent without changing its type: {} now means
// Google's consent store was read and held no usable entry, where before that case was null
// alongside a missing store. null now means only that the store was absent or not of the
// expected shape. The Consent Mode row reads {} as "not set" rather than "could not be
// read", and consentModeNeedsDataLayer already counted {} as read. A 1.32.0 bundle has no {}.
// 1.34.0 adds chainChecked to the network and tally finding artifacts: on
// vendor-did-not-read-gpc, the vendor was judged by its loader chain and every loader was
// checked. A vendor whose loaders did not all resolve carries its loaders without it, and the
// popup no longer says such a loader did not read GPC. Optional and engine-written; a replayed
// 1.33.0 bundle gets it from the engine like any finding.
// 1.35.0 narrows CaptureCapabilities.cookieStore without changing its type: an absent
// cookieStore, which is every http:// page since the API exists only in secure contexts,
// now reads true, as nothing to observe, where before it read false and the popup said
// cookies set by JavaScript could not be observed on a page whose document.cookie was
// wrapped. False now means only that the store exists and could not be wrapped. The popup
// reads a false from an older bundle of an http:// page as absent.
// 1.36.0 adds readCount to the consent-api finding artifact: on vendor-read-gpc, the vendor's
// direct property reads when it also called __gpp. The call stays the artifact; the popup
// credited only the call, so a vendor that read the property and called __gpp on a page
// whose GPP string records no GPC value was listed as "No read observed". Optional and
// engine-written; a replayed 1.35.0 bundle gets it from the engine like any finding.
// 1.37.0 adds Tallies.adCookieCharges: every vendor each counted cookie key was charged to,
// signed and unsigned apart. The worker kept this ledger in memory only and rebuilt it after
// a reclaim from adCookieEntities, the first vendor of each key, so a probe taken out of the
// count after a reclaim took the name off a vendor charged the same key second, or charged
// it on the other kind of request, while it still held a counted key of that name. Optional;
// a tally stored before this is thawed the old way.
// 1.38.0 adds the IncompleteReason "prerender-lost". A prerendered page loads before it is
// shown, and its capture is handed to the tab when it is; a capture that lost part of that
// load says so. Additive: a 1.37.0 bundle never carries it.
// 1.39.0 adds CaptureContext.restoredFromCache. A page restored from the back/forward cache
// commits a document that loaded before, with no request and no content-script report; its
// capture is marked loadObserved false, keeps the page's own signal report, and says why.
// Optional; a 1.38.0 bundle never has it.
// 1.40.0 adds CookieDetail.removedAfterMs and narrows two meanings without changing a type.
// A cookie counts from the moment the browser's jar is found to hold it and is never taken
// back out: one removed by a later write stays in every count and summary, with how long
// after its last set it was removed. The probeCookies lists (Tallies, EntityCategoryTally,
// ContainerTally, UnlistedDomainTally, FirstPartyTally) now hold only a cookie a script
// wrote and removed again in the same task, where before they held every cookie
// removed within five seconds of its write, by a script or a response. CookieRecord.jar
// "not-stored" no longer covers a cookie removed before the check by a write that found it
// in the browser: that one is counted, and its record carries no mark. Optional; a 1.39.0
// bundle never has the field and keeps its lists as recorded.
// 1.41.0 adds ObservationSet.confirmationText, the matched words of a detected confirmation
// notice, which the Overview quotes, and narrows confirmationNotice without changing its
// type: "not-detected" is recorded only once the timed scans end without a match, where
// before the first scan's miss recorded it. Optional; a 1.40.0 bundle never has the field.
// 1.42.0 adds the ConfirmationNoticeState "not-checked": the confirmation scan was turned off
// in Settings when the page loaded, so the page's text was never read. Additive: a 1.41.0
// bundle never carries it.
// 1.43.0 adds CaptureContext.documentSigned: whether the request that fetched the top
// document carried Sec-GPC, so a reader can tell a load where the header went out and the
// page property was not set (the registered script missed the load) from one where neither
// happened. Optional; a 1.42.0 bundle never has the field. PropertyValue "absent" is now
// what this extension's own page reports while sending is off or before its permission
// arrives, where before it reported false: the property is no longer defined until then.
export const SCHEMA_VERSION = "1.43.0" as const;
export type SchemaVersion = typeof SCHEMA_VERSION;
