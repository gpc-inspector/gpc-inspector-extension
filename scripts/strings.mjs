#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * String tooling: i18n metadata and the strings document.
 *
 * Two jobs.
 *
 * 1. --annotate writes a `description` onto every message. Chrome's messages.json format
 *    already IS the standard extension i18n format, so the file is translatable as it
 *    stands — but `description` is the field a translator reads to understand context, and
 *    without it they are guessing. "asked" alone is untranslatable; "asked — a script from
 *    this vendor called a consent API" is not. This is the substance of being ready to
 *    internationalize, more than any file format is.
 *
 * 2. (default) generates docs/STRINGS.md: every user-visible string in one place, grouped
 *    by where it appears, for reviewing the copy. Generated rather than hand-kept so it
 *    cannot drift from the source of truth.
 *
 * It also reports two things a copy review needs to know:
 *   UNUSED  — a key no source file references. Dead copy accumulates and gets reviewed as
 *             though it ships.
 *   ORDER   — placeholder-bearing strings, which are the ones most likely to break when a
 *             translator reorders a sentence.
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, extname } from "node:path";

const MESSAGES = "packages/capture-extension/public/_locales/en/messages.json";
const OUT = "docs/STRINGS.md";

/**
 * Keys that are intentionally unreferenced.
 *
 * A string can be written ahead of the surface that will show it. Listing them here keeps
 * the unused report meaningful: an unexplained entry is dead copy to delete, and dead copy
 * that stays gets reviewed as though it ships.
 */
const PLANNED = {
  // Built at runtime by categoryLabelKey() in requests-view.ts, one per engine category, so
  // a text scan for the literal key finds nothing. requests-view.test.ts checks that every
  // engine category has one and that no other category_ key exists.
  category_advertising: "Referenced dynamically by categoryLabel().",
  category_analytics: "Referenced dynamically by categoryLabel().",
  category_social: "Referenced dynamically by categoryLabel().",
  category_content: "Referenced dynamically by categoryLabel().",
  category_email: "Referenced dynamically by categoryLabel().",
  category_emailaggressive: "Referenced dynamically by categoryLabel().",
  category_consentmanagers: "Referenced dynamically by categoryLabel().",
  category_antifraud: "Referenced dynamically by categoryLabel().",
  categoryUncategorized: "Referenced dynamically by categoryLabelKey(), for a company the list gives no category.",
  // Resolved as `${checkKey}Help` beside the state they explain (renderVendors in
  // popup.ts), so a text scan for the literal key finds nothing. Same pattern as
  // category_* above. Each is the hover explanation for one vendor check state — a terse
  // value in a narrow column cannot explain itself.
  vendorGpcReadHelp: "Hover text for its state; resolved dynamically as `${checkKey}Help`.",
  vendorGpcReadPropertyHelp: "Hover text for its state; resolved dynamically as `${checkKey}Help`.",
  vendorGpcAskedNoGpcFieldHelp: "Hover text for its state; resolved dynamically as `${checkKey}Help`.",
  vendorGpcAskedNoResponseHelp: "Hover text for its state; resolved dynamically as `${checkKey}Help`.",
  vendorGpcNotReadHelp: "Hover text for its state; resolved dynamically as `${checkKey}Help`.",
  vendorGpcCheckUnattributableHelp: "Hover text for its state; resolved dynamically as `${checkKey}Help`.",
  vendorGpcCheckUnattributableHelpContainer: "Hover text, chosen by the artifact: loader route, loader a container.",
  vendorGpcNotReadViaContainerHelpParentRead: "Hover text, chosen by the artifact: no read via the vendor's own container, a parent container read (context only).",
  vendorGpcCheckUnattributableHelpVendor: "Hover text, chosen by the artifact: loader route, loader another entity or host.",
  vendorGpcCheckUnattributableHelpSite: "Hover text, chosen by the artifact: loader route, loader the site.",
  vendorGpcCheckUnattributableHelpConsentMode: "Hover text, chosen by the artifact: consent-mode route.",
  vendorGpcNotReadViaContainerHelpContainer: "Hover text, chosen by the artifact: no read via the vendor's own container chain.",
  vendorGpcNotReadHelpLoader: "Hover text, chosen by the artifact: no read seen from the vendor or the loader that inserted it.",
  vendorGpcNotReadHelpCapped: "Hover text for a no-read state when the page went past the read-trace cap.",
  vendorGpcCheckOrderBefore: "Appended to a loader-route hover text when the read preceded the load.",
  vendorGpcCheckOrderAfter: "Appended to a loader-route hover text when the read followed the load.",
  vendorGpcNotApplicableHelp: "Hover text for its state; resolved dynamically as `${checkKey}Help`.",
  vendorGpcCheckUnavailableHelp: "Hover text for its state; resolved dynamically as `${checkKey}Help`.",
  vendorGpcUnlistedDomainHelp: "Hover text for its state; resolved dynamically as `${checkKey}Help`.",
  vendorGpcCheckUntracedHelp: "Hover text for its state; resolved dynamically as `${checkKey}Help`.",
  // The "Inspect pages as you browse" switch is hidden: observePassively only sets
  // context.mode in sw.ts and gates nothing, so the switch would change nothing the reader
  // can see. The setting is still stored and the bug report carries it. The strings come
  // back with the switch if it ever gates capture.
  settingObserve: "Label of the observe switch, hidden because the setting gates nothing.",
  settingObserveDesc: "Description of the observe switch, hidden because the setting gates nothing.",
};

