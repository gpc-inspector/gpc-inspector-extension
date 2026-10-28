#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * Wording lint — enforces PRD Appendix B: "the website is never the subject of a verb
 * about intent." Runs in CI (NFR-10) over the UI's _locales JSON. Fails the build if any
 * user-facing string contains banned verdict vocabulary. It also fails on British
 * spellings, in descriptions as well as messages (see BRITISH_SPELLINGS), and on the term
 * rules, one name per thing (see TERM_RULES).
 *
 * This is deliberately dumb and strict. It matches whole words, case-insensitively, and
 * has an allowlist for the narrow cases where a banned word may legitimately appear
 * (e.g. quoting a regulation). Cleverness here would let a violation through; the whole
 * value is that it cannot be argued with.
 *
 * Usage:
 *   node scripts/wording-lint.mjs                 # lint packages/ui/_locales/**\/*.json
 *   node scripts/wording-lint.mjs --self-test     # verify the linter itself works
 *   node scripts/wording-lint.mjs path/to/dir     # lint a specific directory
 */

import { readdir, readFile } from "node:fs/promises";
import { join, extname } from "node:path";

/**
 * Banned words (Appendix B "Never emit" column). Matched as whole words, case-insensitive.
 * "honored" is banned as a claim about a site; it may appear only inside an allowlisted
 * key that quotes regulatory text or names what a site's own message says.
 */
const BANNED = [
  "ignored",
  "ignores",
  "refused",
  "refuses",
  "defied",
  "defies",
  "honored", // allowed only in ALLOW_KEYS: a regulation quote or a site's own message
  "honors",
  "violates",
  "violation",
  "illegal",
  "unlawful",
  "noncompliant",
  "non-compliant",
  "compliant", // "compliant" as our claim is also out; regulation quotes use ALLOW_KEYS
  "spying",
  "spies",
  "caught",
  "busted",
  "exposed",
  // "tracker" / "trackers" assert a BEHAVIOR we have not observed. What we see is a
  // Set-Cookie header from a domain a third party categorizes as Advertising — narrower
  // than "this thing tracks you", and the narrower claim is the one we can defend when a
  // site's lawyer reads it.
  //
  // It is also not Disconnect's vocabulary: their taxonomy is Advertising, Analytics,
  // Social, Content, Fingerprinting. "Tracking protection" is their product name, not a
  // category. Using "tracker" would be asserting it on our own authority, which is exactly
  // what the attribution model exists to avoid.
  //
  // The word itself is banned, not only the phrase "known tracker": "ad trackers" makes the
  // same claim.
  "tracker",
  "trackers",
  // NOTE: "issue tracker" is exempted below. The ban is about asserting that a domain
  // tracks people; a bug tracker is an unrelated sense of the word, and contorting the
  // feedback copy around a homonym would make it worse for no gain.
  // "sells your data" / "tracking you" — phrase-level, checked separately below
];

/**
 * Phrases containing a banned word in an unrelated sense.
 *
 * Checked before the word list and removed from the text under test. "Issue tracker" is the
 * only current member: the ban on "tracker" exists to stop us asserting that a domain
 * tracks people, and a bug tracker is a different word that happens to look the same.
 */
const EXEMPT_PHRASES = ["issue tracker", "issue trackers", "bug tracker", "bug trackers"];

/**
 * Characters banned from a `.message` (never from a description, which is for translators
 * and may use whatever punctuation reads best). Em and en dashes and the ellipsis character
 * are the typographic tells of generated copy, and a popup string never needs them. Write
 * two sentences, or a comma, or a colon.
 */
const BANNED_CHARS = [
  ["\u2014", "em dash"],
  ["\u2013", "en dash"],
  ["\u2026", "ellipsis character"],
];

/**
 * Words banned from a `.message`, and only from a message. The category is Advertising,
 * Disconnect's name for it, and a popup that says "ad vendors" in one place and
 * "advertising" in another reads as two things. Descriptions are notes to a translator and
 * may say "ad".
 */
const BANNED_IN_MESSAGES = ["ad", "ads"];

