// SPDX-License-Identifier: GPL-3.0-only
/**
 * Whom a cookie is charged to (1.25.0): one rule, called by every place that asks: the
 * worker's tally, the engine's findings and counts, the Requests tab's mark, probes,
 * refused writes and "its script ran". The rule for a container's writes has to be the
 * same in all of them, or the badge, the rows and the findings disagree about one cookie.
 *
 *   host       a response's cookie, or one written by a script that is not a container:
 *              the responding host's, or the writing script's, classification
 *   owner      written inside a container, and the name is the container owner's own on
 *              the owner's list: charged to the owner, in the category the list gives it
 *   container  written inside a container, and the name is not the owner's: recorded with
 *              the container as its writer, charged to no company, counted nowhere, and
 *              never re-charged by name
 *
 * The container is `containerIdentity(writerScriptUrl)`, never the capture's
 * `writerViaTagManager`, so a capture from before the rule is charged the same way as one
 * after it. The party is the writer's host against the top site in every case, so a
 * container served from the site's own domain (tiq.retailer-i.example) counts nothing.
 */

import type { ContainerIdentity, CookieRecord } from "@gpc-inspector/schema";
import { containerIdentity } from "@gpc-inspector/schema";
import type { Category, Classifier, Entity, Party } from "./classifier.js";
import { COUNTING_CATEGORIES } from "./classifier.js";
import type { OwnerNames } from "./owner-names.js";

export type CookieCharge =
  | {
      readonly kind: "host";
      readonly party: Party;
      readonly category: Category;
      readonly entity: Entity | null;
      /**
       * The registrable domain of the charged host (1.26.0): what a cookie from a domain
       * the list names no company for is kept under. Absent where the caller had none.
       */
      readonly domain?: string;
    }
  | { readonly kind: "owner"; readonly party: Party; readonly category: Category; readonly entity: Entity; readonly container: ContainerIdentity }
  | { readonly kind: "container"; readonly party: Party; readonly container: ContainerIdentity };

/** Whether a record was written by a page script rather than set by a response. */
function scriptWritten(cookie: Pick<CookieRecord, "via">): boolean {
  return cookie.via === "documentCookie" || cookie.via === "cookieStore";
}

/**
 * Whom a cookie is charged to. `url` is the responding host's, or the writing script's:
 * the URL of the observation the cookie arrived on, which for a script-written cookie is
 * its writer's (when no writer was found, the writing frame's host in a cross-site frame,
 * else the page's own URL).
 */
export function cookieCharge(
  cookie: Pick<CookieRecord, "name" | "via" | "writerScriptUrl">,
  url: string,
  topSite: string,
  classifier: Classifier,
  owners: OwnerNames,
): CookieCharge {
  const writer = cookie.writerScriptUrl;
  const container = scriptWritten(cookie) && typeof writer === "string" && writer !== "" ? containerIdentity(writer) : null;
  if (container === null) {
    const cls = classifier.classify(url, topSite);
    return { kind: "host", party: cls.party, category: cls.category, entity: cls.entity, domain: cls.registrableDomain };
  }
  const party = classifier.classify(writer as string, topSite).party;
  const own = owners.match(container.manager, cookie.name);
  return own === null
    ? { kind: "container", party, container }
    : { kind: "owner", party, category: own.category, entity: own.entity, container };
}

/**
 * The one test for "the count includes it": charged to a company or a host, third party,
 * in a category that counts. A container charge never counts.
 */
export function isCounted(charge: CookieCharge): boolean {
  return charge.kind !== "container" && charge.party === "third" && COUNTING_CATEGORIES.has(charge.category);
}
