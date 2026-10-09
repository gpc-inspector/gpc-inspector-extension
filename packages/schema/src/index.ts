// SPDX-License-Identifier: GPL-3.0-only
/**
 * @gpc-inspector/schema — the versioned contract between capture and engine.
 *
 * Public surface. Everything the engine, capture layer, and UI need to speak the same
 * language lives here. No behavior except canonicalization and hashing, both of which
 * are deterministic and dependency-free.
 */

export { SCHEMA_VERSION } from "./version.js";
export type { SchemaVersion } from "./version.js";

export {
  KNOWN_RESOURCE_TYPES,
  KEPT_COOKIE_RESPONSE_CAP,
  isCookieDeletion,
  isCookieSet,
  hostOf,
} from "./observation.js";
export type {
  KnownResourceType,
  ResourceType,
  CaptureMethod,
  Header,
  SameSite,
  CookieRecord,
  JarState,
  CookieCaptureCoverage,
  NetworkObservation,
  KeptCookieResponse,
  ScriptInsertionVia,
  ScriptInsertionLoader,
  ScriptInsertion,
  ScriptInsertionCoverage,
} from "./observation.js";

export type {
  SignalSource,
  PropertyValue,
  ReadTrackingState,
  SignalObservation,
  ReadAttribution,
  ConsentApi,
  ConsentApiCall,
  GppObservation,
  GppSectionFields,
  UsPrivacyObservation,
  InvalidWireValue,
  WireValue,
  TcfObservation,
  GtmObservation,
  EffectiveConsentEntry,
  ConsentValue,
  GtmConsentState,
  ConfirmationNoticeState,
  CaptureCapabilities,
  WellKnownGpc,
  Tallies,
  EntityTally,
  EntityCategoryTally,
  CookieDetail,
  ContainerTally,
  UnlistedDomainTally,
  FirstPartyTally,
} from "./signal.js";
export {
  ACTIVE_RESOURCE_TYPES,
  COOKIE_DETAIL_CAP,
  CONTAINER_COOKIE_CAP,
  CONTAINER_FRAME_URL_CAP,
  UNLISTED_DOMAIN_CAP,
  UNLISTED_COOKIE_CAP,
  UNLISTED_HOST_CAP,
  FIRST_PARTY_COOKIE_CAP,
  REQUEST_LOST_COOKIE_CAP,
  callCount,
  wireValuesOf,
  entityCategoryKey,
  isTallied,
  unlistedDomainHasRow,
} from "./signal.js";

export type {
  CaptureContext,
  IncompleteReason,
  ObservationSet,
  OwnerListProvenance,
} from "./observation-set.js";
export { lostKeptRecords } from "./observation-set.js";

export type {
  FindingFlag,
  FindingArtifact,
  FindingEntity,
  Finding,
  LoaderIdentity,
  LoaderRoute,
} from "./finding.js";

export type {
  Provenance,
  RedactionState,
  EvidenceBundle,
} from "./evidence-bundle.js";

export { containerIdentity, isTagManagerFrame, containerKey, isGoogleTagScript, googleTagObserved, consentModeNeedsDataLayer } from "./tag-managers.js";
export type { TagManagerKind, ContainerIdentity } from "./tag-managers.js";

export { canonicalize, assertJson, CanonicalizationError } from "./canonicalize.js";
export { redact, redactUrl, REDACTED } from "./redact.js";
export {
  sha256Canonical,
  computeBundleHash,
  sealBundle,
  verifyBundle,
} from "./hash.js";
