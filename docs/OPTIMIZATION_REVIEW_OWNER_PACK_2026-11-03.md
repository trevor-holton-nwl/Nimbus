# Optimization review: owner pack (2026-11-03)

State: all work is merged to the local integration line, **not pushed, not deployed**. Nothing below has been confirmed in a browser yet. Part 1 is your click-through, Part 2 is for a native-speaker review of the new wording, Part 3 is the decisions only you can make.

Tip: do Part 1 in Chrome on a plant with a few lines, firmed orders, and at least one overdue order. Switch the app language for the Languages group.

## Part 1. Browser checklist

Tick each row when it matches "What you should see now".

### A. Optimize dialog

| # | Where to click | What you should see now | What it looked like before | Done |
|---|---|---|---|---|
| A1 | Optimize, choose settings that trigger the first pre-run confirm, then press Cancel in the confirm | The Optimize dialog comes back with your choices intact | Dialog closed and your settings were lost | [ ] |
| A2 | Same, for the second pre-run confirm: Cancel | Dialog comes back with your choices intact | Dialog closed | [ ] |
| A3 | Same, for the third pre-run confirm: Cancel | Dialog comes back with your choices intact | Dialog closed | [ ] |
| A4 | Pick a plant (or line selection) with zero orders, press Run | A clear "nothing to optimize" outcome and the Run button is usable again | Spinner stayed on forever | [ ] |
| A5 | Time window = Custom, set From later than To, press Run | A message: "The To date and time must be after the From date and time." | A vague "no validation metadata" style failure | [ ] |
| A6 | Run a plan that produces alternate plans, open the plan comparison | Each alternate that was not chosen shows its own reason | Every such row said just "Pruned." | [ ] |
| A7 | Optimize, then look at the spinner while it runs and at the line list | Spinner text names the mode in your language; line list shows order counts, "excluded" tags and day counts correctly | Hard-coded English fragments | [ ] |

### B. Remove Backlog preview

| # | Where to click | What you should see now | What it looked like before | Done |
|---|---|---|---|---|
| B1 | Untick "Respect calendar" in Optimize, close it, open Remove Backlog, run it, reopen Optimize | Your Respect calendar choice is still what you set | Remove Backlog overwrote the saved choice | [ ] |
| B2 | Remove Backlog on a plant that has frozen/firmed orders, read the preview | "Frozen moved" shows a real, non-zero number where orders are frozen | Always 0 | [ ] |
| B3 | Remove Backlog across a clock-change weekend | Times in the preview do not drift by an hour | Hour of drift after the change | [ ] |
| B4 | Remove Backlog when an overdue order sits in the exceptions list; press Apply | Apply is available | Apply was blocked by the exception row | [ ] |
| B5 | Close the Remove Backlog dialog and quickly reopen it | Dialog stays visible | The close fade could hide the reopened dialog | [ ] |

### C. Apply and Undo

| # | Where to click | What you should see now | What it looked like before | Done |
|---|---|---|---|---|
| C1 | Run Optimize, then edit an order by hand before applying | A "plan is out of date" banner appears and Apply is disabled | No warning, Apply could push a stale plan | [ ] |
| C2 | Same situation, press "Apply what still fits" | Only the changes that are still valid are applied; the rest are listed as skipped | All or nothing | [ ] |
| C3 | Run Optimize, let an order start running, press Apply | Apply works; the running order is dropped from the plan and the preview says so | Apply failed or moved the running order | [ ] |
| C4 | Plan involving tools: press Apply, then Cancel on the tool confirmation | Nothing is applied, the preview stays open | Cancel could leave the preview in a wrong state | [ ] |
| C5 | Apply a 3-order plan, then Undo | Note whether all 3 orders return in one step (see decision D3) | Behaviour not confirmed | [ ] |
| C6 | Export CSV and Copy buttons in the preview | A confirmation toast ("Copied to clipboard" for Copy); CSV downloads | No feedback | [ ] |

### D. What-If

| # | Where to click | What you should see now | What it looked like before | Done |
|---|---|---|---|---|
| D1 | Open What-If, make changes, press Discard | Everything returns to the real schedule | Not confirmed | [ ] |
| D2 | What-If, make a change, press Undo | The last change reverses | Not confirmed | [ ] |
| D3 | What-If, then switch plant (see decision D1) | Write down exactly what happens; this is the repro the decision needs | Open question | [ ] |

### E. Alerts and reconcile