/**
 * Surfaces, in the order a person encounters them. Each key belongs to exactly one.
 * Grouping is by where the string APPEARS, not by what it is about: the reviewer is
 * reading the popup, not the codebase.
 */
const SURFACES = [
  {
    title: "Extension identity",
    note: "Shown in the Chrome Web Store listing and the extensions page.",
    keys: ["extName", "extDescription"],
  },
  {
    title: "Signal status row",
    note: "The first line of the popup. States whether the signal is set and who set it. Never a control.",
    keys: [
      "signalSetBy",
      "signalNotSet",
      "sourceThisExtension",
      "sourceBrowser",
      "sourceOtherExtension",
      "sourceBrowserOff",
      "sourceOtherExtensionOff",
      "sourceBrowserOffHeaderSent",
      "sourceOtherExtensionOffHeaderSent",
      "sourceOffInSettings",
      "sourceNeedsReload",
      "sourceUnknown",
    ],
  },
  {
    title: "Toolbar icon",
    note: "Hover title of the extension's toolbar icon. The icon is blue when a GPC signal was observed on the page, whoever set it, and gray otherwise. Before a page reports, it shows this extension's setting; a badge reading ! with the last title means the browser did not install the header rule.",
    keys: ["actionTitleSending", "actionTitleOn", "actionTitleOff", "actionTitleRuleFailed"],
  },
  {
    title: "Page notices",
    note: "Appear above the count when the reader needs them before the numbers mean anything.",
    keys: [
      "stateIncomplete",
      "stateCaptureUnavailable",
      "findingGppConflict",
      "findingGppDisagree",
      "findingGpcGppMismatch",
      "labelGpcSignalValue", "valueGpcSignalSet", "valueGpcSignalNotSet",
      "labelGppGpcFieldValue", "valueGppGpcFieldSet", "valueGppGpcFieldNotSet",
      "findingDeclaredHonorButSet",
      "findingConfirmationShownButSet",
      "findingDeclaredAndShownButSet",
      "findingUspDisagree",
      "stateSaveFailed", "stateDeliveryGap", "stateConsentCallsCapped",
      "findingGppDisagreeHost", "findingUspDisagreeHost", "findingUspCookieDisagree",
      "findingGppRequestsDisagree", "findingUspRequestsDisagree",
      "noticeSameOwnerAdvertising", "noticeSameOwnerAnalytics", "noticeSameOwnerBoth",
    ],
  },
  {
    title: "What this site did",
    note: "Key/value rows: how the site responded to GPC, and nothing else; GPP, USP and TCF have their own section. Every row leads with yes/no, every value distinguishes an absence we observed from one we could not look for, and 'checking' is its own state so a row never goes missing while a check is in flight. The GPC read rows come last, nested under the heading 'Read GPC from the page': 'Read observed', 'No read observed' and, when someone is in that state, 'Cannot determine', each naming its vendors under the label or saying 'none', then the page's other facts in hint tone under the row they are about, and the GPP-string notes at the bottom of the group; the read count is not shown. A vendor is a company with its category, every one is listed, and scripts that belong to no vendor are named by domain.",
    keys: [
      "sectionSiteDid",
      "labelCheckedForGpc",
      "labelReadObserved",
      "labelReadNotObserved",
      "labelReadUndetermined",
      "valueReadNone",
      "vendorInCategory",
      "hintCheckedOtherDomains",
      "hintCheckedThisSite",
      "hintGppCalledUnidentified",
      "hintReadsNoneTraced",
      "hintReadsUnidentified",
      "hintCheckedTagManagerAlso",
      "hintCheckedContainerAlso",
      "hintCheckedContainersAlso",
      "hintCheckedContainerRead",
      "hintCheckedContainersRead",
      "hintCheckedTagManagerRead",
      "hintNoCheckGppRecords",
      "hintGppStringSilent",
      "hintReadsUnavailable",
      "hintReadsCapped",
      "labelWellKnown",
      "valueWellKnownDisabled",
      "valueWellKnownNotPresent",
      "valueWellKnownUnchecked",
      "hintWellKnownStatus", "hintWellKnownNoResponse",
      "labelConfirmation",
      "valueYes", "valueNo", "valueChecking",
    ],
  },
  {
    title: "Privacy strings — the collapsed rows",
    note: "What the SITE broadcasts about the reader, as opposed to what the browser sent. A separate section because it answers a different question, and because its heading is the only place that says what these strings ARE — a reader seeing 'GPP' has no other route to that. Each row leads with a plain-language outcome and opens to the decode below.",
    keys: [
      "sectionPrivacyStrings",
      "valueNotPresent", "valueNotObservable", "valueNoneObserved",
      "sectionPrivacyStringsDesc",
      "labelPrivacyString",
      "labelUsPrivacy",
      "labelTcf",
      "labelDeprecated",
      "labelTcfScope",
      "valueGpcFieldYes",
      "valueGpcFieldNo",
      "valueGpcFieldAbsent",
      "valueGppOptedOut",
      "valueGppOptedOutSome",
      "valueGppNotOptedOut",
      "valueGppNoOptOut",
      "valueGppWireOnly",
      "valueGppNoUsSection",
      "valueGppUsSectionNoFields",
      "valueStringNotReadable",
      "gppNoteMismatchSignalSet",
      "gppNoteMismatchSignalNotSet",
      "valueUspOptedOutY",
      "valueUspOptedOutN",
      "valueUspNotApplicable",
      "valueTcfGranted",
      "valueTcfGrantedOne",
      "valueTcfNoneGranted",
      "valueTcfNoPurposes",
      "valueTcfGdprNotApplies",
      "valueUspWireOnly", "lineUspWireOnly", "lineUspWireOnlyUnwatched",
      "lineGppWireCarried", "lineGppWireDiffers", "lineGppWirePlaceholder", "lineGppWireInvalid",
      "lineUspCookieDiffers", "lineUspWireDiffers", "lineUspWirePlaceholder", "lineUspWireInvalid",
      "rowConsentMode",
      "valueConsentGranted",
      "valueConsentNotSet",
      "valueConsentNoGoogleTags",
      "valueConsentUnread",
    ],
  },
  {
    title: "Privacy strings — the expanded decode",
    note: "Field name, decoded meaning, raw encoded value. The third column is the point: IAB encodes 0 = not applicable, 1 = opted out, 2 = did NOT opt out, so the integer reverses the intuitive reading rather than merely failing to inform it and must never appear alone. Registry names (section ids, TCF purposes) are IAB's published wording and are deliberately untranslated — a paraphrase would change what the CMP said.",
    keys: [
      "nameGpp",
      "nameUsp",
      "nameTcf",
      "gppFieldGpc",
      "gppGroupOptOut",
      "valueOptOutNoneRecorded",
      "gppLabelSection",
      "gppLabelSections",
      "gppNoUsSectionNote",
      "gppOnlyLegacyUsNote",
      "gppFieldSaleOptOut",
      "gppFieldSharingOptOut",
      "gppFieldTargetedAdvertisingOptOut",
      "gppFieldSaleOptOutNotice",
      "gppFieldSharingOptOutNotice",
      "gppFieldTargetedAdvertisingOptOutNotice",
      "gppFieldMspaCoveredTransaction",
      "gppFieldMspaServiceProviderMode",
      "gppFieldMspaOptOutOptionMode",
      "valueOptedOut",
      "valueNotOptedOut",
      "valueFieldNotApplicable",
      "valueNoticeProvided",
      "valueNoticeNotProvided",
      "uspLabelVersion",
      "uspLabelNotice",
      "uspLabelOptOut",
      "uspLabelLspa",
      "hintUspDeprecated",
      "tcfScopeNote",
      "tcfLabelGdprApplies",
      "tcfGdprNotAppliesNote",
      "consentGroupTypes",
      "consentGroupStorage",
      "consentNoneSetNote",
      "valueConsentTypeNotSet",
      "valueGranted",
      "valueDenied",
      "labelRawString",
      "linkGppDecoder",
      "linkTcfDecoder",
    ],
  },
  {
    title: "The count",
    note: "The headline number and its supporting detail. Counts distinct advertising cookies set on requests carrying the signal; with sending off, the same count for requests that did not carry it, so two visits can be compared. The two are never added.",
    keys: [
      "countCookies",
      "countCookiesOne",
      "countCookiesZero",
      "countCookiesOff",
      "countCookiesOffOne",
      "countCookiesOffZero",
      "countCookiesByVendors",
      "countCookiesByOneVendor",
      "countCookiesOneByVendor",
      "countCookiesByBoth", "countCookiesByBothOneAnalytics",
      "countCookiesByAdvertising", "countCookiesByOneAdvertising", "countCookiesOneByAdvertising",
      "countCookiesByAnalytics", "countCookiesByOneAnalytics", "countCookiesOneByAnalytics",
      "countCookiesOffByVendors",
      "countCookiesOffByOneVendor",
      "countCookiesOffOneByVendor",
      "countCookiesOffByBoth", "countCookiesOffByBothOneAnalytics",
      "countCookiesOffByAdvertising", "countCookiesOffByOneAdvertising", "countCookiesOffOneByAdvertising",
      "countCookiesOffByAnalytics", "countCookiesOffByOneAnalytics", "countCookiesOffOneByAnalytics",
      "countFirstPartyVendor",
      "countFirstPartyVendorOne",
    ],
  },
  {
    title: "Vendors",
    note: "Per-vendor rows: the GPC check tag, plus USP/TCF secondary lines shown only when that specific API was called and attributed to the vendor. The engine has five check states; the 'this vendor checked' one splits into four tags here, because a check can be a GPP call or a direct read of the GPC property, and for a GPP call what the returned string recorded changes what can honestly be said about it.",
    keys: [
      "sectionVendors",
      "vendorsColumnCheck", "vendorsColumnCheckTitle",
      "vendorGpcRead", "vendorGpcReadHelp", "vendorGpcReadHelpDomain", "vendorGpcReadHelpSignalOff", "vendorGpcReadHelpSignalOffDomain",
      "vendorGpcReadProperty", "vendorGpcReadPropertyHelp", "vendorGpcReadPropertyHelpDomain",
      "vendorGpcAskedNoGpcField", "vendorGpcAskedNoGpcFieldHelp", "vendorGpcAskedNoGpcFieldHelpDomain",
      "vendorGpcAskedNoResponse", "vendorGpcAskedNoResponseHelp", "vendorGpcAskedNoResponseHelpDomain",
      "vendorGpcNotRead", "vendorGpcNotReadHelp", "vendorGpcNotReadHelpDomain", "vendorGpcNotReadViaContainerHelp", "vendorGpcNotReadViaContainerHelpDomain",
      "vendorGpcCheckUnattributable", "vendorGpcCheckUnattributableHelp", "vendorGpcCheckUnattributableHelpDomain",
      "vendorGpcCheckUnattributableHelpContainer", "vendorGpcCheckUnattributableHelpContainerUnnamed",
      "vendorGpcCheckUnattributableHelpVendor", "vendorGpcCheckUnattributableHelpVendorDomain",
      "vendorGpcCheckUnattributableHelpSite", "vendorGpcCheckUnattributableHelpSiteDomain",
      "vendorGpcCheckUnattributableHelpConsentMode", "vendorGpcCheckUnattributableHelpConsentModeUnnamed",
      "vendorGpcCheckOrderBefore", "vendorGpcCheckOrderAfter", "vendorGpcCheckOrderParentBefore", "vendorGpcCheckOrderParentAfter",
      "vendorGpcCheckOrderBeforeVendor", "vendorGpcCheckOrderAfterVendor", "vendorGpcCheckOrderBeforeDomain", "vendorGpcCheckOrderAfterDomain",
      "vendorGpcNotReadViaContainerHelpContainer", "vendorGpcNotReadViaContainerHelpContainerUnnamed",
      "vendorGpcNotReadViaContainerHelpParentRead", "vendorGpcNotReadViaContainerHelpParentReadUnnamed",
      "vendorGpcNotReadHelpLoader", "vendorGpcNotReadHelpLoaderDomain",
      "vendorGpcNotReadHelpLoaderUnchecked", "vendorGpcNotReadHelpLoaderUncheckedDomain",
      "vendorGpcNotReadHelpCapped", "vendorGpcNotReadHelpCappedDomain",
      "vendorGpcNotReadHelpUnidentified", "vendorGpcNotReadHelpUnidentifiedDomain",
      "vendorGpcNotApplicable", "vendorGpcNotApplicableHelp", "vendorGpcNotApplicableHelpDomain",
      "vendorGpcCheckUnavailable", "vendorGpcCheckUnavailableHelp", "vendorGpcCheckUnavailableHelpDomain",
      "vendorGpcCheckUnavailableHelpDomainCapped",
      "vendorGpcCheckUntraced", "vendorGpcCheckUntracedHelp", "vendorGpcCheckUntracedHelpDomain",
      "vendorGpcUnlistedDomain", "vendorGpcUnlistedDomainHelp",
      "vendorUspChecked",
      "vendorLoadedViaGtm", "vendorLoadedViaGoogleTag", "vendorLoadedViaManager",
      "vendorLoadedViaTagManager", "vendorLoadedViaContainers", "vendorLoadedViaParent",
      "vendorLoadedViaVendor", "vendorLoadedViaHost", "vendorLoadedBySite",
      "vendorLoadedBySiteScript", "vendorLoadedBySiteScriptOne", "vendorLoadedAlsoBySite", "vendorLoadedAlsoByVendor",
      "vendorTcfChecked", "vendorTcfNoPurposes", "vendorTcfNoneGranted",
      "vendorsNoneSeen",
      "vendorsGroupUnlisted", "vendorCookiesSetAndRemoved", "vendorCookiesRequestLost",
      "vendorCookiesWithoutGpc",
    ],
  },
  {
    title: "Tag containers (below the vendors)",
    note: "The site's tag containers: one row per container, every Google tag id on one row, in the vendor row's markup. A row leads with whether a tag inside it read GPC, never which tag; names every cookie written inside it, amber where the count includes the name and secondary where it does not; and says who loaded it in the vendor row's words. Every panel has the same sections in the same order, the Google tag's without the containers it loaded. Requests are companies and domains, never a count.",
    keys: [
      "sectionTagContainers", "containersColumnCheckTitle", "containerNameGoogleTag",
      "containerTagRead", "containerTagReadHelp",
      "containerNoRead", "containerNoReadHelp",
      "containerCannotDetermine", "containerCannotDetermineHelp", "containerCannotDetermineHelpOff", "containerCannotDetermineHelpGpp",
      "containerCookiesPredate",
      "cookieNotCounted", "cookieNotCountedHelp",
      "vdetailVendorsLoaded", "containerAlsoScriptsFrom",
      "vdetailContainersLoaded", "containerLoadedItem",
      "vdetailRequestsSentTo", "containerRequestsTo",
      "vdetailScript",
      "containerQuiet",
    ],
  },
  {
    title: "First party (the Overview's last section)",
    note: "The cookies charged to the site itself: set by its own responses, or written by scripts it serves from its own domain. One row, closed until opened: the site's registrable domain and every cookie name under it, as a vendor row lists them. Open, a sentence saying which cookies are here and which are listed under a third party, then two lists of names, an empty one reading 'none observed', and the cap note once after both. Nothing in it is counted.",
    keys: ["sectionFirstParty", "firstPartyIntro", "firstPartyListVendor", "firstPartyListSite"],
  },
  {
    title: "List credit (the last line of the Overview)",
    note: "The classification list's credit: its name, version and license, with the list and the license linked. Always visible; the attribution the list's license requires. The full statement is the Vendor categories row in Settings.",
    keys: ["listCredit", "listCreditListName", "listCreditLicenseName"],
  },
  {
    title: "Empty and transitional states",
    note: "Shown in place of the body. Each must be distinguishable from the others.",
    keys: ["statePending", "stateNoData", "stateNeedsReload", "stateLoadFailed", "stateNoAdTech", "stateIneligible"],
  },
  {
    title: "Requests tab",
    note: "The request list, grouped by domain. Filters carry counts; rows expand to show what was observed. Every number counts HTTP requests only. A cookie a page script wrote is a row too, with no request: it is counted once, in the note above the list (reqScriptWritesNote), and its row names the script and the GPC property in place of the request's words (reqScriptWriteMeta, detailWrittenBy, detailGpcProperty). The 'set N cookies' mark counts cookies the browser kept, never a deletion or a refused write.",
    keys: [
      "tabOverview", "tabRequests", "btnCopy", "btnLooksWrong",
      "btnSettings", "btnBack", "btnOpenPanel",
      "reqFilterAll", "reqFilterAdvertising", "reqFilterAnalytics", "reqFilterThirdParty", "reqFilterSetCookie",
      "reqFilterUncategorized", "reqNoneMatch", "reqNoneCaptured", "reqCopied",
      "reqRedirect", "reqNoGpc", "reqNoGpcProperty", "reqScriptWriteMeta", "reqScriptWritesNote", "reqScriptWritesNoteOne",
      "markSetOneCookie", "markSetCookies",
      "detailRequest", "detailSecGpc", "detailResponse", "detailWrittenBy", "detailGpcProperty", "detailGpcPropertySet",
      "detailGpcPropertyNotSet", "detailPartyLabel", "detailVendor",
      "detailCategory", "detailSetCookie", "cookieCountedUnder", "detailRedirect", "detailRedirectValue", "detailRedirectNoCookies",
      "detailNoResponse", "detailSignalAbsent", "detailKeptAddress", "detailFirstParty", "detailThirdParty", "groupFirstParty",
      "detailNotStored", "requestsDropped", "requestsDroppedCookiesKept", "requestsDroppedSomeCookiesKept",
      "category_advertising", "category_analytics", "category_social", "category_content",
      "category_email", "category_emailaggressive", "category_consentmanagers",
      "category_antifraud", "categoryUncategorized",
    ],
  },
  {
    title: "Vendor detail",
    note: "Shown when a vendor row on the Overview is expanded.",
    keys: [
      "vdetailNetwork", "vdetailSigned", "vdetailResourceTypes", "hintResourceTypes", "vdetailCookies",
      "vdetailConsentCalls", "vdetailLoadedBy",
      "vdetailDomains", "vdetailPartitioned", "vdetailSameSite", "vendorNoCookies",
      "cookieSentBack", "cookieNotSentBack", "cookieListedFunctional", "cookieListedFunctionalHelp",
      "vdetailCookieUnsigned", "vdetailCookiesCapped", "requestLost",
      "vdetailProbeCookies", "hintProbeCookies", "vdetailRefusedWrites", "hintRefusedWrites",
    ],
  },
  {
    title: "Feedback",
    note: "Three report paths and the export. The finding path carries page data, always masked; the bug and feature paths carry none, and the copy has to make that legible. The export keeps the same record on the reader's device as three files, each with its own button and a line under it saying what it holds. Only the third, never the primary button, holds cookie values.",
    keys: [
      "reportTitleFinding", "reportTitleBug", "reportTitleFeature",
      "reportIntroFinding", "reportIntroBug", "reportIntroFeature", "reportIncludes",
      "reportCancel", "reportOpen",
      "btnExport", "reportTitleExport", "reportIntroExport",
      "exportSaveSummary", "exportSaveSummaryHint", "exportSave", "exportSaveHint",
      "exportSaveUnmasked", "exportSaveUnmaskedHint",
      "summaryTitle", "summaryNoSite", "summaryCount", "summaryAbout",
      "summaryCaptured", "summaryScanId", "summaryRecordHash", "summaryLimitations", "summaryCompanyNames", "summaryCookiesSentBack",
      "reportStep1", "reportStep1Link", "reportStep3", "reportStep3Scripts", "reportStep3Details", "reportStep3Both",
      "reportCopied", "reportCopyFailed", "reportDownload", "reportSaved",
      "previewSite", "previewVersion", "previewBrowser", "previewList",
      "previewRequests", "previewRequestsValue", "previewCookies", "previewCookieNames", "previewPageData", "previewPageDataNone",
      "groupFeedback", "settingReportBug", "settingReportBugDesc",
      "settingReportFeature", "settingReportFeatureDesc", "settingReportOpen",
    ],
  },
  {
    title: "Settings",
    keys: [
      "settingsTitle",
      "groupSignal",
      "settingSendSignal",
      "settingSendSignalDesc",
      "settingSendSignalNative",
      "settingSendSignalNativeOff",
      "groupObservation",
      "settingObserve",
      "settingObserveDesc",
      "settingBadge",
      "settingWellKnown",
      "settingWellKnownDesc",
      "settingScriptLoading",
      "settingScriptLoadingDesc",
      "settingReadTraceCap",
      "settingReadTraceCapDesc",
      "groupAbout",
      "aboutVersion",
      "aboutLinks",
      "linkRepo",
      "aboutLicense", "aboutLicenseDesc", "aboutNoWarranty", "linkCodeLicense",
      "statementObserved", "statementFinding", "statementIndependent",
      "groupCredits", "aboutList", "aboutListDesc", "linkList", "linkListLicense",
      "aboutFunctionalList", "aboutFunctionalListDesc",
      "aboutLimitations", "aboutLimitationsDesc", "linkLimitations",
    ],
  },
  {
    title: "First run",
    note: "Shown once, before anything else. The disclosure that observation happens locally.",
    keys: ["firstRunTitle", "firstRunSignalOn", "firstRunSignalOff", "firstRunSignalNative", "firstRunSignalNativeOff", "firstRunWhy", "firstRunBody", "firstRunPromise", "firstRunAsk", "firstRunAccept"],
  },
];

