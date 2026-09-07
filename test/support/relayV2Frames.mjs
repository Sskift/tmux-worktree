const codec = await import("../../dist/relay/v2/codec.js");

// Encode a frame for the carrier (host->broker) channel.
export function carrierBytes(frame) {
  return codec.encodeRelayV2WebSocketFrame("carrier", frame);
}

// Encode a frame for the public (broker->client) channel.
export function publicBytes(frame) {
  return codec.encodeRelayV2WebSocketFrame("public", frame);
}