| # | Where to click | What you should see now | What it looked like before | Done |
|---|---|---|---|---|
| E1 | Reconcile a line that has no operating window | One warning per affected order, and only the failing order is marked | Repeated warnings and healthy orders also marked | [ ] |
| E2 | Same run, read the cutover summary | The blocked count includes those orders | Blocked count was too low | [ ] |
| E3 | Optimize with a line whose setup rules reject an order | No spurious "missing setup" alert on lines that cannot take it | False missing-setup alert | [ ] |

### F. Languages and accessibility

Switch to each of de, fr, es, pt, then repeat the rows.

| # | Where to click | What you should see now | What it looked like before | Done |
|---|---|---|---|---|
| F1 | Optimize dialog line list, each language | Pills ("N orders", "N days", "excluded") are translated and fit without clipping | English, or clipped | [ ] |
| F2 | Preview bars | Before/after tags are translated (de: vor / nach, es: antes / desp., fr: avant / après, pt: pré / pós) and fit the tag column | English "pre / post" | [ ] |
| F3 | Run with each language | Spinner shows the localized mode name | English mode name | [ ] |
| F4 | Preview summary lines (changeovers, late orders, slip, capacity check) in de | Full sentences, correct singular/plural | English or broken plural | [ ] |
| F5 | Line list with keyboard only (Tab, arrows, Space) | Every line reachable, focus visible, state announced | Not reachable or silent | [ ] |
| F6 | Line list with a screen reader | List announced as "Lines to optimize"; stale banner and help button announced | No list name | [ ] |
| F7 | Toasts (window invalid, copied, proposal no longer valid, orders need planning) in each language | Translated text | English | [ ] |

Row count: 7 + 5 + 6 + 3 + 3 + 7 = 31.

## Part 2. Translation review sheet

Keys added since the review baseline (34), from `frontend/locales/` (en, de, es, fr, pt). `{{...}}` are placeholders and must stay unchanged; `_one` / `_other` are singular / plural forms. Please check wording, plural form, and that text fits a narrow column.

