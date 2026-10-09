// SPDX-License-Identifier: GPL-3.0-only
/**
 * The Sec-GPC header rule (PRD FR-1).
 *
 * ONE broad declarativeNetRequest rule, `operation: "set"`, on all resource types.
 *
 * Why `set` and never `append`: `Sec-GPC` has exactly one valid value. Appending would
 * produce `Sec-GPC: 1, 1` when another extension also sets it, which is spec-invalid and
 * would be read as absent — turning two privacy extensions into zero signals. `set` is
 * idempotent under collision.
 *
 * Why one broad rule rather than per-host rules: Chrome caps dynamic rules, and a
 * per-host design hits that ceiling on a normal browsing session. The signal is global
 * (per D12 there are no per-site overrides), so one rule expresses the whole policy.
 *
 * Chrome permits modifying `Sec-` prefixed request headers through DNR — it uses a
 * deny-list model, and `Sec-GPC` is not on it. This is confirmed by v0.1.4 shipping the
 * same rule shape since 2024. Safari uses an allow-list and rejects it, which is why
 * Safari is out of scope.
 */

export const GPC_RULE_ID = 1;

/** All resource types the rule applies to. Enumerated rather than omitted so the intent
 *  is explicit and a Chrome addition to the enum doesn't silently change coverage. */
const ALL_RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "other",
] as unknown as chrome.declarativeNetRequest.ResourceType[];

export function buildGpcRule(): chrome.declarativeNetRequest.Rule {
  return {
    id: GPC_RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: [
        {
          header: "Sec-GPC",
          operation: "set" as chrome.declarativeNetRequest.HeaderOperation,
          value: "1",
        },
      ],
    },
    condition: {
      urlFilter: "*",
      resourceTypes: ALL_RESOURCE_TYPES,
    },
  };
}

/** Install the rule. Idempotent: removes any existing rule with the same id first. */
export async function enableGpcHeader(): Promise<void> {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [GPC_RULE_ID],
    addRules: [buildGpcRule()],
  });
}

/** Remove the rule. Used when the user turns sending off, or when another source owns
 *  the signal (D10: we only ever govern our own assertion). */
export async function disableGpcHeader(): Promise<void> {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [GPC_RULE_ID],
  });
}

/** Whether our rule is currently installed. */
export async function isGpcHeaderEnabled(): Promise<boolean> {
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  return rules.some((r) => r.id === GPC_RULE_ID);
}

/**
 * Verify the rule was accepted (PRD §8: DNR rejects the Sec-GPC rule → fail loudly).
 * A browser that silently refuses the rule must never let us present observations as
 * signal-on, so callers surface this rather than swallowing it.
 */
export async function verifyGpcRuleInstalled(): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  try {
    const installed = await isGpcHeaderEnabled();
    if (!installed) {
      return { ok: false, reason: "rule absent after update" };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}
