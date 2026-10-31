# AI Policies LAB

A simulation of Ping's "AI Policies: Scope and HITL" release claims: four layered scope checks read from a verified token, and a third outcome beside allow and block that holds a call for a person, with approvals that are single-use, bound to the exact call and never a bypass.

Tier: Demo
Repo: https://github.com/ping-sandbox/ai-policies-LAB
Catalog: D109

**Tier: Demo.** Source: the Ping ID4AI Workforce H2 2026 deck, slide 52 (with 35, 36 and 48), release 2026-11-02. **Every product claim is a Ping release claim, UNVERIFIED on our tenant.** Nothing here calls a real gateway, identity provider, chat tool, ticket system or tenant, and nothing leaves your machine.

## What is simulated

**Mock mode (default).** Everything runs offline in one process and is read-only. Six scripted scenarios (four layers one at a time; hold, sign, retry; a hard denial no approval can lift; a fixed period with two approvers; findings that cannot hold; fail closed) were run through the lab's own engine, and the tables the pages show are generated from that run (`server/src/mockTable.json`; a doctor check and a test fail if it drifts). Every write is refused with 409.

**Live mode (owner-run, still local).** The same engine evaluates your own calls. You **mint a real RS256 token** (a throwaway RSA key generated in memory when the server starts; the token is labelled mock-issued and is not a credential for anything), edit its claims, tamper with it, build a request, and read the decision trace: every layer's verdict in order, what stopped the call and why. You edit the policy (six rule layers, validated on save), approve as any person in a fake roster, and move a **lab clock** forward so token lifetime, approval expiry and periods can be seen. The banner says which mode you are in. Live never leaves loopback and never touches a gateway or a tenant.

What it shows:

1. **Evaluate.** A request builder (route, tool, arguments as JSON text, headers, an approval reference, a simulated upstream reply, an optional lab fault) and the token editor, then the decision trace through the request step, token verification, **surface scope** (derived from the route, refused before any policy is consulted; the identity caps the key), **application policy** (and the claims the token must carry), **action scope** (read from the verified token, never from a header or an argument), **end-user scope** (the person behind the agent must resolve to a real user), the **attended and unattended questions** (deny is a hard denial; allow then deny is a hold), request inspection, the simulated call and reply inspection. The canonical hash of the call is shown and a hash calculator shows four spellings of one call agreeing and a different call differing.
2. **Policies.** The four layers plus the attended/unattended rules and the inspection rules, one JSON editor each. Save validates every rule and saves nothing if one is wrong: a rule naming a person who could never be identified, an unknown tool, scope, role or application, a wrong-typed condition, an approval nobody could ever sign, or an inspection rule that tries to hold is refused with the reason.
3. **Approvals.** The inbox and the approvers' outbox (Slack DM, Ping push, Jira or ServiceNow: simulated rows, never sent), decide as any person with the authentication level they signed in with, and every refusal: self-approval, a missing role, too weak a sign-in, a duplicate signature (counts once), a decision that is already final, expiry. A replay attempt and a retry with changed arguments.
4. **Where it runs.** A hold can only happen before the call is made. Findings on the request refuse the call; findings on the reply withhold the result; neither can pause for a person.
5. **Fail closed.** An evaluation error denies, an argument of the wrong type denies, a tampered token denies, hostile arguments deny; a rule naming something that does not exist is refused on save. Fault injection makes any stage throw so you can watch it deny.
6. **Diagram.** ReactFlow, drawn from diagram-studio/1 data loaded by name: movable boxes, Simulate, speed, Reset (restores box positions). Two diagrams: one call through the layers, and where it can run.
7. **Talk track,** with a "Why it matters" entry (challenge, technical and business lines, marked as Ping claims). Also in `docs/talk-track.md`. Three vertical packs (finance, health, retail) change every name.

### What is lab-invented

