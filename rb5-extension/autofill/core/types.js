/* =====================================================================
 * Auto-fill — public types (JSDoc only, zero runtime)
 * =====================================================================
 * This file exists for editors and contributors — nothing here ships to
 * the page. Every typedef below is the shape an external caller (the
 * side panel, a future cloud autofill service, a test) sees when they
 * use the public API on `window.ProactiveAutofill`.
 *
 * Bidirectional contract: changing one of these shapes is an API break
 * and requires updating sidepanel.js + tests in lockstep. ============ */

/**
 * The user's stored profile — what we fill FROM. Owned by the side
 * panel; passed through unchanged to detectors / handlers.
 * @typedef {Object} Profile
 * @property {string} [id]
 * @property {string} [name]
 * @property {ProfileData} [data]
 */

/**
 * @typedef {Object} ProfileData
 * @property {ProfileContact} [contact]
 * @property {Object<string, *>} [preferences]  Free-form per-profile
 *   answers that override the screening presets' defaults. Read by
 *   pickPreset(label, preferences, contact, profileData).
 * @property {Object<string, *>} [resume]       Tailored resume produced
 *   by /full-generate-and-download. Used for screening Q&A context.
 * @property {Object<string, *>} [job_data]     Extracted JD payload.
 * @property {string}            [cover_letter] Generated cover letter
 *   text. The PDF (if any) travels separately in files[].
 */

/**
 * @typedef {Object} ProfileContact
 * @property {string} [full_name]
 * @property {string} [first_name]
 * @property {string} [last_name]
 * @property {string} [preferred_first_name]
 * @property {string} [preferred_last_name]
 * @property {string} [preferred_name]
 * @property {string} [email]
 * @property {string} [phone]
 * @property {string} [phone_country_code]      "+48" | "48" | "PL" | "Poland"
 * @property {string} [location]                "City, Region, Country"
 * @property {string} [linkedin]
 * @property {string} [github]
 * @property {string} [date_of_birth]
 */

/**
 * Inputs to a single fillAll invocation. The side panel constructs
 * one of these per click and passes it across the message bridge.
 * @typedef {Object} FillContext
 * @property {Profile}    profile
 * @property {string}     [pdfBase64]            Resume PDF, raw base64.
 * @property {string}     [pdfFilename]
 * @property {string}     [jobText]              Raw JD text for salary parsing.
 * @property {string}     [coverLetterPdfBase64]
 * @property {string}     [coverLetterFilename]
 * @property {string}     [coverLetterText]      For textarea cover-letter slots.
 * @property {"basic"|"advanced"} [mode]         Optional hint; pipelines
 *   default to "basic" when omitted.
 */

/**
 * The end-state of a fillAll invocation, returned to the side panel.
 * @typedef {Object} FillResult
 * @property {FilledField[]}  filled              Contact + adapter-mapped fills.
 * @property {SkippedField[]} skipped             Fields detected but not filled (no profile value).
 * @property {PresetFilled[]} presetFilled        Screening-preset fills (Yes/No, salary, etc.).
 * @property {boolean}        resumeAttached
 * @property {boolean}        coverLetterAttached
 * @property {boolean}        coverLetterPasted
 * @property {string}         adapterLabel        "Greenhouse" | "Lever" | "Workday" | "Generic"
 * @property {Question[]}     questions           Screening textareas + question-shaped inputs
 *   awaiting /answer-questions. Empty for Basic mode.
 * @property {Dropdown[]}     dropdowns           Unfilled dropdowns awaiting LLM picks.
 *   Empty for Basic mode.
 * @property {boolean}        hasNextStep         True if a Next / Continue button is on the page.
 */

/**
 * @typedef {Object} FilledField
 * @property {string}                            key         Profile-data key (full_name, email, …).
 * @property {string}                            value
 * @property {"high"|"medium"|"preset"|"low"}    confidence
 */

/** @typedef {{key: string, reason: string}} SkippedField */

/**
 * @typedef {Object} PresetFilled
 * @property {string} key                                    Preset key.
 * @property {string} label                                  Question label as it appeared on the page.
 * @property {string} answer
 * @property {"dropdown"|"radio"|"checkbox"|"text"|"textarea"|"typeahead"} via
 */

/** @typedef {{id: string, label: string}} Question */
/** @typedef {{id: string, label: string, options: string[]}} Dropdown */

/**
 * An ATS adapter — host-specific selectors registered via
 * `pipeline.registry.registerAdapter`. The pipeline picks the first
 * adapter whose hostTest passes; adapter.detect() returns a partial
 * FieldMap of contact / file inputs the generic heuristic can't beat.
 * @typedef {Object} Adapter
 * @property {string}                       name         e.g. "Greenhouse"
 * @property {(host: string) => boolean}    hostTest
 * @property {() => FieldMap}               detect
 */

/**
 * @typedef {Object} FieldMap
 * @property {HTMLElement}  [first_name]
 * @property {HTMLElement}  [last_name]
 * @property {HTMLElement}  [full_name]
 * @property {HTMLElement}  [email]
 * @property {HTMLElement}  [phone]
 * @property {HTMLElement}  [linkedin]
 * @property {HTMLElement}  [github]
 * @property {HTMLElement}  [location]
 * @property {HTMLInputElement} [__resumeFile]
 * @property {HTMLInputElement} [__coverLetterFile]
 */

/**
 * A screening-question preset — label-regex matcher + canonical answer.
 * Registered via `pipeline.registry.registerPreset`.
 * @typedef {Object} Preset
 * @property {string} key
 * @property {RegExp} match
 * @property {"yes_no"|"text"|"salary"|"sensitive"|"date"|"country_match"|
 *           "country_extract"|"region_map"|"current_company"|"languages"} kind
 * @property {string} [default]
 * @property {string} [readFromContact]      Profile contact key to read from.
 * @property {string[]} [synonyms]           Additional answer strings to try
 *   when applying to a dropdown / radio that doesn't have the exact answer.
 */

/**
 * The shape of a detector step in the pipeline.
 * @typedef {(ctx: FillStepContext) => Promise<void>|void} FillStep
 */

/**
 * Shared mutable bag passed between pipeline steps. The pipeline owns
 * the result object so a step can append fills, mark elements as
 * "touched", etc.
 * @typedef {Object} FillStepContext
 * @property {FillContext}   input
 * @property {FillResult}    result
 * @property {FieldMap}      map           Filled in by the contact detector + adapter.
 * @property {string}        adapterLabel
 */

/**
 * Lightweight envelope for the {ok, error, ...} responses we send back
 * across the chrome.runtime.sendMessage boundary. Mirrors the dashboard /
 * server `{ok, code, message}` shape.
 * @typedef {Object} MessageResponse
 * @property {boolean}  ok
 * @property {string}   [error]
 * @property {string}   [detail]
 * @property {*}        [data]
 */

// Intentionally empty runtime: this file is documentation only.