/** Phrase-level bans (substring, case-insensitive). */
const BANNED_PHRASES = [
  "sells your data",
  "selling your data",
  "tracking you",
  "spying on you",
  "known tracker",
  "caught them",
  // "privacy signal" names two unrelated artifacts at once, and the popup shows both: GPC
  // (the Sec-GPC header and the navigator property, which the BROWSER sends) and the
  // privacy strings (GPP/USP/TCF, which the SITE broadcasts about the reader). A reader
  // cannot tell which is meant, and neither can a translator.
  //
  // The rule this enforces: name the specific artifact — GPC, GPP, USP, TCF — whenever you
  // mean a specific one. "Privacy string" stays available as the generic for GPP/USP/TCF;
  // GPC is never inside that generic, because it is not a string.
  //
  // Same class of error as the verdict vocabulary above, one level down: an ambiguous noun
  // rather than a loaded verb, and just as invisible to review by eye.
  "privacy signal",
];

/**
 * American English only, in messages and descriptions alike: the audience is US, and a
 * mixed spelling in a public string reads as carelessness. Each pattern names a British
 * form; the report says which word matched. The -ise stems are listed rather than matched
 * generically because "surprise", "exercise" and "premise" are spelled the same on both
 * sides.
 */
const BRITISH_SPELLINGS = [
  /honour/iu,
  /licence/iu,
  /colour/iu,
  /behaviour/iu,
  /favour/iu,
  /(label|signal|cancel|model|travel)l(ed|ing|er)(?![\p{L}])/iu, // no leading boundary: "relabelled", "mislabelled"
  /(?<![\p{L}])(centre|defence|offence|grey|catalogue|judgement|amongst|whilst|artefact|programme|sceptic|learnt|fulfil|enrol)s?(?![\p{L}])/iu,
  /(organis|prioritis|categoris|optimis|minimis|maximis|standardis|recognis|realis|summaris|localis|internationalis|normalis|serialis|initialis|authoris|customis|finalis|utilis|itemis|capitalis|visualis|emphasis|characteris|generalis|specialis|neutralis|memoris|harmonis|stabilis|synchronis|randomis|sanitis|tokenis|scrutinis|penalis|criticis|apologis)(e|ed|es|ing|ation|ations|able|er)(?![\p{L}])/iu,
];

/**
 * Term rules, for messages only: one name per thing, so a reader never wonders whether two
 * words mean two things. Each rule is a pattern, the key test where the term is allowed
 * (if anywhere), and the rule in a line for the report. Keys are matched without the
 * ".message" suffix. Only the rules a pattern can decide are here; the rest ("set" against
 * "written", one name per artifact in a sentence) is checked by reading.
 */
/** A vendor row hover text shown only on a domain row: the Domain variants and the unlisted state. */
const isDomainHelp = (key) => /^vendorGpc\w*Help\w*Domain(Capped)?$/.test(key) || key === "vendorGpcUnlistedDomainHelp";

