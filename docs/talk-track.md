# Talk track

<!-- Generated from server/src/data.js by `npm run talk-track`. Do not edit by hand. -->

> Ping release claim, UNVERIFIED on our tenant: every product claim here comes from the Ping ID4AI Workforce H2 2026 deck, slide 52 (release 2026-11-02), with slides 35, 36 and 48 for context. Our own notes are labelled "measured (our note)".

## Start with the problem

Once an agent can act rather than answer, authorization says only the name of a tool, and the risk sits in the amount, the counterparty, the destination and the hour. No control today addresses it. (Ping's challenge text, slide 52. Fabrikam Bank sees this the first time payments-agent can change a payee.)

## Two independent controls

Which caller may reach what, and whether this particular call needs a person. Four layered scope checks answer the first. A third outcome beside allow and block answers the second. They are separate on purpose: scope never turns into approval, and approval never widens scope.

## Four layers, in order

On the Evaluate tab press "Four layers, one at a time". Surface first: derived from the route, and the identity caps the key, so reporting-agent's key cannot reach the model surface even though it claims it. Then the application and the claims its token must carry, then the scope the verified token must hold for the tool (a header that claims it is ignored), then the person behind the agent, who must resolve to a real user.

## The third outcome: hold for a person

Policy is asked two questions: may this proceed attended, may it proceed unattended. Allow then deny means hold. a payee change is held: the call is refused at once with a reason, a reference and an expiry. Nothing is held open. An approver signs, the agent retries, and the call proceeds.

## Bound, single-use, not a bypass

The approval is bound to the exact call: a canonical hash of method, target and arguments. Same arguments in a different key order proceed; different arguments need a new approval; the same approval replayed is refused. maya.chen cannot approve their own call, sam.jones lacks the role, and a password sign-in is too weak when the rule asks for a push approval. The grant is an input to the next evaluation: it lifts a hold and nothing above it.

## Or a fixed period, with more than one approver

a payment above the limit asks for two approvers at a hardware-key level, for a fixed period. A second signature from the same person counts once. While the period runs, calls to the tool proceed; when the lab clock passes it, the next call is held again.

## A hard denial is not a hold

A rule that refuses the attended form is a hard denial. There is no approval path, and presenting a valid approval for another call changes nothing.

## Where it can run

A hold can only happen before the call is made. Rules that read inspection findings run after the request has been examined, or after the reply has come back: refuse the call, or withhold the result. They cannot pause for a person, and a rule that tries is refused when it is saved.

## Fail closed

An evaluation error denies. An argument of the wrong type denies. A tampered token denies. A rule naming a person who could never be identified is refused when saved. (The last slide line is cut off in our PDF: the refusal is a lab reading, not the deck's words.)

## Why it matters: AI Policies, scope and HITL (slide 52)

Challenge: once an agent can act rather than answer, authorization says only the name of a tool; the risk sits in the amount, the counterparty, the destination and the hour. Technical: four layered scope checks read from the verified token, plus a third outcome that holds for a person; approvals are inputs to evaluation, never bypasses. Business: high-stakes agent actions become approvable without standing human review, the control that unblocks unattended agents in regulated processes. These are Ping claims, unverified on our tenant.

## What this is not

This is a simulation of Ping's release claims, which are unverified on our tenant. Our own notes say what we measured on our tenant (a hold, a hard refusal, and a token scope that gates tools); this lab does not run Cedar and does not call a gateway. Every shape that the deck does not give is the lab's own and tagged so. For Cedar enforcement see privilege-demo; the same slide-52 ideas are also being added to agent-gateway-inspector.

## The scripted scenarios (Mock mode)

1. **Four layers, one at a time.** Four scope checks run in order, and each stops the call on its own. reporting-agent's key claims the model surface, but its identity does not hold it. Then an application reporting-agent was never given, then a claim the application needs, then a scope the token lacks (a header that claims the scope is ignored), then a person who cannot be identified. The last call passes every layer.
2. **Hold for a human, sign, retry.** a payee change is allowed attended and refused unattended, so the call is held: it is refused at once with a reference and an expiry, nothing stays open. Wrong approvers are refused (the requester, a missing role, too weak a sign-in), one signs, the agent retries and proceeds. The same approval cannot be replayed, and changed arguments need a new one.
3. **A hard denial no approval can lift.** close_account is refused in the attended form, so it is a hard denial, not a hold: there is no approval path. Even a valid, signed approval for another call changes nothing.
4. **A fixed period, two approvers.** a payment above the limit is held, and the approval is for a fixed period instead of one exact call: two different approvers at a hardware-key level (a duplicate counts once). While the period runs, calls to that tool proceed; when it ends, the next one is held again.
5. **Where it can run: findings cannot hold.** Rules that read inspection findings run only after the request has been examined or after the reply has come back. The choice there is refuse the call or withhold the result. Neither can pause for a person, and a rule that tries is refused when saved.
6. **Fail closed.** An evaluation error denies. An argument of the wrong type denies. A tampered token denies. A rule naming something that does not exist is refused when saved, and anything that slips past is handled safely (a lab reading of a partly-cut-off deck line, not the deck's words).

## Not demonstrated

- Anything about how the real gateway, its policy engine, the console, Slack, a Ping push, Jira or ServiceNow behaves: nothing here ran against one. The evaluation pipeline, rule formats, claim names, the canonical form of a call and the approval states are the lab's own.
- The last line of the slide ("a rule naming something that does not exist ...") is cut off in the PDF. The lab refuses such a rule when it is saved and denies if one ever reaches evaluation. That is a lab reading of a partly-cut-off deck line, not the deck's words.
- Cedar. Our own notes say the real policies are Cedar (forbid on action mcp:InvokeUnattended with an approval-count condition for a hold, forbid on mcp:Invoke for a refusal with no approval path); this lab uses its own rule format and does not evaluate Cedar. See privilege-demo for Cedar enforcement.
- Intent, Purpose and Behaviour signals, AIGuard content inspection and the Agent Insights record set. The lab's three finding kinds are a deliberately tiny stand-in so that "rules that read inspection findings" have something to read.
- Notification delivery. Slack DM, Ping push, Jira and ServiceNow are rows in an in-memory outbox and are never sent. Our own note (measured on our tenant, 2026-10-12 to 13): notification channels never dispatched there, so the console path is the demonstrable one.
- Real authentication of an approver. The lab has no sign-in: you choose who acts and which authentication level they signed with, so you can try the wrong person.
- Archive tab, request expiry notifications, approver policies and anything else in the console that the slide does not describe.
