// The lab's gateway catalog: three SURFACES a credential can touch (a model, a tool server, a peer agent), the applications behind them, each tool with its
// typed arguments, and the scopes and roles that exist. Names come from the vertical pack ({{cast}} tokens, filled by buildCatalog). LAB-INVENTED: the deck
// names the three surfaces (model, tool server, peer agent) and nothing else here; the route prefixes, the app and tool names, the argument shapes and the
// scope names are the lab's own. The simulated upstream never leaves the process.
import { fill } from './cast.js';

export const SURFACES = ['model', 'tool', 'agent'];
export const SURFACE_LABEL = { model: 'model (LLM gateway)', tool: 'tool server (MCP)', agent: 'peer agent (A2A)' };
// The surface comes from the route PREFIX, never from anything the caller says about itself.
export const ROUTE_PREFIX = { '/llm/': 'model', '/mcp/': 'tool', '/a2a/': 'agent' };
export const ARG_TYPES = ['string', 'number', 'boolean'];
export const FINDINGS = ['card-number', 'injection', 'secret'];
export const AUTH_LEVELS = { 1: 'password', 2: 'push approval', 3: 'hardware key' };
export const CHANNELS = { slack: 'Slack DM', push: 'Ping push', jira: 'Jira ticket', servicenow: 'ServiceNow ticket' };

const RAW_APPS = [
  { id: '{{castApp}}', surface: 'tool', tools: {
    '{{castToolRead}}': { args: { record: 'string' }, scope: '{{castApp}}:read' },
    '{{castToolWrite}}': { args: { record: 'string', amount: 'number' }, scope: '{{castApp}}:write' },
    '{{castToolHold}}': { args: { record: 'string', newValue: 'string' }, scope: '{{castApp}}:write' },
    '{{castToolHard}}': { args: { record: 'string' }, scope: '{{castApp}}:admin' },
  } },
  { id: '{{castApp2}}', surface: 'tool', tools: { '{{castToolList}}': { args: { query: 'string' }, scope: '{{castApp2}}:read' } } },
  { id: '{{castModelApp}}', surface: 'model', tools: { chat: { args: { prompt: 'string' }, scope: 'model:invoke' } } },
  { id: '{{castPeerApp}}', surface: 'agent', tools: { ask: { args: { question: 'string' }, scope: 'agent:ask' } } },
];

// { apps: { <id>: { id, surface, tools: { <tool>: { args, scope } } } }, scopes: [...], roles: [...] }. Plain objects keyed by names the pack chose: look up with Object.hasOwn.
export function buildCatalog(cast) {
  const apps = {}; const scopes = new Set();
  for (const a of RAW_APPS) {
    const id = fill(a.id, cast); const tools = {};
    for (const [t, spec] of Object.entries(a.tools)) { tools[fill(t, cast)] = { args: { ...spec.args }, scope: fill(spec.scope, cast) }; scopes.add(fill(spec.scope, cast)); }
    apps[id] = { id, surface: a.surface, tools };
  }
  return { apps, scopes: [...scopes], roles: [cast.castRoleApprover, cast.castRoleSecurity] };
}

export const hasApp = (cat, id) => typeof id === 'string' && Object.hasOwn(cat.apps, id);
export const hasTool = (cat, app, tool) => hasApp(cat, app) && typeof tool === 'string' && Object.hasOwn(cat.apps[app].tools, tool);

// "/mcp/payments" -> { surface: 'tool', app: 'payments' }; anything else -> null (an unknown route is a denial, never a guess).
export function parseRoute(route) {
  if (typeof route !== 'string' || route.length > 80) return null;
  for (const [prefix, surface] of Object.entries(ROUTE_PREFIX)) {
    if (route.startsWith(prefix)) { const app = route.slice(prefix.length); return /^[a-z0-9][a-z0-9-]{0,40}$/.test(app) ? { surface, app } : null; }
  }
  return null;
}
export const routeFor = (cat, app) => `${Object.entries(ROUTE_PREFIX).find(([, s]) => s === cat.apps[app].surface)[0]}${app}`;