const TERM_RULES = [
  {
    re: /(?<![\p{L}])GPC not set/iu,
    why: 'say "GPC field not set" (the GPP string\'s) or "GPC signal not set" (the browser\'s)',
  },
  {
    re: /(?<![\p{L}])(read|reads|reading) the GPP consent API/iu,
    why: 'a script "called the GPP consent API (__gpp)"; "read GPC" is the umbrella for a call or a property read',
  },
  {
    re: /(?<![\p{L}])(call|calls|called|calling) the GPP consent API(?! \(__gpp\))/iu,
    why: 'name the function: "called the GPP consent API (__gpp)"',
  },
  {
    re: /(?<![\p{L}])USP(?![\p{L}])/u,
    allow: (key) => key === "labelUsPrivacy" || key === "vendorUspChecked",
    why: '"US Privacy string" in a sentence; "USP" only in the row label and the vendor line\'s "USP read"',
  },
  {
    re: /tag-manager container/iu,
    why: '"tag container" on first mention, "container" after',
  },
  {
    re: /(?<!Google )(?<![\p{L}])tag[ -]managers?(?![\p{L}])/iu,
    why: '"tag container"; "Tag Manager" only in the product name Google Tag Manager',
  },
  {
    re: /(?<![\p{L}])(consent tools?|CMPs?)(?![\p{L}])/iu,
    why: '"consent manager" for the page\'s CMP',
  },
  {
    re: /(?<![\p{L}])(websites?|webpages?)(?![\p{L}])/iu,
    why: '"site" or "page"',
  },
  {
    re: /(?<![\p{L}])we(?![\p{L}])/iu,
    allow: (key) => /^(firstRun|report|export)/.test(key) || /^setting\w*Report/.test(key),
    why: '"we" only in first run and feedback strings; a measurement says "the extension" or uses a passive',
  },
  {
    re: /(?<![\p{L}])no (vendors?|compan(y|ies))(?![\p{L}])/iu,
    allow: (key) => key === "vendorGpcUnlistedDomain" || key === "vendorsGroupUnlisted",
    why: '"No company listed" (the column) and "No company found for this domain" (the group) are the only ones',
  },
  // A vendor row's hover text names its row: "this vendor" on a company row, "this domain"
  // on a row for a domain the list names no company for (the keys ending in Domain, see
  // DOMAIN_HELP in view-model.ts). "This tag" is for a sentence about what a container
  // loaded, so it needs a container in the same string.
  {
    re: /(?<![\p{L}])this domain(?![\p{L}])/iu,
    only: (key) => /^vendorGpc\w*Help/.test(key) && !isDomainHelp(key),
    why: 'a company row\'s hover text says "this vendor"',
  },
  {
    re: /(?<![\p{L}])this vendor(?![\p{L}])/iu,
    only: (key) => isDomainHelp(key),
    why: 'a domain row\'s hover text says "this domain"',
  },
  {
    re: /^(?!.*container).*(?<![\p{L}])this tag(?![\p{L}])/isu,
    only: (key) => /^vendorGpc\w*Help/.test(key),
    why: '"this tag" only where the sentence is about what a container loaded; otherwise the row\'s noun',
  },
];

/**
 * Locale keys permitted to contain an otherwise-banned word because they quote
 * regulatory or standards text verbatim, or name what a site's own message says. The
 * extension never makes the claim itself. Keep this list tiny and reviewed.
 */
const ALLOW_KEYS = new Set([
  "regulation.7025c6.quote", // may contain "honored" when quoting the CCPA reg
  "about.disclaimer.notLegalAdvice",
  // "honored" as the site's own message: the setting looks for one, and quotes a wording.
  "settingConfirmation",
  "settingConfirmationDesc",
]);