| Key | en | de | es | fr | pt |
|---|---|---|---|---|---|
| `toast.opt_window_invalid` | The To date and time must be after the From date and time. | Das Enddatum mit Uhrzeit muss nach dem Startdatum mit Uhrzeit liegen. | La fecha y hora Hasta debe ser posterior a la fecha y hora Desde. | La date et l’heure de fin doivent être postérieures à la date et l’heure de début. | A data e hora Até deve ser posterior à data e hora De. |
| `toast.opt_copied` | Copied to clipboard | In die Zwischenablage kopiert | Copiado al portapapeles | Copié dans le presse-papiers | Copiado para a área de transferência |
| `modal.opt_tool_confirm_more` | (+{{count}} more) | (+{{count}} weitere) | (+{{count}} más) | (+{{count}} de plus) | (+{{count}} a mais) |
| `ui.opt_line_excluded` | excluded | ausgenommen | excluida | exclue | excluída |
| `ui.opt_line_excluded_title` | Globally excluded from optimization | Global von der Optimierung ausgenommen | Excluida globalmente de la optimización | Exclue globalement de l\'optimisation | Excluída globalmente da otimização |
| `ui.opt_line_orders_one` | {{n}} order | {{n}} Auftrag | {{n}} pedido | {{n}} commande | {{n}} pedido |
| `ui.opt_line_orders_other` | {{n}} orders | {{n}} Aufträge | {{n}} pedidos | {{n}} commandes | {{n}} pedidos |
| `ui.opt_lines_list_aria` | Lines to optimize | Zu optimierende Linien | Líneas a optimizar | Lignes à optimiser | Linhas a otimizar |
| `ui.opt_days_one` | {{n}} day | {{n}} Tag | {{n}} día | {{n}} jour | {{n}} dia |
| `ui.opt_days_other` | {{n}} days | {{n}} Tage | {{n}} días | {{n}} jours | {{n}} dias |
| `ui.opt_respect_firmed_backlog_hint` | Firmed orders move when reached and remain firmed. | Fixierte Aufträge werden beim Erreichen verschoben und bleiben fixiert. | Los pedidos firmes se mueven al llegar a ellos y siguen firmes. | Les commandes fermes sont déplacées lorsqu\'elles sont atteintes et restent fermes. | Os pedidos firmados são movidos quando alcançados e continuam firmados. |
| `ui.opt_pv_phrase_changeovers_more_one` | {{n}} more changeover | {{n}} Umrüstung mehr | {{n}} cambio más | {{n}} changement de plus | {{n}} troca a mais |
| `ui.opt_pv_phrase_changeovers_more_other` | {{n}} more changeovers | {{n}} Umrüstungen mehr | {{n}} cambios más | {{n}} changements de plus | {{n}} trocas a mais |
| `ui.opt_pv_phrase_changeovers_fewer_one` | {{n}} fewer changeover | {{n}} Umrüstung weniger | {{n}} cambio menos | {{n}} changement de moins | {{n}} troca a menos |
| `ui.opt_pv_phrase_changeovers_fewer_other` | {{n}} fewer changeovers | {{n}} Umrüstungen weniger | {{n}} cambios menos | {{n}} changements de moins | {{n}} trocas a menos |
| `ui.opt_pv_phrase_late_more_one` | {{n}} more late order | {{n}} verspäteter Auftrag mehr | {{n}} pedido atrasado más | {{n}} commande en retard de plus | {{n}} pedido atrasado a mais |
| `ui.opt_pv_phrase_late_more_other` | {{n}} more late orders | {{n}} verspätete Aufträge mehr | {{n}} pedidos atrasados más | {{n}} commandes en retard de plus | {{n}} pedidos atrasados a mais |
| `ui.opt_pv_phrase_late_fewer_one` | {{n}} fewer late order | {{n}} verspäteter Auftrag weniger | {{n}} pedido atrasado menos | {{n}} commande en retard de moins | {{n}} pedido atrasado a menos |
| `ui.opt_pv_phrase_late_fewer_other` | {{n}} fewer late orders | {{n}} verspätete Aufträge weniger | {{n}} pedidos atrasados menos | {{n}} commandes en retard de moins | {{n}} pedidos atrasados a menos |
| `ui.opt_pv_phrase_slip_more` | {{n}} h more slip | {{n}} h mehr Verzug | {{n}} h más de retraso | {{n}} h de retard en plus | {{n}} h a mais de atraso |
| `ui.opt_pv_phrase_slip_less` | {{n}} h less slip | {{n}} h weniger Verzug | {{n}} h menos de retraso | {{n}} h de retard en moins | {{n}} h a menos de atraso |
| `ui.opt_pv_join_and` | and | und | y | et | e |
| `ui.opt_gapfill_complete` | Capacity check: {{placed}} more order(s) placed; the rest can\'t fit without moving scheduled work. | Kapazitätsprüfung: {{placed}} weitere Aufträge platziert; der Rest passt nicht, ohne bereits eingeplante Arbeit zu verschieben. | Revisión de capacidad: se colocaron {{placed}} pedido(s) más; el resto no cabe sin mover trabajo ya programado. | Contrôle de capacité : {{placed}} commande(s) de plus placée(s) ; les autres ne tiennent pas sans déplacer du travail déjà planifié. | Verificação de capacidade: {{placed}} pedido(s) a mais colocado(s); os demais não cabem sem mover trabalho já programado. |
| `ui.opt_gapfill_incomplete` | Capacity check incomplete: {{placed}} placed, {{unchecked}} still unchecked. | Kapazitätsprüfung unvollständig: {{placed}} platziert, {{unchecked}} noch ungeprüft. | Revisión de capacidad incompleta: {{placed}} colocados, {{unchecked}} sin revisar. | Contrôle de capacité incomplet : {{placed}} placée(s), {{unchecked}} non vérifiée(s). | Verificação de capacidade incompleta: {{placed}} colocados, {{unchecked}} ainda sem verificar. |
| `ui.opt_pv_bar_pre` | pre | vor | antes | avant | pré |
| `ui.opt_pv_bar_post` | post | nach | desp. | après | pós |
| `ui.opt_pv_planning_summary` | {{scheduled}} scheduled · {{queued}} Needs Planning ({{newly}} newly queued) | {{scheduled}} eingeplant · {{queued}} Planung erforderlich ({{newly}} neu eingereiht) | {{scheduled}} programados · {{queued}} Requiere planificación ({{newly}} nuevos en cola) | {{scheduled}} planifiées · {{queued}} À planifier ({{newly}} nouvellement mises en attente) | {{scheduled}} programados · {{queued}} Precisa de planejamento ({{newly}} novos na fila) |
| `ui.opt_pv_search_incomplete` | Search incomplete — best proposal found within budget. | Suche unvollständig — beste Lösung innerhalb des Budgets. | Búsqueda incompleta: mejor propuesta encontrada dentro del presupuesto. | Recherche incomplète : meilleure proposition trouvée dans le budget imparti. | Busca incompleta: melhor proposta encontrada dentro do orçamento. |
| `ui.opt_pv_protected_head` | Protected orders requiring attention | Geschützte Aufträge mit Handlungsbedarf | Pedidos protegidos que requieren atención | Commandes protégées nécessitant une attention | Pedidos protegidos que exigem atenção |
| `ui.opt_pv_protected_body` | {{n}} order(s) have existing protected-schedule conflicts — locked in place, can\'t be moved. | {{n}} Auftrag/Aufträge haben bestehende Konflikte im geschützten Plan — fest eingeplant, nicht verschiebbar. | {{n}} pedido(s) tienen conflictos en la programación protegida: fijados en su lugar, no se pueden mover. | {{n}} commande(s) présentent des conflits dans le planning protégé : verrouillées sur place, elles ne peuvent pas être déplacées. | {{n}} pedido(s) têm conflitos na programação protegida: fixados no lugar, não podem ser movidos. |
| `ui.opt_pv_first_50_orders` | Showing the first 50 findings. Review the remaining orders in Orders. | Es werden die ersten 50 Befunde angezeigt. Die übrigen Aufträge in der Auftragsliste prüfen. | Se muestran los primeros 50 hallazgos. Revise los pedidos restantes en Pedidos. | Les 50 premiers constats sont affichés. Consultez les autres commandes dans Commandes. | Mostrando as primeiras 50 ocorrências. Revise os demais pedidos em Pedidos. |
| `ui.opt_unknown_error` | Unknown error | Unbekannter Fehler | Error desconocido | Erreur inconnue | Erro desconhecido |
| `toast.opt_proposal_invalid` | This proposal is no longer valid. Run optimization again before applying. | Dieser Vorschlag ist nicht mehr gültig. Optimierung vor dem Übernehmen erneut ausführen. | Esta propuesta ya no es válida. Ejecute la optimización de nuevo antes de aplicarla. | Cette proposition n\'est plus valide. Relancez l\'optimisation avant de l\'appliquer. | Esta proposta não é mais válida. Execute a otimização novamente antes de aplicar. |
| `toast.opt_orders_need_planning` | {{count}} order(s) need planning{{toolNote}}. Review their allowed windows and reasons in Orders. | {{count}} Auftrag/Aufträge benötigen Planung{{toolNote}}. Zulässige Fenster und Gründe in der Auftragsliste prüfen. | {{count}} pedido(s) requieren planificación{{toolNote}}. Revise sus ventanas permitidas y motivos en Pedidos. | {{count}} commande(s) à planifier{{toolNote}}. Consultez leurs fenêtres autorisées et leurs motifs dans Commandes. | {{count}} pedido(s) precisam de planejamento{{toolNote}}. Revise as janelas permitidas e os motivos em Pedidos. |

