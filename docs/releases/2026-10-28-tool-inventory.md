# Release notes: Tool Inventory (2026-10-28)

For planners. Status: built on `feature/tool-inventory`, not yet deployed.

## What changes for you

**Tool alerts now count copies.** A tool (Tool 1 or Tool 2 value) is a type, and your plant can own several copies. If a tool has 3 copies, 3 machines can run it at the same time; the 4th conflicts. Until a plant's inventory is entered, every tool counts as one copy, exactly as before.

**A split order keeps its tool across the weekend.** When an order is split around non-working time, its tool stays in use for the whole span, not only while it runs. You may see new tool alerts where the gap used to look free.

**A 3-way conflict shows two alerts, one per pushing order.** Three orders on one single-copy tool now raise two alerts (one for each order that pushes into the earlier one), not three.

**New page: Master Data > Tool Inventory.** Enter how many copies of each tool your plant has (and how many are out of service). Use Template to download a prefilled Excel file, fill it in, then Upload; a review screen shows what is new, changed and rejected before anything is saved. Tool conflict alerts have an "Open tool inventory" link that jumps to the tool.

**New Order Rule: "Treat Tooling as Hard Constraint".** Off by default, and planners can change it for their plant (System Settings > Scheduling Rules > Order Rules). When it is Hard, an Optimize run makes sure no tool is used by more machines than it has copies. The least urgent order is moved into a free gap, or sent to Needs Planning with the reason "Tool contention". The preview shows a Tool-blocked panel and asks you to confirm before Apply. To go back, set the rule to Off; nothing else needs undoing.

**Apply what still fits now resolves longer chains.** On all plants, if some orders in a run were edited by someone else, the partial Apply now works through chains of up to 7 dependent drops instead of refusing.

## Known behaviours

- About 1.8% of orders in our adversarial tests land in Needs Planning with an ordinary "no fit" reason, because their only slot would make a protected order's changeover worse. During the pilot, compare a Hard run's Needs Planning count with an Off run on the same input.
- After a Hard Apply, the Gantt tool alert can fire on never-committed SAP baseline bars. This is by design: those bars only warn, they do not reserve copies.
- Orders may be placed inside the gaps of a split order more often under Hard.
- A tool with zero usable copies may cause slightly fewer orders to be placed than a plain queue would.
- Still to confirm at the pilot plant: what the Tooling PRT value means in practice, and the assumption that a split order stays mounted on its tool.