The deck gives claims; our own notes give measured behaviour on our tenant; the console swagger of 2026-10-31 (schema only) gives field names. Everything else here is the lab's own. Each field is tagged in the app as "deck claim", "console swagger name (schema only)", "lab reading", "lab-invented" or "measured (our note)":

- **Deck claims (slide 52):** the four layers and what each decides, the two questions, allow-then-deny as hold and a refused attended form as a hard denial, no held connection (reference, owning expiry, retry), single-use approvals bound to the exact call or a period with approvers, roles and a minimum authentication strength, the three delivery routes, the grant as an input, where it can run, fails closed on error and on a wrong type.
- **Lab reading.** The order of the layers after the surface check; deny-attended with allow-unattended read as a hard denial; the retry returning the same request while it is unsigned; and **the last line of the slide, which is cut off in the PDF**: a rule naming something that does not exist is refused when saved and is a denial if it ever reaches evaluation. That is a lab reading of a partly-cut-off deck line, not the deck's words.
- **Measured (our note), not the deck.** `AI-DEMO2/docs/privilege-agent-features.md` row 8 (transaction grants bound to the exact call versus capability grants for any call to the target until expiry, multiple approvers, an Archive tab) and `AI-DEMO2/privilege/AGENT-APPROVALS-DEMO.md` and `privilegeAiPoliciesDemo.js` (a hold is a Cedar forbid on the unattended action with an approval-count condition, a hard refusal is a forbid with no approval path, a PingFederate token's scope gates tools; Slack and Mattermost notifications never dispatched on our tenant). The lab's "call" and "period" bindings are its reading of them. The lab does not run Cedar: see `privilege-demo` for Cedar enforcement, and note that `agent-gateway-inspector` is adding the same slide-52 ideas. Neither is imported or touched.
- **Console swagger names (schema only):** `ApproverNotifications`, `Hitl`, `RetiredAt` on approvals and the `context.behaviour` name. A name proves a field exists, not how it behaves. The lab does not model them.
- **Lab-invented:** the rule formats of all six layers, the approval record and its states, the 1 to 3 authentication levels, the freeze-at-creation and re-check-at-use rules, the claim names (`surfaces`, `scope`, `end_user`, `department`), issuer, audience and key id, the route prefixes (`/llm/`, `/mcp/`, `/a2a/`), the three inspection finding kinds, the roster, the lab clock and **the canonical form of a call**. The deck says "a canonical hash of method + target + arguments"; the definition (sorted keys after NFC, number formats, refused inputs) is the lab's, written so one approval cannot cover a call it was not given for. `canon.js` states each rule and `canon.test.js` pins it.

### Known limits of the model

- Policy rules are first-match for holds (the first matching rule that says unattended deny supplies the approval requirements); every matching action rule and every matching end-user rule must pass.
- A call-bound approval is spent when the call is MADE: a refusal by request inspection keeps it; a withheld reply spends it. A period approval is counted, never spent, and covers any call to that tool by that person until it ends.
- Approval requirements are frozen when the request is created and re-checked when a retry would use the grant: a policy tightened in between needs a new approval; a loosened one still covers.
- A hold that could never complete (too few eligible people, the person the call acts for never counts) is refused instead of opened.
- Numbers in the arguments must be exact in a double: at most 15 significant digits with a fraction or exponent, and whole numbers up to 2^53 - 1. Arguments are at most 4096 characters, nesting 6, 40 keys per object, 50 items per array, 400 values, strings of 1000 characters; a call that breaks a limit is denied, never truncated. Credential-shaped text is masked by a lab-written heuristic that does not find every secret, so do not type a real one.
- A token is at most 4096 characters and lives 1 to 1440 lab minutes; a policy layer holds at most 30 rules; a workspace keeps at most 200 approvals, 500 audit entries and 300 outbox entries (a full workspace refuses new work: Reset); the clock moves forward only, 1 to 10080 minutes per move; one answer shows at most 40 hops.
- State is per `X-Workspace` id. **At the cap nothing is ever evicted:** the lab holds at most 500 workspaces; a NEW id at the cap is refused with HTTP 503 `workspaces_full` (fixed JSON), existing workspaces keep working and keep all their state, a Reset of your own workspace frees its slot, and a workspace untouched for an hour expires and frees one too. Flooding the lab with new ids can therefore refuse newcomers but cannot wipe anyone (a test creates ids in parallel). An id that looks like a credential is refused, never echoed.
- The lab has no sign-in: you choose who acts and which authentication level they signed with, so you can try the wrong person.
- **LAB READING, not the deck's order:** a held call that request inspection would refuse on every retry is never opened (`inspection_would_refuse`: no approval, no outbox row). It is the same idea as refusing an unfillable hold: a flow that can never complete is refused now. The deck puts inspection after the hold; the lab does not open an approval nobody can usefully sign.
- An approval request stores the argument NAMES and the call hash, never the values (the hash is over the real arguments, which are not kept).
- Keys sent twice inside an arguments OBJECT of an HTTP request body are resolved last-wins by the JSON body parser before the lab sees them (a duplicate cannot be seen after that). Send the arguments as text (`argumentsText`, which the Evaluate tab does) and duplicate keys are refused.
- A lab fault injected into the token stage answers 403, not 401: the fault stands for an evaluation error inside the stage, not for a token that failed to verify.
- The Mock drift test regenerates the table from the same Engine; a second test replays every scripted step through the real Live HTTP API in all three verticals and compares the results with the table.
- **Masking is a heuristic, with stated limits.** Free text, claim values, argument values and every answer pass one normaliser before matching: percent-decoded up to three rounds, NFKC, every invisible and format character deleted (`\p{Default_Ignorable_Code_Point}`, `\p{Cf}`, U+FFFD), control characters turned into spaces, backslashes before quotes dropped. Then a credential word as a key masks its value in any quoting (`"password":"x"`, `'pin' = x`, `userPassword: x`), assignments (`password: x`, `my password is x`) stop at a quote, comma, semicolon or brace so adjacent ones each match, and tokens, keys, JWTs, bearer values, URL passwords and key blocks are found by shape. NOT masked: a bare `keyword value` with no colon, equals or "is" (`password Tr0ub4dor`: too many false positives on prose), a short random password with no keyword before it, a password containing a comma, quote or brace (only the part before it is masked), and anything split by characters that are not invisible. A value is shown decoded when it was encoded. Do not type a real secret.

## Run from a clone

Prerequisites: Node 26 or newer. Docker only if you use the Docker form. Mock mode works with no setup at all: no tenant, no credentials, no settings file.

```
git clone https://github.com/ping-sandbox/ai-policies-LAB.git
cd ai-policies-LAB
npm ci
npm run build
npm start
```

Open http://localhost:7500/. Or in one step: `./scripts/run.sh` (installs and builds if needed, runs the doctor, starts).

## Settings file

All standalone apps read one settings file, `~/Development/.env`, which must be mode 600. `STANDALONE_ENV` overrides its path. This lab needs none of it. It parses the file (`util.parseEnv`) and takes exactly one optional key; no other key from the file ever enters the server's environment:

- `AIP_LAB_MODE` (optional): `mock` (default) or `live`, the mode the page opens in. The header toggle switches per visit. A bare `MODE` in the shared file is ignored, because it may belong to another app.

The shared file holds no `PORT`: the lab keeps its port default in code. Admin or worker credentials never belong in that file, and this lab uses none. It holds no credential for any real system. The doctor reports whether the file exists and its mode, and never prints a value.

## Ports, and what to do if the port is taken

```
Ports: ai-policies-LAB listens on 7500 (set with PORT, default 7500).
Port range for this app: 7500-7549.

If the port is taken:
1. Find what is using it:
   lsof -iTCP:7500 -sTCP:LISTEN -n -P
2. If it is an old copy of this app, stop that process: kill <PID>.
3. If it is something else, stop it, or start this app on another port:
   PORT=<other port> npm start
4. Do not use 8080, 5173, 3000, 4000, 4400, 4510, 4600-4601, 18080, 19080 or 19090.
```

Other variables: `VITE_PORT` (Vite dev server, default 7501, `npm run dev -w web`), `HOST_PORT` (Docker host port, default 7500). Keep all of them inside 7500-7549.

## Mock and live modes

The header has a **Mock / Live** toggle on every page, and the banner and the mode chip show the same mode. Mock reads tables generated from the engine (six scripted scenarios per vertical; a scenario picker on the Evaluate tab) and is read-only: every write control is off and the API answers 409. Live drives this workspace's engine (one per vertical): it mints tokens, evaluates your calls, keeps the approvals, outbox, audit trail and lab clock, and lets you edit the policy.

## Health, doctor and reset

```
npm run doctor   # 22 checks, including one real mint-hold-approve-retry cycle through the HTTP API; PORT=7509 npm run doctor to use a spare port
npm run reset    # clears the default workspace (approvals, outbox, audit trail, clock, edited policy); the UI Reset also restores the diagram
```

`GET /api/health` returns `demo-health/1`. **Status codes are honest, and the browser logs them.** An evaluation answers 200 (allow), 401 (a token that does not verify) or 403 (deny, hold, or a withheld result) and the body's `result.outcome` says which; a refused write (self-approval, a missing role, a rule refused on save) is its own 4xx (403, 404, 409, 422). A browser writes every 4xx to its console as an error message: that is expected here, because the refusals are the point of the demo. The workspace id comes in `X-Workspace`; every hop carries a W3C `traceparent`, and every write answers with the raw hops. Presenter mode: press `P` (Esc leaves); the simulation banner stays. `npm run mock-table`, `npm run talk-track` and `npm run content-pack` regenerate the generated files. See `docs/safety.md`.

## Docker (optional)

```
HOST_PORT=7500 docker compose up --build -d
```

The container publishes to 127.0.0.1 only (a test pins it), runs as a non-root user with a read-only file system and no capabilities. Use OrbStack, not Docker Desktop. `AIP_LAB_MODE=live` opens the page in Live mode.

## Tests

```
npm test    # server (node --test), web (vitest, drives the UI against the real server), scripts
```

The shared checks are run by hand, because the scripts are not shipped into this repo's CI: `bash <AI-DEMO-Standalone>/scripts/check-drift.sh .`, `bash <AI-DEMO-Standalone>/scripts/check-css.sh .` and `node <demo-kit-base>/scripts/conformance.mjs . --new`.

On Node 26: 250 tests pass (211 server, 16 web, 23 scripts).

## Troubleshooting

- **The page says "Could not load the lab".** The server is not running, or it is on another port. Start it (`npm start`) and check `PORT`.
- **Port is taken.** See "Ports, and what to do if the port is taken" above.
- **`npm start` refuses to start.** Run `npm run doctor`; the first failing line says why (Node older than 26, a port outside 7500-7549, a drifting mock table).
- **A button is greyed out.** Mock is read-only. Switch to Live in the header.
- **A call is denied and I do not know why.** Read the decision trace: the first non-pass layer names the stage, the code and the reason; every layer after it says it was not reached.
- **The mock table is out of date after an engine change.** Run `npm run mock-table`; the doctor and a test tell you when it drifts.

## Ownership

- Owner: the Ping demo family owner (Demo tier).
- License: MIT (see `LICENSE`).
- Found a problem? Open an issue on the repo.

## Not done

No SE k8s build (deferred by the owner, 2026-10-31). Every product claim stays UNVERIFIED until it is measured on a tenant that has the release. Cedar is not evaluated; the Intent, Purpose and Behaviour signals, AIGuard content inspection and real notification delivery are not modelled (the lab's three finding kinds are a deliberately tiny stand-in).
