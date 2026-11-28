// What the Help dialog says. Plain, and as hedged as the rest of the lab (rule 2): what was measured, what is simulated, what is UNVERIFIED.
export const HELP_SECTIONS = [
  {
    heading: "What this lab is",
    body: [
      "A simulation of Ping's 'AI Policies: Scope and HITL' release claims: four layered scope checks read from a verified token, and a third outcome beside allow and block that holds a call for a person, with approvals that are single-use, bound to the exact call and never a bypass.",
      "Source: the Ping ID4AI Workforce H2 2026 deck, slide 52 (with 35, 36 and 48), release 2026-11-02."
    ]
  },
  {
    heading: "What was measured, and what is UNVERIFIED",
    body: [
      "Every product claim is a Ping release claim, UNVERIFIED on our tenant. Measured notes from our tenant (recorded in AI-DEMO2) inform the approval design, and the console swagger of 2026-10-31 gives some field names — schema only. Everything else is lab-invented and tagged as such in the app: the rule formats, the claim names, the roster, the lab clock, the canonical form of a call.",
      "One deck line is cut off in the PDF; the lab's reading of it (a rule naming something that does not exist is refused on save) is labelled a lab reading, not the deck's words.",
      "The lab does not run Cedar. The lab's engine is its own; only the optional Privilege gateway card in Real/Live is a real gateway call, and it stays on loopback."
    ]
  },
  {
    heading: "How to use the page",
    body: [
      "Tabs: Evaluate, Policies, Approvals, Where it runs, Fail closed, Diagram, Talk track. In Mock, Evaluate steps through six scripted scenarios — pick a scenario, then step through it; Mock is read-only and every write is refused with 409.",
      "In Live, the same engine evaluates your own calls: mint a mock-issued RS256 token, edit or tamper with its claims, build a request, and read the decision trace. The lab clock moves time forward so approval expiry and periods can be seen. Live never leaves loopback.",
      "The header has the vertical pack picker (finance, health, retail), theme, font size, Present (also the P key), Talk track and Reset."
    ]
  },
  {
    heading: "Mock and Live (Real)",
    body: "Mock runs offline in one process from generated tables. Live is owner-run and still local: the token is minted in memory and labelled mock-issued, and it is not a credential for anything. In Live the one real call is the Privilege gateway card at the top of the page. No identity provider, chat tool, ticket system or tenant is ever called, in either mode."
  }
];
