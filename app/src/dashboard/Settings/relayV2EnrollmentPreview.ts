import {
  RELAY_V2_REQUIRED_CAPABILITIES,
  createRelayV2EnrollmentState,
  relayV2EnrollmentReducer,
  type RelayV2EnrollmentEvent,
  type RelayV2EnrollmentState,
} from "./relayV2EnrollmentModel";

const previewEvents: readonly RelayV2EnrollmentEvent[] = [
  {
    type: "v2CredentialReferenceObserved",
    credentialReference: "preview-host-grant-reference",
  },
  {
    type: "hostRegistered",
    hostId: "mac-admin-preview",
    connectorId: "preview-connector",
  },
  {
    type: "capabilityIntersectionObserved",
    capabilities: RELAY_V2_REQUIRED_CAPABILITIES,
  },
  {
    type: "enrollmentCreated",
    review: {
      enrollment: {
        enrollmentId: "preview-enrollment",
        enrollmentCode: "twenroll2.preview-only-not-a-live-code",
        expiresAtMs: Date.now() + 5 * 60_000,
      },
      display: {
        issuerUrl: "https://relay.preview.invalid",
        relayUrl: "wss://relay.preview.invalid/client",
        hostId: "mac-admin-preview",
        deviceLabel: "Preview Android",
      },
    },
  },
];

export const previewRelayV2EnrollmentState: RelayV2EnrollmentState = previewEvents.reduce(
  relayV2EnrollmentReducer,
  createRelayV2EnrollmentState(false),
);