/**
 * Translator context per key.
 *
 * Written for someone who cannot see the UI and does not know the domain. Where a phrase
 * carries a deliberate distinction, the description says so — a translator who collapses
 * "not present" and "not observable" into one word would undo the point of having both.
 */
const DESCRIPTIONS = {
  extName: "Extension name. 'GPC' is Global Privacy Control, a technical standard; keep the acronym.",
  extDescription: "Store listing summary. States what the extension reports and that it makes no judgments.",

  signalSetBy: "Status line. The privacy signal IS being sent. Followed by a tag naming who sends it.",
  signalNotSet: "Status line. The privacy signal is NOT being sent.",
  sourceThisExtension: "Tag after the status line: this extension is sending the signal.",
  sourceBrowser: "Tag: the browser itself sends the signal, so the extension only observes.",
  sourceOtherExtension: "Tag: a different extension sends it. We deliberately do not name which; we cannot tell.",
  sourceBrowserOff: "Tag after 'signal is not set': the browser implements GPC and has it switched off, and this extension is not sending its own header. Distinct from sourceOffInSettings, which is this extension's setting.",
  sourceOtherExtensionOff: "Tag after 'signal is not set': a different extension owns the GPC property and it reads off, and this extension is not sending its own header. We do not name which extension; we cannot tell.",
  sourceBrowserOffHeaderSent: "Tag after 'signal is not set': the browser has GPC switched off, so page scripts read it as off, while this extension's sending is on and its Sec-GPC request header still goes to sites. 'Sec-GPC' is the header name; keep it untranslated.",
  sourceOtherExtensionOffHeaderSent: "As sourceBrowserOffHeaderSent, when a different extension owns the GPC property and it reads off. 'Sec-GPC' is the header name; keep it untranslated.",
  sourceOffInSettings: "Tag: the user turned sending off. A choice, not a failure.",
  sourceUnknown: "Tag: we could not determine the state. NOT the same as 'off' — do not merge these.",

  stateConfirmed: "Positive notice: the site displayed a notice that it processed the signal. One of the few good-news strings.",
  stateIncomplete: "The capture was truncated or interrupted, so the view is partial.",
  stateCaptureUnavailable: "Part of the page could not be inspected. $WHAT$ is a list like 'gpp (the privacy string)'.",
  findingGppConflict: "The site's GPP string records the GPC signal AND records that the reader did not opt out. IAB guidance calls this pair conflicting.",
  findingDeclaredHonorButSet: "The site publishes a file declaring gpc true, and third-party advertising or analytics cookies were set. States the artifact only.",
  findingConfirmationShownButSet: "The same finding when the site's statement is a confirmation notice on the page.",
  findingDeclaredAndShownButSet: "The same finding when the site made both statements, file and notice.",
  findingUspDisagree: "The US Privacy string differs between what the page reports and what was sent on the network.",
  findingSignalNotRead: "No script accessed the signal property. Reading is not the obligation, so avoid implying it is.",

  sectionSiteDid: "Section heading over the key/value rows.",
  labelSignalRead: "Row label: how many scripts accessed the signal property.",
  valueScriptsRead: "Row value: a count of scripts. $COUNT$ is a number.",
  valueNoScriptRead: "Row value: we looked and nothing read it. Distinct from 'not observable'.",
  labelPrivacyString: "Row label. GPP is the industry Global Privacy Platform string; keep the acronym.",
  labelUsPrivacy: "Row label. The legacy US Privacy string.",
  labelConfirmation: "Row label. The notice a business is required to display in some jurisdictions. Values yes / no / checking.",
  valueNotPresent: "Row value: we looked and it was absent. A fact about the site.",
  valueNotObservable: "Row value: we could not look. A fact about US, not the site. Must not read as absence.",

  countCookies: "Headline caption under the large number; does not repeat it. Advertising cookies were set while the signal was on. Plural form.",
  countCookiesOne: "Headline, singular form.",
  countCookiesZero: "Headline when none were set.",
  countCookiesByVendors: "Headline caption: third-party cookies set by $VENDORS$ advertising and analytics vendors while the signal was on. The count is grouped by vendor to match the rows below.",
  countFirstPartyVendor: "Supporting line, its own line: $COUNT$ first-party cookies written by ad or analytics scripts. The headline is third-party. Signed visits only.",

  sectionVendors: "Section heading over the per-vendor rows.",
  vendorAsked: "Vendor tag: a script from this vendor called a consent API. Short; fits beside a name.",
  vendorDidNotAsk: "Vendor tag: no consent check could be ATTRIBUTED to this vendor. Deliberately not 'did not check' — attribution often fails.",
  vendorsNoneSeen: "Shown when no vendors were observed at all.",

  stateTagsContainer: "How tags load: through a Google Tag Manager container. $IDS$ is a list of container IDs.",
  stateTagsGtag: "How tags load: directly through gtag.js, with no container. $IDS$ is a list of measurement IDs.",
  stateTagsBoth: "How tags load: both a container and gtag.js. $IDS$ lists both.",
  stateTagsUnidentified: "A Google tag dataLayer exists but neither loader was identified.",
  gtmConsentMode: "Heading over the Consent Mode values. Constant: it names the thing, not its state.",
  gtmConsentModeNoSignals: "Shown under the heading when no Consent Mode command was seen. Lower case; reads as a value.",
  gtmConsentModeHelp: "Tooltip on the help link. Explains what Consent Mode covers and what it does not.",
  gtmStorageTypes: "Sub-heading for the storage-type group, shown only when the container declared one.",

  statePending: "Shown while the page is still loading and observations are still arriving.",
  stateNoData: "The worker answered nothing for this tab: it could not be reached, or no tab was found. Not shown while a page loads.",
  stateNeedsReload:
    "The tab was already open when the extension was installed, updated or re-enabled, so its load was not observed.",
  stateLoadFailed:
    "The top document did not load and the browser showed its own error page, where no content script runs.",
  stateNoAdTech: "No third-party ad or analytics requests at all. NOT a clean bill of health; nothing was observable.",
  stateIneligible: "Any top-level page that is not http or https. Never a real website.",

  tabOverview: "Tab label.",
  tabRequests: "Tab label. Followed by a request count.",
  btnDetails: "Button. Opens more detail.",
  btnLooksWrong: "Button at the foot of the popup. Opens the finding report and repeats its title. Should feel safe to press.",
  btnSettings: "Button/icon label.",
  btnOpenPanel:
    "Icon button in the popup's header, beside Settings: its accessible name and its hover text. Opens the same page in the browser's side panel, which stays open while the reader browses. 'Side panel' is the browser's own name for that area; use the name the browser's menus use in the target language.",
  btnBack: "Button/icon label.",

  settingsTitle: "Screen title.",
  groupSignal: "Settings group heading.",
  settingSendSignal: "Toggle label. Sends only when nothing else is already sending.",
  settingSendSignalDesc: "Explains that turning this off never disables a signal set by the browser or another extension.",
  settingSendSignalNative: "Replaces the description when the browser sends the signal itself, making the toggle inert.",
  settingSendSignalNativeOff: "Replaces the toggle description when the browser implements GPC with it switched off. The toggle stays usable: it still controls this extension's own Sec-GPC header.",
  groupObservation: "Settings group heading.",
  settingObserve: "Toggle label. Whether pages are inspected as the user browses.",
  settingObserveDesc: "States that reading happens locally and nothing is transmitted. A privacy promise; translate precisely.",
  settingBadge: "Toggle label. Whether the count appears on the toolbar icon.",
  groupClassification: "Settings group heading.",
  settingList: "Row label for the vendor classification list and its version.",
  groupAbout: "Settings group heading.",
  linkRepo: "Link to the open-source repository.",
  linkStates: "Link to documentation on which jurisdictions require honoring the signal.",

  firstRunTitle: "Title of the one-time screen, shown to new and returning users alike.",
  firstRunSignalOn: "Returning users only: the extension is sending the signal.",
  firstRunSignalOff: "Returning users only: sending is off.",
  firstRunSignalNative: "Returning users only: the browser sets the signal itself.",
  firstRunSignalNativeOff: "As firstRunSignalNative, when the browser implements GPC with it switched off.",
  firstRunWhy: "Why the extension exists.",
  firstRunBody: "What the reader can see on every page, and that the extension can send the signal when nothing else does.",
  firstRunPromise: "The privacy promise and the one outbound request that qualifies it. Translate precisely.",
  firstRunAsk: "Asks for reports of wrong results. Quotes the btnLooksWrong label.",
  firstRunAccept: "Button dismissing the disclosure.",

  exportSaveSummary: "Button on the download screen. Saves what the Overview shows as a Markdown file, for pasting into a ticket. Names the content first and the format second.",
  exportSaveSummaryHint: "Line under the 'Save summary (Markdown)' button, always visible. Says what the summary holds and that it has no cookie values.",
  exportSave: "Button on the download screen. Saves the log, without cookie values, as a JSON file. Names the content first and the format second: the files hold different things.",
  exportSaveHint: "Line under the 'Save log (JSON)' button, always visible. Says what the log holds and what it leaves out. 'Addresses' are the web addresses (URLs) of requests.",
  exportSaveUnmasked: "Third button on the download screen, never the primary one. Saves the log with cookie values as a JSON file. The only way a cookie value reaches a file.",
  exportSaveUnmaskedHint: "Line under the 'Save log with cookie values (JSON)' button, always visible. Must say that values are included and that the file is sensitive. 'Addresses' are the web addresses (URLs) of requests.",
};

