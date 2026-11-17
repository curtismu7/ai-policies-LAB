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

// What each source tag means for a layer, in the words the Detail of that layer shows beside the tag.
export const SOURCE_NOTE = {
  deck: "Ping's slide 52 describes this check. That is a Ping release claim, UNVERIFIED on our tenant; how it is done here is the lab's own.",
  reading: "The lab's reading of the deck. The deck does not say this in so many words.",
  invented: "The lab's own mechanism. The deck does not describe it.",
};