## Part 3. Decisions waiting on you

| # | Item | What it is | What changes for planners |
|---|---|---|---|
| D1 | P0-20 What-If plant switch | Switching plant while a What-If is open may leave the sandbox pointing at the old plant. Needs your repro steps (row D3 above) and a ruling on intended behaviour | Either What-If is discarded on plant switch (with a prompt) or it follows you; today it is undefined |
| D2 | P0-11 firmed-boundary change | A fix so adopting a firmed order at the boundary advances the planning marker was built, then reverted because it broke the tool-overflow check. Redesign or drop? | Redesign: firmed orders next to the boundary are placed more tightly. Drop: current behaviour stays |
| D3 | P2-4 Undo scope | Whether one Undo reverses the whole Apply or one order at a time | One "undo the optimization" step versus several |
| D4 | P2-8 hill-climb | Whether to add an extra improvement pass after the first plan is found | Possibly better plans, but longer runs |
| D5 | P3-3c throughput removal | Remove the throughput measure from plan scoring | Plans stop being compared on throughput; the comparison screen loses that line |
| D6 | P3-4 Apply prune unification | Make Apply and the preview drop orders by the same rule | Fewer "preview said X, Apply did Y" surprises; some borderline orders will also be dropped in the preview |
| D7 | P4-3 KPI scope change | Change which orders the optimizer KPIs count | Headline numbers (late orders, slip) shift, so before/after comparisons across the change are not like for like |
