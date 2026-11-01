// Where each kind of field comes from, for the per-field tags on every tab. This follows FIELD_SOURCES in server/src/data.js (the source of truth):
// deck = a Ping slide-52 claim, reading = the lab's reading of it, invented = the lab's own, nothing in the deck. A tag beside a field says which.
export const STAGE_SOURCE = {
  request: "invented",
  token: "reading",
  surface: "deck",
  application: "deck",
  action: "deck",
  "end-user": "deck",
  "attended-unattended": "deck",
  "request-inspection": "deck",
  call: "invented",
  "reply-inspection": "deck",
};