const raw = await readFile(MESSAGES, "utf8");
const messages = JSON.parse(raw);

if (process.argv.includes("--annotate")) {
  let added = 0;
  for (const [key, entry] of Object.entries(messages)) {
    const description = DESCRIPTIONS[key];
    if (!description) {
      console.warn(`WARN: no description written for "${key}"`);
      continue;
    }
    if (entry.description !== description) {
      // Key order matters for readability: message, description, then placeholders.
      const rebuilt = { message: entry.message, description };
      if (entry.placeholders) rebuilt.placeholders = entry.placeholders;
      messages[key] = rebuilt;
      added++;
    }
  }
  await writeFile(MESSAGES, JSON.stringify(messages, null, 2) + "\n");
  console.log(`annotated ${added} messages with translator context`);
  process.exit(0);
}

// --- report ---

async function sourceText() {
  const chunks = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === "dist-ext") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      // manifest.json references strings as __MSG_key__, so it must be scanned too or
      // the extension's own name reports as unused.
      else if ([".ts", ".html", ".json"].includes(extname(e.name))) {
        if (e.name === "messages.json") continue;
        chunks.push(await readFile(full, "utf8"));
      }
    }
  }
  await walk("packages/capture-extension/src");
  await walk("packages/capture-extension/public");
  return chunks.join("\n");
}

