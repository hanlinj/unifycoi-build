# UnifyCOI — Mission

> Agent-facing. This file defines *what good looks like* and *how to break ties*.
> It is not a technical spec — pair it with the architecture/context doc for stack, conventions, and current priorities.

## North Star

UnifyCOI eliminates human effort from vendor COI compliance for multi-location self-storage operators. The system automatically **collects, verifies, monitors, and enforces** insurance and onboarding requirements for every vendor across every facility — maintaining a complete audit trail and surfacing only the exceptions that need human judgment.

It is not a document repository. It is an autonomous vendor compliance coordinator.

## The Problem (one frame, three views)

Vendor onboarding and compliance is manual, slow, and error-prone because the work is fragmented across three roles who each experience it differently:

- **Vendors** (plumbers, electricians, gate techs, landscapers, paving contractors) want to do work, not paperwork. They're busy, often not tech-savvy, unsure what's required or why, and wary of sending sensitive info (ACH, banking, voided checks) to a manager they don't know. They get asked for the same packet at every location.
- **Store managers** become unwilling middlemen — collecting docs, forwarding emails, relaying corrections — without understanding compliance rules. Vendor info scatters across inboxes, spreadsheets, and memory, and walks out the door when an employee leaves.
- **Corporate compliance / risk / AP** review what someone else collected, so they get incomplete or non-compliant docs (missing endorsements, low limits, expired policies). Every fix loops back through the manager to the vendor. Status is hard to track across locations; renewals live in spreadsheets; audits mean assembling data from everywhere.

Net result: delayed work, inconsistent records, and unnecessary financial, legal, and operational risk.

## What It Does

- **Vendor onboarding & collection** — gather COIs, W-9s, ACH forms, licenses directly from vendors via a simple guided flow. No manager-as-courier.
- **AI compliance verification** — extract document data; verify coverage, dates, limits, endorsements against operator-defined requirements; flag missing/expired/non-compliant items; explain deficiencies and request corrections automatically.
- **Expiration & renewal management** — monitor validity continuously, request updates before expiration, chase until satisfied.
- **Store manager vendor hub** — searchable directory of approved vendors by trade/status; one-click invites; real-time onboarding status.
- **Multi-location management** — central directory; approve once, associate with many locations; no duplicate onboarding; vendor knowledge survives employee turnover; track status by vendor/location/region/org.
- **Corporate command center** — org-wide real-time visibility into approved/pending/expired/non-compliant vendors; surface gaps before they become risk.
- **Workflow automation & audit** — configurable approval routing, stakeholder notifications, exception-only escalation, and a complete audit trail of every document, decision, communication, and status change.

Each role's core question:
- Store manager: *"Who can I hire?"*
- Vendor: *"What do I need to do to start?"*
- Corporate: *"Are we compliant?"*

## Who It's For

**Buyer:** multi-location self-storage operators — regional operators, third-party managers, PE-backed platforms (dozens to hundreds of facilities). Economic buyer is COO / VP or Director of Ops / Risk / Compliance / ownership. They care about reduced risk, efficiency, standardization, and portfolio visibility.

**Users (by time-in-product):**
- **Corporate compliance/ops** — heaviest users; manage requirements, renewals, exceptions, audits. Success = managing exceptions, not chasing paper.
- **Regional/district managers** — need cross-facility visibility without spreadsheets or phone calls.
- **Store managers** — frequent users, *not* compliance experts. Must never need to understand insurance rules. Success = answering "who can I hire right now?"
- **Vendors** (secondary) — tradespeople onboarding from a phone between jobsites. Mobile-first, guided, secure, low-friction. Should never need to understand compliance terminology.

## Product Principles (the tiebreakers)

When priorities, features, or implementations conflict, decide by these:

1. **Accuracy over speed.** A false approval is far worse than a delayed one. When uncertain, request clarification or human review — never approve on a guess. Compliance system first, workflow system second.
2. **Defensibility over convenience.** Every decision must be explainable and auditable. Log documents, reviews, decisions, requirement changes, communications, user actions, and AI recommendations. An operator must always be able to say *why* a vendor was approved, rejected, or flagged.
3. **Minimize human chase-work.** Automate reminders, expiration tracking, and routine deficiency explanations. Reserve human effort for exceptions and judgment calls.
4. **Humans remain in control.** AI assists and automates; it never becomes unchallengeable authority. Authorized users can override, approve exceptions, modify requirements, escalate, and make final calls. AI explains its reasoning.
5. **Multi-location is first-class.** Never an afterthought. Approval, tracking, visibility, reporting, and onboarding are all designed around portfolios of facilities, not single sites.
6. **Collect information once.** Never request the same info twice unless it changed or expired. Reuse across facilities, regions, and workflows where appropriate.
7. **Remove the middleman.** Information flows directly between the people who need it. The platform communicates with vendors, gathers info, explains deficiencies, and routes to stakeholders — managers are not document couriers.
8. **Simplicity wins.** Favor clarity and guidance over flexibility and configurability. Every workflow should need as little training as possible.
9. **Secure by default.** Sensitive data (tax, banking, insurance) is visible only to authorized users with a legitimate need. Minimize exposure throughout onboarding so vendors feel safe submitting it.
10. **Visibility without friction.** Each role can instantly answer its own question (above) without spreadsheets, email searches, or phone calls.
11. **Exception-based operations.** Routine work happens automatically; human attention goes to exceptions, risks, and disputes. Success = users managing exceptions, not processing paperwork.
12. **Build trust through transparency.** Always explain what's needed, why, what's missing, what happens next, and how a decision was made. Trust comes from clear communication, not hidden automation.
13. **Don't let admin friction block work.** Compliance exists to reduce risk, not to stop work. Move vendors toward approved status as fast as standards allow.