const wordRe = (w) =>
  new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(w)}(?![\\p{L}\\p{N}_])`, "iu");

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Recursively collect { keyPath, value } for every string in a JSON value. */
function collectStrings(value, keyPath, out) {
  if (typeof value === "string") {
    out.push({ keyPath, value });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => collectStrings(v, `${keyPath}[${i}]`, out));
  } else if (value && typeof value === "object") {
    // Chrome _locales format: { "key": { "message": "..." } }. We walk generically.
    for (const [k, v] of Object.entries(value)) {
      collectStrings(v, keyPath ? `${keyPath}.${k}` : k, out);
    }
  }
}

function lintString(keyPath, value) {
  const violations = [];

  // Remove phrases where a banned word appears in an unrelated sense before testing. Doing
  // it here rather than per-rule means the exemption applies to both the word and phrase
  // passes, and cannot be forgotten when a rule is added.
  let scrubbed = value;
  for (const phrase of EXEMPT_PHRASES) {
    scrubbed = scrubbed.replace(new RegExp(phrase, "gi"), " ");
  }
  const lower = scrubbed.toLowerCase();

  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) {
      violations.push({ keyPath, value, matched: phrase, kind: "phrase" });
    }
  }
  if (keyPath.endsWith(".message")) {
    for (const [ch, name] of BANNED_CHARS) {
      if (value.includes(ch)) {
        violations.push({ keyPath, value, matched: name, kind: "character" });
      }
    }
    for (const word of BANNED_IN_MESSAGES) {
      if (wordRe(word).test(scrubbed)) violations.push({ keyPath, value, matched: word, kind: "word" });
    }
    const key = keyPath.replace(/\.message$/, "");
    for (const rule of TERM_RULES) {
      if (rule.only && !rule.only(key)) continue;
      if (rule.allow && rule.allow(key)) continue;
      const m = value.match(rule.re);
      if (m) violations.push({ keyPath, value, matched: m[0].slice(-40), kind: "term", why: rule.why });
    }
  }
  for (const word of BANNED) {
    if (wordRe(word).test(scrubbed)) {
      // strip the _locales ".message" suffix when checking the allowlist
      const baseKey = keyPath.replace(/\.message$/, "");
      if (ALLOW_KEYS.has(baseKey)) continue;
      violations.push({ keyPath, value, matched: word, kind: "word" });
    }
  }
  for (const re of BRITISH_SPELLINGS) {
    const m = value.match(re);
    if (m) violations.push({ keyPath, value, matched: m[0], kind: "spelling" });
  }
  return violations;
}

async function findJsonFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // a directory that does not exist is not an error
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await findJsonFiles(full)));
    else if (extname(e.name) === ".json") out.push(full);
  }
  return out;
}

async function lintDir(dir) {
  const files = await findJsonFiles(dir);
  const all = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      all.push({ file, keyPath: "(file)", value: "", matched: `invalid JSON: ${err.message}`, kind: "parse" });
      continue;
    }
    const strings = [];
    collectStrings(json, "", strings);
    for (const { keyPath, value } of strings) {
      for (const v of lintString(keyPath, value)) all.push({ file, ...v });
    }
  }
  return all;
}

function report(violations) {
  if (violations.length === 0) {
    console.log("wording-lint: clean.");
    return 0;
  }
  console.error(`wording-lint: ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}`);
    console.error(`    key:     ${v.keyPath}`);
    console.error(`    matched: "${v.matched}" (${v.kind})`);
    if (v.why) console.error(`    rule:    ${v.why}`);
    console.error(`    string:  ${JSON.stringify(v.value)}\n`);
  }
  console.error("The site is never the subject of a verb about intent, and each thing has one name. State the artifact instead.");
  return 1;
}

async function selfTest() {
  const cases = [
    { key: "x.message", val: "The site ignored your signal", shouldFlag: true },
    { key: "x.message", val: "This site is non-compliant", shouldFlag: true },
    { key: "x.message", val: "known tracker on this page", shouldFlag: true },
    { key: "x.message", val: "sells your data to partners", shouldFlag: true },
    { key: "x.message", val: "doubleclick.net returned Set-Cookie: IDE", shouldFlag: false },
    { key: "x.message", val: "The extension did not find a confirmation notice on this page", shouldFlag: false },
    // "Advertising", never "ad" or "ads", in a message; a description may say either.
    { key: "x.message", val: "3 ad cookies were set while your signal was on", shouldFlag: true },
    { key: "x.message", val: "Ads were loaded through a container", shouldFlag: true },
    { key: "x.message", val: "3 advertising cookies were set while your signal was on", shouldFlag: false },
    { key: "x.message", val: "cookies set by advertising or analytics vendors that loaded", shouldFlag: false },
    { key: "x.description", val: "Heading over the ad vendors", shouldFlag: false },
    { key: "regulation.7025c6.quote.message", val: "must display whether it has honored the request", shouldFlag: false },
    { key: "x.message", val: "the honored guest list", shouldFlag: true }, // "honored" outside allowlist
    { key: "x.message", val: "whether a tag checked your privacy signal", shouldFlag: true },
    { key: "x.message", val: "whether a tag checked your GPC signal", shouldFlag: false },
    // The generic noun for GPP/USP/TCF stays legal; only "privacy SIGNAL" is banned.
    { key: "x.message", val: "No privacy strings observed", shouldFlag: false },
    // Typographic markers are banned from messages, and only from messages.
    { key: "x.message", val: "never \u2014 but the string records it", shouldFlag: true },
    { key: "x.message", val: "Checking this page\u2026", shouldFlag: true },
    { key: "x.description", val: "Row value \u2014 a fact about the site", shouldFlag: false },
    { key: "x.message", val: "Checking this page", shouldFlag: false },
    // American English, in descriptions as much as messages.
    { key: "x.message", val: "the colour of the icon", shouldFlag: true },
    { key: "x.description", val: "what a vendor honouring the signal looks like", shouldFlag: true },
    { key: "x.description", val: "Relabelled 2026-09-04", shouldFlag: true },
    { key: "x.message", val: "the color of the icon", shouldFlag: false },
    { key: "x.message", val: "no surprise: the exercise reads the premise", shouldFlag: false },
    // Term rules, messages only.
    { key: "x.message", val: "Read GPP, GPC not set", shouldFlag: true },
    { key: "x.message", val: "Read GPP, GPC field not set", shouldFlag: false },
    { key: "x.message", val: "GPC property not set", shouldFlag: false },
    { key: "x.message", val: "This vendor read the GPP consent API (__gpp).", shouldFlag: true },
    { key: "x.message", val: "This vendor called the GPP consent API.", shouldFlag: true },
    { key: "x.message", val: "This vendor called the GPP consent API (__gpp).", shouldFlag: false },
    { key: "x.message", val: "A script read GPC through the GPP consent API.", shouldFlag: false },
    { key: "x.message", val: "The USP string differs", shouldFlag: true },
    { key: "vendorUspChecked.message", val: "USP read: $STATE$", shouldFlag: false },
    { key: "x.message", val: "No tag in this page's tag-manager container read it", shouldFlag: true },
    { key: "x.message", val: "loaded through the tag manager", shouldFlag: true },
    { key: "x.message", val: "loaded through Google Tag Manager ($ID$)", shouldFlag: false },
    { key: "x.message", val: "The page's consent tool answered", shouldFlag: true },
    { key: "x.message", val: "The page's CMP answered", shouldFlag: true },
    { key: "x.message", val: "The page's consent manager answered", shouldFlag: false },
    { key: "x.message", val: "Check each website's published GPC file", shouldFlag: true },
    { key: "x.description", val: "Never shown on a real website.", shouldFlag: false },
    { key: "stateCaptureUnavailable.message", val: "We could not observe $WHAT$.", shouldFlag: true },
    { key: "vendorGpcNotReadHelp.message", val: "This tag ran, and we did not observe it", shouldFlag: true },
    { key: "firstRunAsk.message", val: "if what we report doesn't look right", shouldFlag: false },
    { key: "settingReportBugDesc.message", val: "we read nothing", shouldFlag: false },
    { key: "settingSendSignalDesc.message", val: "we send the header", shouldFlag: true },
    { key: "x.message", val: "Weekly, as we were", shouldFlag: true },
    { key: "x.message", val: "Weekly reports", shouldFlag: false },
    { key: "x.message", val: "No vendors to list.", shouldFlag: true },
    { key: "x.message", val: "This page contacted more domains with no company", shouldFlag: true },
    { key: "vendorsGroupUnlisted.message", val: "No company found for this domain", shouldFlag: false },
    { key: "vendorGpcNotReadHelp.message", val: "This domain ran", shouldFlag: true },
    { key: "vendorGpcNotReadHelpDomain.message", val: "This vendor ran", shouldFlag: true },
    { key: "vendorGpcNotReadHelpDomain.message", val: "A script from this domain ran", shouldFlag: false },
    { key: "vendorGpcCheckUnavailableHelpDomainCapped.message", val: "this domain's requests", shouldFlag: false },
    { key: "vendorGpcReadPropertyHelp.message", val: "This tag read navigator.globalPrivacyControl.", shouldFlag: true },
    { key: "vendorGpcCheckUnattributableHelpContainer.message", val: "The tag container that loaded this tag read GPC.", shouldFlag: false },
  ];
  let failures = 0;
  for (const c of cases) {
    const flagged = lintString(c.key, c.val).length > 0;
    const ok = flagged === c.shouldFlag;
    if (!ok) {
      failures++;
      console.error(`SELF-TEST FAIL: ${JSON.stringify(c.val)} expected shouldFlag=${c.shouldFlag}, got ${flagged}`);
    }
  }
  if (failures === 0) {
    console.log(`wording-lint self-test: all ${cases.length} cases pass.`);
    return 0;
  }
  return 1;
}

const arg = process.argv[2];
let code = 0;
if (arg === "--self-test") {
  code = await selfTest();
} else {
  const dir = arg ?? "packages/ui/_locales";
  code = report(await lintDir(dir));
}
process.exit(code);
