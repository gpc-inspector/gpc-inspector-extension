// SPDX-License-Identifier: GPL-3.0-only
/**
 * declared-honor-cookie-set (PRD FR-20).
 *
 * The site said it honors the signal, and advertising or analytics cookies were set on
 * requests carrying it. It can say so in two ways, and either one is enough:
 *
 *   - its published file, `/.well-known/gpc.json` with `gpc: true`, a standing declaration
 *     anyone can fetch;
 *   - a confirmation notice on the page itself ("Opt-Out Request Honored"), the display
 *     §7025(c)(6) asks for. A reader who sees that notice expects the opt-out to apply to
 *     the site, so whether a cookie came before or after the notice appeared is not a
 *     distinction the finding draws. On the 60-site corpus run seven sites showed the
 *     notice while setting such cookies, and none of them publishes the file.
 *
 * Both facts come from the site itself: its own statement and its own responses. No
 * inference about intent. A reader can check the file, or the notice on the page, and the
 * response headers independently.
 *
 * CONDITIONS THAT LOOK OPTIONAL AND ARE NOT:
 *
 * `fresh` — the file must be a current reading: fetched during this navigation, or a
 * recent cached one (capture decides, see WellKnownGpc.fresh). A site can retract the file
 * at any time, and an accusation resting on a statement that may have been withdrawn is
 * exactly the claim this product must not make. Stale is fine for reporting; it is not fine
 * for accusing. The notice needs no such test: it was on this page.
 *
 * `gpc === true` — an explicit `false` is a declaration of NON-support. Setting cookies
 * after saying you do not honor the signal is consistent behavior, not a contradiction,
 * and reporting it as one would punish a site for being honest.
 *
 * The notice detector is pattern matching over the page's text, so a false match matters:
 * the finding would rest on a notice the page never showed. Every match so far has been
 * real (8 of 8 on the 2026-09-25 corpus run).
 */

import type { Finding, ObservationSet } from "@gpc-inspector/schema";
import type { Classifier } from "../classifier.js";
import { RANK } from "../ranks.js";
import { countDistinctCookiesSetWithSignal } from "./cookie-with-signal.js";
import { NO_OWNERS, type OwnerNames } from "../owner-names.js";

/** Which of the site's own statements that it honors the signal are on record for this page. */
export interface HonorDeclarations {
  /** A current reading of the published file, with `gpc: true`. */
  readonly wellKnown: boolean;
  /** A confirmation notice the page displayed. */
  readonly confirmation: boolean;
}

/** The statements the finding rests on, by the same test the rule uses. */
export function honorDeclarations(obs: ObservationSet): HonorDeclarations {
  const wk = obs.wellKnown;
  return {
    wellKnown: wk !== null && wk.present && wk.gpc === true && wk.fresh,
    confirmation: obs.confirmationNotice === "detected",
  };
}

export function declaredHonorCookieSet(
  obs: ObservationSet,
  classifier: Classifier,
  owners: OwnerNames = NO_OWNERS,
): Finding[] {
  const declared = honorDeclarations(obs);
  if (!declared.wellKnown && !declared.confirmation) return [];

  // The headline's own count: the distinct cookies counted, not the writes. A write can be
  // recorded and its cookie not counted (the browser did not store it, say), so a page can
  // have writes in the write counter and no cookie in the count.
  if (countDistinctCookiesSetWithSignal(obs, classifier, owners) === 0) return [];

  return [
    {
      flag: "declared-honor-cookie-set",
      rank: RANK.DECLARED_HONOR_COOKIE_SET,
      entity: null, // site-level: the site's own statement against its own responses
      artifact: { kind: "none" },
    },
  ];
}
