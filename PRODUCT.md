# Product

## Register

product

## Platform

web

## Users

Two roles use NIMBUS about equally. **Plant-level schedulers** work day-to-day inside one or a few plants (scoped by RBAC via `role_plants`): dragging and rescheduling orders on the Gantt, resolving overlap/overload/blackout alerts, and keeping their lines' due dates on track. **Central planning and admin staff** work across plants: maintaining master data (plants, lines, materials), configuring calendars and color wheels, running optimizations, and monitoring health through the dashboard and admin cockpit. Both are expert users operating a working tool, not casual visitors.

## Product Purpose

NIMBUS schedules production orders across manufacturing lines and plants so they finish on time. It exists because spreadsheets and generic scheduling tools can't hold real due-date, calendar, blackout, and changeover constraints at once, and don't surface conflicts until it's too late to react. Success is on-time delivery: orders complete by their due dates, with line utilization and changeover efficiency as a secondary, supporting concern rather than the primary goal.

## Positioning

Due-date-aware scheduling that holds up at scale — a finish-anchored scheduler that derives each start backward from the planned finish through the line's working time, real-time conflict alerts, and an optimizer built for 50+ plants and 3,500+ lines, not a spreadsheet with a timeline view bolted on.

## Brand Personality

Industrial, precise, no-nonsense. NIMBUS reads as an instrument built for someone who schedules production every day, not a consumer app that happens to show a Gantt chart. It should feel authoritative and dense without being cold or unreadable — refined minimalism with character, in the language the existing stylesheet already uses.

## Anti-references

Not generic consumer SaaS: no bubbly rounded cards, gradient hero sections, or marketing-site gloss that doesn't belong on a dense operational screen. Not legacy enterprise/ERP either: no dated grid-of-forms SAP-style clunkiness. NIMBUS sits between those two failure modes — modern craft applied to an industrial, information-dense tool.

## Design Principles

- **Due dates are the north star.** Every scheduling view, alert, and KPI should make on-time delivery legible at a glance, before anything else competes for attention.
- **Design for 50 plants and 3,500 lines, not the pilot's handful.** Searchable/filterable pickers over bubble or chip selectors, scoped hierarchy over flat lists — even while the pilot only has a few plants and lines live.
- **Surface conflicts before they ship.** Real-time overlap/overload/blackout alerts beat end-of-day surprises; a scheduling problem should be impossible to miss in the moment it's created.
- **Industrial precision over decorative gloss.** This is an expert tool for expert users — dense, legible, purposeful. No consumer-SaaS polish, no legacy-ERP clunk.

## Accessibility & Inclusion

Standard WCAG AA. The 10-color production-line palette must stay distinguishable under common color-vision deficiencies, not just visually distinct to typical vision.