const src = await sourceText();
const assigned = new Set(SURFACES.flatMap((s) => s.keys));
const unassigned = Object.keys(messages).filter((k) => !assigned.has(k));
const unused = Object.keys(messages).filter((k) => !src.includes(k));

const lines = [
  "# User-visible strings",
  "",
  "**Generated by `npm run strings` — do not edit.** The source of truth is",
  "`packages/capture-extension/public/_locales/en/messages.json`.",
  "",
  "Every string a person can see, grouped by where it appears rather than by where it lives",
  "in the code, because the reviewer is reading the popup and not the codebase.",
  "",
  "Two rules apply to all of it (CONTRIBUTING.md, Rule 1):",
  "",
  "1. The website is never the subject of a verb about intent. Enforced by `npm run lint:wording`.",
  "2. An absence we observed and an absence we could not look for are different claims and",
  "   must not share a phrase.",
  "",
  `${Object.keys(messages).length} strings. ${Object.values(messages).filter((m) => m.placeholders).length} take placeholders.`,
  "",
];

for (const surface of SURFACES) {
  lines.push(`## ${surface.title}`, "");
  if (surface.note) lines.push(`*${surface.note}*`, "");
  lines.push("| key | string | notes |", "| --- | --- | --- |");
  for (const key of surface.keys) {
    const entry = messages[key];
    if (!entry) {
      lines.push(`| \`${key}\` | **MISSING** | listed here but absent from messages.json |`);
      continue;
    }
    const text = entry.message.replace(/\|/g, "\\|");
    const notes = [];
    if (entry.placeholders) notes.push(`placeholders: ${Object.keys(entry.placeholders).join(", ")}`);
    if (!src.includes(key)) {
      notes.push(PLANNED[key] ? `not yet used — ${PLANNED[key]}` : "**unused**");
    }
    lines.push(`| \`${key}\` | ${text} | ${notes.join(" · ")} |`);
  }
  lines.push("");
}

if (unassigned.length > 0) {
  lines.push("## Ungrouped", "", "Present in messages.json but not assigned to a surface above.", "");
  for (const key of unassigned) lines.push(`- \`${key}\` — ${messages[key].message}`);
  lines.push("");
}

const unexplained = unused.filter((k) => !PLANNED[k]);
if (unused.length > 0) {
  lines.push(
    "## Not currently rendered",
    "",
    "No source file references these. Each is either waiting on a surface that is not built",
    "yet, or dead copy to delete — dead copy gets reviewed as though it ships.",
    "",
  );
  for (const key of unused) {
    lines.push(`- \`${key}\` — ${PLANNED[key] ?? "**no reason recorded; delete or wire up.**"}`);
  }
  lines.push("");
}

await mkdir("docs", { recursive: true });
await writeFile(OUT, lines.join("\n"));

console.log(`wrote ${OUT}: ${Object.keys(messages).length} strings`);
if (unassigned.length > 0) console.warn(`  ${unassigned.length} ungrouped`);
if (unused.length > 0) console.warn(`  ${unused.length} not currently rendered`);
if (unexplained.length > 0) {
  console.warn(`  ${unexplained.length} unexplained: ${unexplained.join(", ")}`);
}
