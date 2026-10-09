// SPDX-License-Identifier: GPL-3.0-only
/**
 * The download screen: three files from one capture, as pure decisions.
 *
 * Cookie values, `Cookie` and `Authorization` header values and query strings reach a
 * file only when the reader chose the button that says so. Nothing here reads a setting or
 * anything left from an earlier opening: each file is decided by the button pressed.
 *
 * Kept away from chrome.* and the DOM, where it can be tested. popup.ts draws the buttons
 * and hands the file to the browser.
 */
import type { EvidenceBundle, ObservationSet } from "@gpc-inspector/schema";
import { evidenceFileName } from "./feedback.js";

/** What a button saves. Only `record-with-values` holds what masking removes. */
export type ExportFileKind = "summary" | "record" | "record-with-values";

export interface ExportButton {
  readonly id: string;
  readonly file: ExportFileKind;
  readonly labelKey: string;
  /** The line under the button, always visible: what the file holds. */
  readonly hintKey: string;
}

/** In the order they are stacked. The first is the primary button; the last never is. */
export const EXPORT_BUTTONS: readonly ExportButton[] = [
  { id: "export-summary", file: "summary", labelKey: "exportSaveSummary", hintKey: "exportSaveSummaryHint" },
  { id: "export-save", file: "record", labelKey: "exportSave", hintKey: "exportSaveHint" },
  { id: "export-save-values", file: "record-with-values", labelKey: "exportSaveUnmasked", hintKey: "exportSaveUnmaskedHint" },
];

/**
 * The export awaiting a press: the record as it stood when the screen opened. In the panel
 * a later refresh may replace the record on screen, and what is saved has to be what the
 * preview described.
 *
 * It keeps no record of what was saved. A file reaches the browser through a link, which
 * cannot tell a save from a cancelled save dialog, so every button can always be pressed
 * again and none says afterward that its file was written.
 */
export interface PendingExport {
  readonly obs: ObservationSet;
}

/**
 * A fresh opening. A record from a state stored before captures had an id gets one here,
 * once, so every file from this screen names the same scan.
 */
export function openPendingExport(obs: ObservationSet, newId: () => string = () => crypto.randomUUID()): PendingExport {
  return {
    obs: obs.context.scanId === undefined ? { ...obs, context: { ...obs.context, scanId: newId() } } : obs,
  };
}

/** How a file is made: popup.ts passes its sealer and the summary of its view. */
export interface ExportMakers {
  seal(obs: ObservationSet, masked: boolean): Promise<EvidenceBundle>;
  /** The summary of the record, given the masked bundle whose hash its footer names. */
  summary(obs: ObservationSet, maskedBundle: EvidenceBundle): string;
}

export interface ExportFile {
  readonly name: string;
  readonly text: string;
  readonly type: string;
}

export async function exportFile(
  pending: PendingExport,
  file: ExportFileKind,
  makers: ExportMakers,
): Promise<ExportFile> {
  // Masked unless this is the one button that says it holds values.
  const bundle = await makers.seal(pending.obs, file !== "record-with-values");
  if (file === "summary") {
    return {
      name: evidenceFileName(bundle, "summary"),
      text: makers.summary(pending.obs, bundle),
      type: "text/markdown",
    };
  }
  return { name: evidenceFileName(bundle), text: JSON.stringify(bundle, null, 2), type: "application/json" };
}
