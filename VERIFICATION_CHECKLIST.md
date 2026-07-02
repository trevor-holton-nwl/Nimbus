# NIMBUS Manual E2E Verification Checklist

**Purpose:** Verify the schema-headcount-idempotent fix (fix/schema-headcount-idempotent) against the plan's 5 core verification steps.

**Setup:** Before starting, ensure:
- Postgres is running (`SELECT 1;` works via psql)
- Backend is running (`uvicorn brain:api --port 8000 --reload`)
- App is loaded at `http://localhost:8000/`
- Browser DevTools Console is open (F12)
- No prior errors in console

---

## Step 1: Load Plant 1006 (709 Rows) — Performance & Warnings

**What to do:**
1. Open the app at `http://localhost:8000/`
2. Select plant **1006** from the plant selector
3. Switch to the **Gantt** tab (timeline view)
4. Let it fully render (wait 3–5 seconds for all tasks to appear)
5. Open the browser **Console** tab and check for any warnings/errors

**What to look for — PASS criteria:**
- ✅ **No "infinite loop in redraw?" warning** in console
- ✅ **No [freeze] entries > 1 second** in the PerfMonitor (check the **Admin** tab → **Diagnostics** sub-tab → look for Thread p95/p99 metrics; or check console logs for `[freeze: XXX ms]` lines)
- ✅ Timeline renders smoothly without visual stalls
- ✅ Gantt chart displays all ~709 rows (check row count in the Inspector or scroll to verify density)

**What to look for — FAIL criteria:**
- ❌ Any console warning matching pattern `infinite loop in redraw?`
- ❌ Any log entry `[freeze: >1000ms]` or similar indicating a 1+ second hang
- ❌ Visual stutter/jank while rendering
- ❌ Incomplete task rendering (missing rows or visual gaps)

**Result:**  
Pass: [ ]  Fail: [ ]  
Notes: _______________________________________________________________

---

## Step 2: Check Task Placements (Spot-Check 3–5 Tasks)

**What to do:**
1. With plant 1006 loaded, pick 3–5 visible tasks from the Gantt timeline
2. For each task:
   - Click the task row to open the **Inspector** pane (right side)
   - Note the task's `scheduled_start` and `scheduled_end` times
   - Visually verify the task block on the timeline aligns with these times
   - Check if any **blackout blocks** (red/blocked-time zones) overlap or come immediately before/after — there should be **none** in the task window

**Specific checks:**
- ✅ **Task time alignment:** Timeline block position matches Inspector times (within visual grid alignment)
- ✅ **No blackout overlap:** Task does not visually sit in a red/blocked zone
- ✅ **Blackout snap:** If a task is near a blackout, its end time does **not** extend into the blackout (confirm start/end in Inspector)

**Expected behavior:**
All 3–5 spot-checked tasks should:
- Have `scheduled_start` and `scheduled_end` that align with their visual block on the timeline
- Respect blackout windows (no overlap)
- Be properly placed within working hours if the calendar has them defined

**Result:**  
Pass: [ ]  Fail: [ ]  
Spot-checked tasks: ________________________________________  
Notes: _________________________________________________________________

---

## Step 3: Degenerate Calendar Test — nextAvailable Failure Mode

**What to do:**
1. Switch to the **Master Data** tab
2. Go to **Plant** or **Calendar** settings for plant 1006
3. Create (or edit) a production line's **working hours** to be completely closed:
   - Set all 7 days of the week to closed (start time = end time, or use a toggle to disable)
   - Or create a calendar that has the line closed every single day
4. **Save** the calendar change
5. Return to **Gantt** tab
6. Try to **manually drag a task** on that line, or run an **Optimize** operation
7. Check the **Console** for error logs

**What to look for — PASS criteria:**
- ✅ **Fast failure:** Optimizer or nextAvailable returns immediately (< 500 ms) with a logged error
- ✅ **Error message** in console matches pattern: `ERROR.*nextAvailable.*no available slot` or similar
- ✅ **No hang or freeze:** The browser remains responsive; no "infinite loop in redraw?" warning
- ✅ **Graceful degradation:** The drag or optimize operation terminates cleanly (task does not move, or an error toast appears)

**What to look for — FAIL criteria:**
- ❌ **Hang or freeze:** Browser freezes for 2+ seconds
- ❌ **No error logged:** Optimization silently does nothing or moves the task into the closed window (incorrect behavior)
- ❌ **Infinite loop warning** or repeated console errors

**Result:**  
Pass: [ ]  Fail: [ ]  
Error message seen: _________________________________________________  
Response time (ms): ________  
Notes: _________________________________________________________________

---

## Step 4: Edit Plant/Line Working Hours — Scoped Re-Snap Test

**What to do:**
1. Start with plant 1006 loaded and all tasks visible on the Gantt
2. Switch to **Master Data** → **Calendar** or **Plant** settings
3. **Edit one production line's working hours:**
   - Example: change Line 123 Monday start time from 06:00 to 08:00
   - Save the change
4. Return to **Gantt** and observe task behavior
5. Check the console for any re-snap logs

