/* =====================================================================
 * autofill/engine/section-hierarchy.js — repeatable profile sections
 * (Education History, Work History, …) shared across every ATS that has
 * them.
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/autofill-section-hierarchy.js —
 * the generic root→group→leaf engine every BidHub ATS adapter that has
 * these blocks (Greenhouse, Workday, Ashby, Avature, Breezy, BuiltIn,
 * Dayforce, Freshteam, iCIMS, Indeed, Kula, Oracle Cloud, Paycom,
 * Paylocity, SmartRecruiters, UltiPro, Workable, Workable Jobs, Zoho
 * Recruit) inlines verbatim and drives with a declarative per-site
 * "section descriptor" (container/row selectors + field mappings). This
 * file is that same shared engine; each site's own autofill/sites/
 * <site>-autofill.js supplies its own descriptor(s), same division of
 * labor BidHub itself uses.
 *
 * Simplified relative to BidHub's own version in one deliberate way: no
 * generic AI-answer state machine (BidHub's leaves route every value
 * through its own getAnswer() backend with a pending/filled/skipped/
 * error/review_required lifecycle) — Big Banana's own profile already
 * HAS structured education/experience arrays (BCD's Profile model), so a
 * leaf's value is resolved directly from the matching profile entry, no
 * AI round-trip needed. The structural shape (flat node list with
 * parentFieldId, clear-then-rebuild-to-match-profile-count fill
 * strategy) is kept faithful to BidHub's own.
 * ===================================================================== */
(function () {
  "use strict";
  const ENGINE = window.ProactiveAutofillEngine;
  if (!ENGINE) return;

  function groupFieldId(rootFieldId, rowIndex) {
    return `${rootFieldId}:${rowIndex}`;
  }
  function leafFieldId(rootFieldId, rowIndex, mappingKey) {
    return `${rootFieldId}:${rowIndex}:${mappingKey}`;
  }

  // Flat root+group+leaf node list, one pass per registered section —
  // sidepanel.js rebuilds the nested card tree client-side purely from
  // each node's parentFieldId, same "no special nested wire format"
  // design BidHub's own panel uses (a flat list is also what dispatcher.js's
  // existing byId answer-routing already expects for every other field).
  function detectSections(sections, profileData) {
    const nodes = [];
    for (const section of sections) {
      let container;
      try {
        container = section.getContainer();
      } catch {
        container = null;
      }
      if (!container) continue; // this page doesn't have this section at all
      let rows = [];
      try {
        rows = section.getRows(container) || [];
      } catch {
        rows = [];
      }
      const rootId = section.rootFieldId;
      nodes.push({
        fieldId: rootId,
        parentFieldId: null,
        kind: "root",
        question: section.rootQuestion,
        label: section.rootQuestion,
        entryCount: rows.length,
        container,
        section,
      });
      rows.forEach((rowEl, rowIndex) => {
        const gId = groupFieldId(rootId, rowIndex);
        nodes.push({
          fieldId: gId,
          parentFieldId: rootId,
          kind: "group",
          question: section.rowLabel(rowIndex),
          label: section.rowLabel(rowIndex),
          section,
          rowIndex,
        });
        for (const mapping of section.mappings) {
          let fieldInfo = null;
          try {
            fieldInfo = section.getRowField(rowEl, mapping);
          } catch {
            fieldInfo = null;
          }
          if (!fieldInfo || !fieldInfo.field) continue;
          nodes.push({
            fieldId: leafFieldId(rootId, rowIndex, mapping.key),
            parentFieldId: gId,
            kind: "leaf",
            question: mapping.label || mapping.question,
            label: mapping.label || mapping.question,
            control: fieldInfo.field,
            section,
            rowIndex,
            mapping,
          });
        }
      });
    }
    return nodes;
  }

  // Waits for the Nth row to exist, clicking addRow (with retries) if it
  // doesn't yet — same "click Add, wait for the row to mount" loop
  // BidHub's own ensureSectionEntryPresent runs.
  async function ensureRow(section, container, index) {
    const existing = (section.getRows(container) || [])[index];
    if (existing) return existing;
    if (!section.addRow) return null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await section.addRow(container);
      } catch {
        /* retry below */
      }
      const deadline = Date.now() + (section.rowGrowthTimeoutMs || 3000);
      while (Date.now() < deadline) {
        const row = (section.getRows(container) || [])[index];
        if (row) return row;
        await ENGINE.sleep(100);
      }
    }
    return null;
  }

  // Clears whatever rows already exist, then rebuilds exactly as many as
  // the profile has (bounded by section.maxEntries for a fixed-capacity
  // block) and fills each one from its matching profile entry — BidHub's
  // own clear-first-then-rebuild-to-match-profile-count strategy, never a
  // reconcile-with-whatever's-already-there pass. A section that omits
  // clearRows (iCIMS-style — no per-row delete exists at all) just skips
  // the clear step and grows/fills from whatever's already on the page,
  // same as BidHub's own iCIMS descriptor.
  async function fillSection(section, entries, fillLeaf) {
    let container;
    try {
      container = section.getContainer();
    } catch {
      container = null;
    }
    if (!container) return { ok: false, error: "no_container" };
    if (section.clearRows) {
      try {
        await section.clearRows(container);
      } catch {
        /* best-effort */
      }
    }
    const targetCount = Math.min(entries.length, section.maxEntries ?? Infinity);
    const filled = [];
    const skipped = [];
    for (let i = 0; i < targetCount; i++) {
      const row = await ensureRow(section, container, i);
      if (!row) {
        skipped.push(groupFieldId(section.rootFieldId, i));
        continue;
      }
      const entry = entries[i];
      for (const mapping of section.mappings) {
        let fieldInfo = null;
        try {
          fieldInfo = section.getRowField(row, mapping);
        } catch {
          fieldInfo = null;
        }
        if (!fieldInfo || !fieldInfo.field) continue;
        const value = mapping.resolveValue ? mapping.resolveValue(entry) : entry?.[mapping.profileKey];
        if (value == null || value === "") continue;
        const id = leafFieldId(section.rootFieldId, i, mapping.key);
        try {
          await fillLeaf(fieldInfo.field, mapping, value, row);
          filled.push(id);
        } catch {
          skipped.push(id);
        }
      }
      if (section.getEditor && section.saveEntry) {
        try {
          await section.saveEntry(container, row);
        } catch {
          /* left open for the user to save manually */
        }
      }
    }
    return { ok: true, filled, skipped, entryCount: targetCount };
  }

  window.ProactiveSectionHierarchy = { detectSections, fillSection, groupFieldId, leafFieldId };
})();
