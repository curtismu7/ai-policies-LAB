// {{token}} templating for the story, policy and catalog data. customer.config.json (optional, git-ignored) overrides brand, host and the first user.
// Tokens are filled from one of three vertical packs. A test fails on any token a pack does not define.
// Every person, agent, repository, role and host in a pack is synthetic: only .example hosts, no real company, tenant or account.
import fs from 'node:fs';
import { scanHosts } from './safety.js';

const TOKEN = /\{\{(\w+)\}\}/g;
const MAX_CAST = 40;
const ID = /^[a-z0-9.-]{1,40}$/;

export const VERTICALS = {
  finance: {
    castBrand: 'Fabrikam Bank', castHost: 'fabrikam', castDept: 'finance',
    castUser: 'maya.chen', castUser2: 'omar.reyes', castApprover: 'priya.nair', castApprover2: 'lee.park', castSecurity: 'sam.jones',
    castAgent: 'payments-agent', castAgent2: 'reporting-agent', castAgent3: 'chat-agent',
    castRoleApprover: 'payments-approver', castRoleSecurity: 'security-officer',
    castApp: 'payments', castApp2: 'reports', castModelApp: 'assistant-llm', castPeerApp: 'ledger-reconciler',
    castToolRead: 'get_payee', castToolWrite: 'send_payment', castToolHold: 'change_payee', castToolHard: 'close_account', castToolList: 'list_reports',
    castRecord: 'payee-1042', castNewValue: 'payee-9917', castLimit: '10,000',
    castChange: 'a payee change', castAction: 'a payment above the limit',
  },
  health: {
    castBrand: 'Contoso Health', castHost: 'contoso', castDept: 'clinical',
    castUser: 'lena.ortiz', castUser2: 'tariq.hassan', castApprover: 'grace.liu', castApprover2: 'kofi.mensah', castSecurity: 'noah.becker',
    castAgent: 'intake-agent', castAgent2: 'census-agent', castAgent3: 'triage-chat-agent',
    castRoleApprover: 'clinical-approver', castRoleSecurity: 'privacy-officer',
    castApp: 'records', castApp2: 'census', castModelApp: 'clinical-llm', castPeerApp: 'claims-reconciler',
    castToolRead: 'get_contact', castToolWrite: 'order_supply', castToolHold: 'change_contact', castToolHard: 'erase_chart', castToolList: 'list_census',
    castRecord: 'patient-2207', castNewValue: 'contact-5531', castLimit: '10,000',
    castChange: 'a contact change on a chart', castAction: 'a supply order above the limit',
  },
  retail: {
    castBrand: 'Northwind Retail', castHost: 'northwind', castDept: 'commerce',
    castUser: 'diego.ruiz', castUser2: 'hana.sato', castApprover: 'olu.adeyemi', castApprover2: 'anna.berg', castSecurity: 'tom.fischer',
    castAgent: 'checkout-agent', castAgent2: 'sales-report-agent', castAgent3: 'shopper-chat-agent',
    castRoleApprover: 'store-approver', castRoleSecurity: 'loss-prevention',
    castApp: 'orders', castApp2: 'sales-reports', castModelApp: 'shopper-llm', castPeerApp: 'stock-reconciler',
    castToolRead: 'get_order', castToolWrite: 'issue_refund', castToolHold: 'change_address', castToolHard: 'delete_account', castToolList: 'list_sales',
    castRecord: 'order-3318', castNewValue: 'address-7740', castLimit: '10,000',
    castChange: 'a delivery address change', castAction: 'a refund above the limit',
  },
};

export const DEFAULT_VERTICAL = 'finance';
export const DEFAULT_CAST = VERTICALS[DEFAULT_VERTICAL];

export const unfilled = (text, cast) => [...String(text).matchAll(TOKEN)].map((m) => m[1]).filter((k) => !Object.hasOwn(cast, k));
export const fill = (text, cast) => String(text).replace(TOKEN, (m, k) => (Object.hasOwn(cast, k) ? cast[k] : m));
// Iterative, so a deep structure cannot overflow the stack.
export function fillDeep(value, cast) {
  const clone = (x) => (Array.isArray(x) ? [] : x && typeof x === 'object' ? {} : x);
  const outRoot = { v: clone(value) };
  const work = [[value, outRoot, 'v']];
  while (work.length) {
    const [src, dst, key] = work.pop();
    if (typeof src === 'string') { dst[key] = fill(src, cast); continue; }
    if (src === null || typeof src !== 'object') { dst[key] = src; continue; }
    const copy = clone(src);
    dst[key] = copy;
    for (const k of Object.keys(src).reverse()) work.push([src[k], copy, k]);
  }
  return outRoot.v;
}

export const verticalFrom = (id) => (typeof id === 'string' && Object.hasOwn(VERTICALS, id) ? id : DEFAULT_VERTICAL);

// Only brand, host and the first user, as short plain strings; anything else in the file is ignored. The user must not collide
// with another person in the pack.
export function loadCast(file, vertical = DEFAULT_VERTICAL) {
  const cast = { ...VERTICALS[verticalFrom(vertical)] };
  if (!file) return cast;
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [short, key] of [['brand', 'castBrand'], ['user', 'castUser'], ['host', 'castHost']]) {
      const v = cfg?.cast?.[short];
      if (typeof v !== 'string' || !v.trim()) continue;
      const clean = v.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').trim().slice(0, MAX_CAST);
      if (/:\/\/|@/.test(clean) || scanHosts(clean).length) continue;
      if (short !== 'brand' && !ID.test(clean.toLowerCase())) continue;
      if (short === 'host' && clean.includes('.')) continue;
      const val = short === 'brand' ? clean : clean.toLowerCase();
      if (short === 'user' && Object.entries(cast).some(([k, x]) => k !== 'castUser' && x === val)) continue;
      cast[key] = val;
    }
  } catch { /* no file or not JSON: the defaults */ }
  return cast;
}


// The roster: lab users (people) and agents (service identities), all fake. A person has roles and the strongest authentication level they can present
// (1 password, 2 push approval, 3 hardware key: LAB-INVENTED levels). An agent has a custodian (a person). Identity ceilings live in the policy.
export function buildRoster(cast) {
  const h = (id, roles, maxAuthLevel) => ({ id, kind: 'human', roles, maxAuthLevel });
  const a = (id, custodian) => ({ id, kind: 'agent', custodian, roles: [], maxAuthLevel: 0 });
  return [
    h(cast.castUser, [], 2), h(cast.castUser2, [], 1), h(cast.castApprover, [cast.castRoleApprover], 3), h(cast.castApprover2, [cast.castRoleApprover], 3),
    h(cast.castSecurity, [cast.castRoleSecurity], 3),
    a(cast.castAgent, cast.castUser2), a(cast.castAgent2, cast.castUser), a(cast.castAgent3, cast.castUser2),
  ];
}