**What to look for — PASS criteria:**
- ✅ **Only affected line's tasks re-snap:** Only tasks on the edited line (Line 123) shift their positions if they were starting before 08:00
- ✅ **Unaffected lines unchanged:** All other lines' tasks remain in their original positions (no global re-snap)
- ✅ **Console logs** show incremental re-snap, e.g., `recompute({ lines: ['LINE_123'] })` (not a full plant recompute)
- ✅ **Performance:** Re-snap completes in < 500 ms (no visible freeze)

**Expected behavior:**
- Tasks on **Line 123** that started before 08:00 should be shifted to start at or after 08:00 (respecting blackout/closed windows)
- Tasks on **all other lines** remain unmoved
- No global full-plant recompute in logs

**What to look for — FAIL criteria:**
- ❌ **Global re-snap:** All lines' tasks shift (indicates full plant recompute, not scoped)
- ❌ **No re-snap:** Line 123 tasks are not adjusted despite the working-hour change
- ❌ **Performance issue:** Re-snap takes > 1 second; visible freeze on the timeline

**Result:**  
Pass: [ ]  Fail: [ ]  
Line edited: ________________  Working hours change: ________________  
Only affected line re-snapped: [ ] Yes [ ] No  
Re-snap time (ms): ________  
Notes: _________________________________________________________________

---

## Step 5: Drag & Drop Reschedule + Optimize — Placement & Blackout Respect

**What to do:**
1. Load plant 1006 if not already loaded
2. **Manual drag-and-drop test:**
   - Pick a task from the Gantt timeline
   - Drag it to a **new position** on the same or a different line
   - Confirm the task **snaps to a valid time** (not into a blackout; respects working hours)
   - Check the Inspector to verify `scheduled_start` / `scheduled_end` changed correctly
3. **Optimize test:**
   - After the manual reschedule, open the **Optimize** dialog (e.g., Cmd/Ctrl+K or Optimize button)
   - Choose an optimization mode (e.g., **Changeover** or **Combined**)
   - Run the optimizer
   - Observe the result in the Gantt

**What to look for — PASS criteria:**
- ✅ **Drag snap behavior:** Task snaps to a valid slot (not into a blackout block; respects working hours)
- ✅ **Inspector update:** Task times in the Inspector match the new dragged position
- ✅ **No "spring-back":** Task stays where dropped; does not snap back to original position
- ✅ **Optimize placement:** After optimization, tasks are moved to new positions that respect:
  - Blackout blocks (no overlap)
  - Working-hour windows
  - Finish-to-start links (if any)
- ✅ **No invalid placements:** No task sits in a red/blocked zone after optimize
- ✅ **Performance:** Optimize completes in < 2 seconds; no visible freeze or hang

**Expected behavior:**
- Drag operation places the task at the nearest valid slot in the target window
- Optimize groups and reorders tasks intelligently, respecting all constraints
- All final positions are blackout-safe and within working hours
- No errors or warnings in console

**What to look for — FAIL criteria:**
- ❌ **Task spring-back:** Dragged task returns to original position after release
- ❌ **Blackout overlap:** A task lands on or inside a red/blocked zone after drag or optimize
- ❌ **Invalid time:** Task `scheduled_end` ≤ `scheduled_start` (inverted range)
- ❌ **Performance issue:** Optimize takes > 2 seconds; browser freezes
- ❌ **Console errors:** Optimization throws exceptions or logs critical errors

**Result:**  
Pass: [ ]  Fail: [ ]  
Tasks dragged: ________  Lines: ________  
Optimization mode used: ________________  
All placements blackout-safe: [ ] Yes [ ] No  
Optimize time (ms): ________  
Notes: _________________________________________________________________

---

## Summary

| Step | Test | Pass | Fail | Notes |
|------|------|------|------|-------|
| 1 | Load 1006 — no warnings, no long freezes | [ ] | [ ] | |
| 2 | Spot-check task placements (3–5 tasks) | [ ] | [ ] | |
| 3 | Degenerate calendar — fail fast, no hang | [ ] | [ ] | |
| 4 | Edit working hours — scoped re-snap only | [ ] | [ ] | |
| 5 | Drag + Optimize — valid placements, no spring-back | [ ] | [ ] | |

**Overall Result:**  
- [ ] **All Pass** — ready to commit
- [ ] **Partial** — note issues above
- [ ] **Fail** — investigate failures before commit

**Tester:** _________________________  **Date:** ______________

---

## Troubleshooting Tips

**Console logs are hard to read:**
- Filter by `NIMBUS` in the browser console to see only app logs
- Use `console.table()` to display structured data (e.g., `console.table(Store.tasks)`)

**PerfMonitor not visible:**
- Admin tab → Diagnostics → scroll to "Thread" section
- Look for p50, p95, p99 render times; any > 1000 ms is a concern

**Drag not working:**
- Ensure Gantt tab is active (not Orders table)
- Try dragging from the middle of the task block, not the edge
- Check console for any drag-related errors

**Blackout blocks not visible:**
- Confirm the calendar has blackout blocks defined
- May be rendered in a subtle color (red/dark depending on dark mode)
- Hover over suspected blackout zones to see a tooltip

**Optimize hangs:**
- Press Escape to close the dialog
- Check browser DevTools Network tab for slow backend responses
- Verify Postgres is running and responsive

