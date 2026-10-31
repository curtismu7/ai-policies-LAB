import { fillDeep, VERTICALS } from './cast.js';
import { BANNER, CLAIMS, CLAIM_LABEL, FIELD_SOURCES, FIELD_SOURCE_NAMES, INTRO, LIMITS_TEXT, NOT_DEMONSTRATED, RELEASE, TALK_TRACK, TITLE, WHY } from './data.js';
import { EDITABLE_FIELDS, LIMITS as POLICY_LIMITS } from './policies.js';
import { ADVANCE_MAX_MIN, LIMITS, STAGES, STAGE_TITLE } from './engine.js';
import { AUTH_LEVELS, CHANNELS, FINDINGS, SURFACE_LABEL } from './catalog.js';
import { LIMITS as CANON_LIMITS } from './canon.js';
import { canonicalExamples, scenarioList } from './scenarios.js';

export const rawStory = () => ({ title: TITLE, intro: INTRO, banner: BANNER, claims: CLAIMS, talkTrack: TALK_TRACK, why: WHY });

// The story with the cast filled in.
export function buildStory(cast, vertical) {
  const s = fillDeep(rawStory(), cast);
  return {
    title: s.title, intro: s.intro, release: RELEASE, claimLabel: CLAIM_LABEL, banner: s.banner, claims: s.claims, why: s.why, notDemonstrated: NOT_DEMONSTRATED,
    fieldSources: FIELD_SOURCES.map((f) => ({ ...f, sourceLabel: FIELD_SOURCE_NAMES[f.source] })), limitsText: LIMITS_TEXT,
    limits: { engine: LIMITS, policy: POLICY_LIMITS, canon: CANON_LIMITS, advanceMaxMin: ADVANCE_MAX_MIN },
    stages: STAGES.map((id) => ({ id, title: STAGE_TITLE[id] })), editableFields: EDITABLE_FIELDS, authLevels: AUTH_LEVELS, channels: CHANNELS, findings: FINDINGS, surfaces: SURFACE_LABEL,
    canonicalExamples: canonicalExamples(cast),
    scenarios: scenarioList(cast).map((sc) => ({ id: sc.id, title: sc.title, say: sc.say })),
    talkTrack: s.talkTrack, cast, vertical, verticals: Object.keys(VERTICALS),
  };
}

// docs/talk-track.md is generated from the same data the UI reads (`npm run talk-track`); a test fails if they drift.
export function renderTalkTrackMarkdown(cast) {
  const s = buildStory(cast, 'finance');
  const parts = ['# Talk track', '', '<!-- Generated from server/src/data.js by `npm run talk-track`. Do not edit by hand. -->', '', `> ${s.claimLabel}: every product claim here comes from the Ping ID4AI Workforce H2 2026 deck, slide 52 (release ${s.release}), with slides 35, 36 and 48 for context. Our own notes are labelled "measured (our note)".`, ''];
  for (const t of s.talkTrack) parts.push(`## ${t.title}`, '', t.say, '');
  parts.push('## The scripted scenarios (Mock mode)', '');
  s.scenarios.forEach((sc, i) => parts.push(`${i + 1}. **${sc.title}.** ${sc.say}`));
  parts.push('', '## Not demonstrated', '');
  for (const n of s.notDemonstrated) parts.push(`- ${n}`);
  return `${parts.join('\n')}\n`;
}