## Non-Goals & Scope Boundaries

UnifyCOI deliberately limits scope to vendor onboarding, compliance, and insurance verification for multi-location self-storage operators. The following are out of scope unless explicitly stated:

- **Not a general document management system** — docs are kept only when they support onboarding, compliance, payment setup, risk, or audit. Don't let it become generic file storage.
- **Not an insurance brokerage** — verifies documentation; does not sell, broker, quote, or replace agents/carriers.
- **Not a vendor marketplace** — does not find vendors, bid projects, compare pricing, schedule work, or procure.
- **Not a full AP system** — may collect ACH/W-9s, but does not do invoicing, bill pay, GL, expense approvals, or payments.
- **Not a workforce/contractor management platform** — no employee certs, training, labor compliance, time tracking, scheduling, or payroll. Third-party vendors only.
- **Not a generic/universal compliance or COI platform** — optimize for the self-storage vendor use case first. Keep the architecture extensible, but don't design for every framework, industry, or endorsement. Depth over breadth.
- **Not a fully autonomous compliance authority** — AI reviews, recommends, verifies, and automates, but does not set policy, define standards, or make irreversible decisions without human oversight. Final authority is the operator.
- **Not a communication platform** — may send notifications/reminders, but does not replace email, SMS, or collaboration tools. Communication exists only to support compliance workflows.

**Focus Test — for any new feature, ask:**
*Does this help operators onboard, verify, monitor, approve, or maintain compliant vendors?* If no, it's likely out of scope.

## UX & Tone North Star

Built for ops professionals, compliance teams, property managers, and vendors — not software experts. It should feel less like enterprise compliance software and more like a knowledgeable coordinator that quietly keeps compliance moving.

- **Fast over fancy** — users want to approve a vendor, find one, or check status, then move on. Prioritize speed, clarity, and task completion.
- **Low cognitive load** — no training required. Show only what the current task needs; plain language, no insurance/compliance/legal jargon; clear next action. Users should rarely ask "what do I do next?"
- **Trust through clarity** — always explain what's required, why, what's missing, what happens next, and who owns the next action. AI decisions are transparent and explainable.
- **Communication style** — professional, friendly, direct, clear, non-technical. Write for a busy operations manager, not an insurance professional.

**The UX test:** if a store manager, regional manager, or vendor can complete their task without training, docs, or support, the design works. If they need an explanation, it's too complicated. *Make compliance feel easy.*

## What Success Looks Like

UnifyCOI succeeds when vendor compliance becomes largely **invisible** to the organization — the system continuously moves vendors toward compliant status, keeps them there, and surfaces only what genuinely needs a human.

- **Vendors** get approved with minimal effort and back-and-forth, onboard from a phone, submit once, rarely need help, and trust the platform with sensitive info.
- **Store managers** find approved vendors fast, invite new ones in seconds, see status without emails or calls, and never collect or interpret compliance docs. → *"I need a vendor. I can see who's approved. If I invite someone new, the system handles the rest."*
- **Corporate/compliance** see most approvals require little or no manual review, manage exceptions not routine submissions, get automatic deficiency detection and correction, have full org-wide visibility, and prep audits in minutes. → *"Show me what needs attention, not everything that's working."*
- **Organization** always knows its posture: nothing goes non-compliant silently, policies never lapse unseen, approvals are consistent across locations, leadership sees risk at a glance.
- **System** runs as an autonomous coordinator: most onboarding and renewals complete without human intervention, requirements are enforced consistently, every decision is traceable and defensible, human review only where judgment or policy interpretation is needed.

**The ultimate test** — at any moment an operator can confidently answer:
1. Which vendors are approved?
2. Which vendors need attention?
3. Can we prove our compliance status right now?

If those answers are always available, accurate, and defensible, UnifyCOI is succeeding.

> The highest compliment a customer can give: *"I don't think about vendor compliance anymore. It just happens."*
