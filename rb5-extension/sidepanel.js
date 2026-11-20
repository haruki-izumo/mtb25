// sidepanel.js — JWT auth, BCD profiles, flat per-tab state; one global save folder (all tabs).
//
// API_BASE is hardcoded. Edit this single constant when deploying.
// Points at the Interview Manager Next.js backend (merged rb5 APIs).
// const API_BASE = "http://localhost:3000/api";
const API_BASE = "https://mtb25.onrender.com/api";
// The web app itself. The extension links to it via the small
// "Dashboard" button in the header.
// const DASHBOARD_URL = "http://localhost:3000/profiles";
const DASHBOARD_URL = "https://mtb25.onrender.com/profiles";

// The socket.io server lives on the same origin as the API, one path
// segment up (API_BASE's own "/api" suffix stripped) — see connectRealtime.
const SOCKET_ORIGIN = API_BASE.replace(/\/api\/?$/, "");

const STORAGE = {
  token: "ab_token",
  email: "ab_email",
  name: "ab_name",
  avatar: "ab_avatar",
  role: "ab_role",
  roleTags: "ab_roleTags",
  // The profile bookmarked with a star in the picker — see STARRED_PROFILE_ID.
  starredProfileId: "ab_starredProfileId",
  // "auto" (the current OpenAI-driven flow) or "manual" (generate the
  // resume by hand instead of calling OpenAI with params) — set from the
  // Settings tab's own Shortcuts sub-tab, see initResumeModeToggle. "auto"
  // if unset.
  resumeMode: "ab_resumeMode",
  // Manual mode's target chat — see openFreshBananaChatGptTab's own comment.
  manualChatGptUrl: "ab_manualChatGptUrl",
  // Which key the API Key row's </> buttons currently point at, when the
  // assigned key is a Group (a pool of keys — see the BCD web app's API
  // Key modal Single/Group toggle) — one index per mode, since Pro and
  // Free each resolve a completely different vault entry (User.apiKeyId
  // vs freeApiKeyId) that can each independently be a group or not. See
  // currentKeySelection/renderApiKeyGroupUI.
  apiKeyIndexPro: "ab_apiKeyIndexPro",
  apiKeyIndexFree: "ab_apiKeyIndexFree",
};

// This extension is bidder-facing only — bidders are its actual users
// (reading their own assigned profile, generating a tailored resume), and
// admins get it too for support/testing. Every other role (caller, team
// manager, developer, superadmin, affiliate) signs in fine on bcd.llc itself
// but is refused a session HERE. This is an extension-side gate only — it
// doesn't touch or revoke their real BCD login, it just never stores the
// token client-side, so the extension has nothing to act as them with.
//
// A member can hold more than one role tag (roleTags) in BCD now — `role`
// (the single field this used to key off) is only the highest-priority one
// (see the server's resolveRole: caller beats bidder beats developer), so a
// caller+bidder combo member's `role` reads 'caller' alone even though
// they're also a bidder. isBidderLike checks the full roleTags set instead,
// falling back to `role` for an account with no roleTags at all.
const ROLE_BLOCKED_MESSAGE =
  "This extension is for bidders only. Ask an admin if you believe you should have access.";
function isBidderLike({ role, roleTags }) {
  return Array.isArray(roleTags) && roleTags.length ? roleTags.includes("bidder") : role === "bidder";
}
function isRoleAllowed(user) {
  return user?.role === "admin" || isBidderLike(user || {});
}

// A second, bidder-only gate on top of the role check above: BCD's admin turns
// extension access on per bidder (Contacts.jsx member Settings tab), off by
// default. A bidder with a perfectly valid role still can't sign in HERE until
// their admin flips that toggle — same "never store the token" mechanism as
// the role gate, not a lock on their real BCD account. Admins are exempt (their
// own access comes from isRoleAllowed's admin check alone, same as always).
const EXTENSION_DISABLED_MESSAGE =
  "Your admin hasn't turned on extension access for you yet. Ask them to enable it in your account settings.";
function isExtensionEnabledFor(user) {
  return !isBidderLike(user || {}) || !!user?.extensionEnabled;
}

function sendToBG(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

/**
 * Fetch the current branding version from the server. If a custom
 * mark has been uploaded (version > 0), swap the src on the header
 * and login-orb <img> tags to the versioned server URL. If no custom
 * branding is set or the fetch fails, leave the bundled icons/logo.png
 * in place so the panel never shows a broken image.
 *
 * The <img> tags carry an onerror fallback that puts icons/logo.png
 * back if the remote URL itself 404s or CORS-fails.
 */
async function applyBrandingLogos() {
  const trimmed = API_BASE.replace(/\/+$/, "");
  let version = 0;
  try {
    const res = await fetch(`${trimmed}/branding/version`);
    if (!res.ok) return;
    const body = await res.json();
    version = Number(body?.version) || 0;
  } catch { return; }
  if (!version) return;

  const url = `${trimmed}/branding/logo.png?size=128&v=${version}`;
  for (const id of ["brandLogoHeader", "brandLogoLogin"]) {
    const img = document.getElementById(id);
    if (!img) continue;
    // Preload the image so we only swap when it decodes successfully;
    // otherwise we could momentarily flash a broken icon.
    const test = new Image();
    test.onload = () => { img.src = url; };
    test.onerror = () => { /* keep bundled fallback */ };
    test.src = url;
  }
}

const els = {
  genProgressFill: document.getElementById("genProgressFill"),
  stopGenerateBtn: document.getElementById("stopGenerateBtn"),
  companyName: document.getElementById("companyName"),
  roleTitle: document.getElementById("roleTitle"),
  jobMetaLocationRow: document.getElementById("jobMetaLocationRow"),
  jobMetaLocationValue: document.getElementById("jobMetaLocationValue"),
  jobMetaSalaryRow: document.getElementById("jobMetaSalaryRow"),
  jobMetaSalaryValue: document.getElementById("jobMetaSalaryValue"),
  jobMetaPostedRow: document.getElementById("jobMetaPostedRow"),
  jobMetaPostedValue: document.getElementById("jobMetaPostedValue"),
  detectJobBtn: document.getElementById("detectJobBtn"),
  autoApplyBtn: document.getElementById("autoApplyBtn"),
  profileSelect: document.getElementById("profileSelect"),
  jobText: document.getElementById("jobText"),
  copyJdBtn: document.getElementById("copyJdBtn"),
  downloadJdBtn: document.getElementById("downloadJdBtn"),
  generateBtn: document.getElementById("generateBtn"),
  generateHotkey: document.getElementById("generateHotkey"),
  autofillBtn: document.getElementById("autofillBtn"),
  autofillHotkey: document.getElementById("autofillHotkey"),
  autofillReviewCommitHotkey: document.getElementById("autofillReviewCommitHotkey"),
  autofillAdvancedBtn: document.getElementById("autofillAdvancedBtn"),
  autofillProgressFill: document.getElementById("autofillProgressFill"),
  downloadCvBtn: document.getElementById("downloadCvBtn"),
  browseDownloadFolderBtn: document.getElementById("browseDownloadFolderBtn"),
  downloadFolderHint: document.getElementById("downloadFolderHint"),
  shortcutGenerate: document.getElementById("shortcutGenerate"),
  shortcutAutofill: document.getElementById("shortcutAutofill"),
  editShortcutsBtn: document.getElementById("editShortcutsBtn"),
  autofillStatus: document.getElementById("autofillStatus"),
  genStatus: document.getElementById("genStatus"),
  qaSection: document.getElementById("qaSection"),
  qaPanel: document.getElementById("qaPanel"),
  qaOverlay: document.getElementById("qaOverlay"),
  qaComposer: document.querySelector(".qa-composer"),
  qaBackBtn: document.getElementById("qaBackBtn"),
  qaInput: document.getElementById("qaInput"),
  askBtn: document.getElementById("askBtn"),
  qaThread: document.getElementById("qaThread"),
  genToneDisplay: document.getElementById("genToneDisplay"),
  resumeModeToggle: document.getElementById("resumeModeToggle"),
  manualChatGptStatus: document.getElementById("manualChatGptStatus"),
  manualChatGptStatusLabel: document.getElementById("manualChatGptStatusLabel"),
  manualChatGptUrlRow: document.getElementById("manualChatGptUrlRow"),
  manualChatGptUrlInput: document.getElementById("manualChatGptUrlInput"),
  manualChatGptUrlOpenIcon: document.getElementById("manualChatGptUrlOpenIcon"),
  apiKeyCheckRow: document.getElementById("apiKeyCheckRow"),
  apiKeyCheckIcon: document.getElementById("apiKeyCheckIcon"),
  apiKeyPreviewText: document.getElementById("apiKeyPreviewText"),
  apiKeyTestResult: document.getElementById("apiKeyTestResult"),
  // Group cycling (</> + "2/5") — hidden unless the resolved key is a
  // Group. See renderApiKeyGroupUI.
  apiKeyGroupNav: document.getElementById("apiKeyGroupNav"),
  apiKeyPrevBtn: document.getElementById("apiKeyPrevBtn"),
  apiKeyNextBtn: document.getElementById("apiKeyNextBtn"),
  apiKeyGroupIndex: document.getElementById("apiKeyGroupIndex"),
  scrollTopBtn: document.getElementById("scrollTopBtn"),
  scrollBottomBtn: document.getElementById("scrollBottomBtn"),
  panelToast: document.getElementById("panelToast"),
  mainTabs: document.getElementById("mainTabs"),
  accountTabPanel: document.getElementById("accountTabPanel"),
  settingsSubTabs: document.getElementById("settingsSubTabs"),
  settingsPromptPanel: document.getElementById("settingsPromptPanel"),
  settingsFilenamesPanel: document.getElementById("settingsFilenamesPanel"),
  settingsShortcutsPanel: document.getElementById("settingsShortcutsPanel"),
  profileTabPanel: document.getElementById("profileTabPanel"),
  applyTabPanel: document.getElementById("applyTabPanel"),
  apply2TabPanel: document.getElementById("apply2TabPanel"),
  autofillReviewTitle: document.getElementById("autofillReviewTitle"),
  autofillReviewLogo: document.getElementById("autofillReviewLogo"),
  autofillReviewLogoFallback: document.getElementById("autofillReviewLogoFallback"),
  autofillReviewRefreshBtn: document.getElementById("autofillReviewRefreshBtn"),
  autofillReviewEmpty: document.getElementById("autofillReviewEmpty"),
  autofillReviewList: document.getElementById("autofillReviewList"),
  autofillReviewCommitBtn: document.getElementById("autofillReviewCommitBtn"),
  autofillReviewCommitFill: document.getElementById("autofillReviewCommitFill"),
  autofillReviewStopWrap: document.getElementById("autofillReviewStopWrap"),
  autofillReviewStopBtn: document.getElementById("autofillReviewStopBtn"),
  tabsyncTabPanel: document.getElementById("tabsyncTabPanel"),
  copyOpenTabsBtn: document.getElementById("copyOpenTabsBtn"),
  tabsyncSubTabs: document.getElementById("tabsyncSubTabs"),
  tabsyncLinkedinPanel: document.getElementById("tabsyncLinkedinPanel"),
  tabsyncLinkedinList: document.getElementById("tabsyncLinkedinList"),
  tabsyncLinkedinPager: document.getElementById("tabsyncLinkedinPager"),
  tabsyncPagerPrev: document.getElementById("tabsyncPagerPrev"),
  tabsyncPagerNext: document.getElementById("tabsyncPagerNext"),
  tabsyncPagerLabel: document.getElementById("tabsyncPagerLabel"),
  tabsyncManualPanel: document.getElementById("tabsyncManualPanel"),
  tabsyncInput: document.getElementById("tabsyncInput"),
  tabsyncLinksStats: document.getElementById("tabsyncLinksStats"),
  tabsyncLinkedinCountryFilter: document.getElementById("tabsyncLinkedinCountryFilter"),
  tabsyncLinkedinRoleFilter: document.getElementById("tabsyncLinkedinRoleFilter"),
  openTabsBtn: document.getElementById("openTabsBtn"),
  profileTabSelect: document.getElementById("profileTabSelect"),
  profileTabDetail: document.getElementById("profileTabDetail"),
  profileListEmpty: document.getElementById("profileListEmpty"),
  updateBanner: document.getElementById("updateBanner"),
  updateBannerText: document.getElementById("updateBannerText"),
  updateBannerNotes: document.getElementById("updateBannerNotes"),
  updateBtn: document.getElementById("updateBtn"),
  updateAppBtn: document.getElementById("updateAppBtn"),
  updateDismissBtn: document.getElementById("updateDismissBtn"),
  tabsyncUnappliedBadge: document.getElementById("tabsyncUnappliedBadge"),
  viewCoverBtn: document.getElementById("viewCoverBtn"),
  copyCoverBtn: document.getElementById("copyCoverBtn"),
  downloadCoverPdfBtn: document.getElementById("downloadCoverPdfBtn"),
  coverText: document.getElementById("coverText"),
  resumeText: document.getElementById("resumeText"),
  viewResumeBtn: document.getElementById("viewResumeBtn"),
  copyResumeBtn: document.getElementById("copyResumeBtn"),
  downloadResumeBtn: document.getElementById("downloadResumeBtn"),
  resumeSectionHead: document.getElementById("resumeSectionHead"),
  coverSectionHead: document.getElementById("coverSectionHead"),
  markAppliedBtn: document.getElementById("markAppliedBtn"),
  markAppliedLabel: document.getElementById("markAppliedLabel"),
  fieldModalBackdrop: document.getElementById("fieldModalBackdrop"),
  fieldModalTitle: document.getElementById("fieldModalTitle"),
  fieldModalBody: document.getElementById("fieldModalBody"),
  fieldModalBackBtn: document.getElementById("fieldModalBackBtn"),
  fitWarningBackdrop: document.getElementById("fitWarningBackdrop"),
  fitWarningBadge: document.getElementById("fitWarningBadge"),
  fitWarningReasons: document.getElementById("fitWarningReasons"),
  fitWarningNote: document.getElementById("fitWarningNote"),
  fitWarningContinueBtn: document.getElementById("fitWarningContinueBtn"),
  dupWarningBackdrop: document.getElementById("dupWarningBackdrop"),
  dupWarningNote: document.getElementById("dupWarningNote"),
  dupWarningContinueBtn: document.getElementById("dupWarningContinueBtn"),
  tabsyncAppliedConfirmBackdrop: document.getElementById("tabsyncAppliedConfirmBackdrop"),
  tabsyncAppliedConfirmMsg: document.getElementById("tabsyncAppliedConfirmMsg"),
  tabsyncAppliedConfirmNoBtn: document.getElementById("tabsyncAppliedConfirmNoBtn"),
  tabsyncAppliedConfirmYesBtn: document.getElementById("tabsyncAppliedConfirmYesBtn"),
  shortcutEmailBtn: document.getElementById("shortcutEmailBtn"),
  shortcutPhoneBtn: document.getElementById("shortcutPhoneBtn"),
  shortcutLinkedinBtn: document.getElementById("shortcutLinkedinBtn"),
  shortcutGithubBtn: document.getElementById("shortcutGithubBtn"),
  shortcutAddressBtn: document.getElementById("shortcutAddressBtn"),
  shortcutZipBtn: document.getElementById("shortcutZipBtn"),
  shortcutCompanyBtn: document.getElementById("shortcutCompanyBtn"),
  loginModal: document.getElementById("loginModal"),
  loginModalError: document.getElementById("loginModalError"),
  loggedInBar: document.getElementById("loggedInBar"),
  loginEmail: document.getElementById("loginEmail"),
  loginPassword: document.getElementById("loginPassword"),
  loginPasswordToggle: document.getElementById("loginPasswordToggle"),
  loginBtn: document.getElementById("loginBtn"),
  loginCopyrightYear: document.getElementById("loginCopyrightYear"),
  applyPromptValue: document.getElementById("applyPromptValue"),
  applyAutofillPromptValue: document.getElementById("applyAutofillPromptValue"),
  applyTemplateValue: document.getElementById("applyTemplateValue"),
  applyDateFormatValue: document.getElementById("applyDateFormatValue"),
  applyEducationValue: document.getElementById("applyEducationValue"),
  bulletRangeValue: document.getElementById("bulletRangeValue"),
  bulletCountToken: document.getElementById("bulletCountToken"),
  bulletCountTokenStatus: document.getElementById("bulletCountTokenStatus"),
  filenameResumeInput: document.getElementById("filenameResumeInput"),
  filenameCoverInput: document.getElementById("filenameCoverInput"),
  filenameJdInput: document.getElementById("filenameJdInput"),
  userMenuBtn: document.getElementById("userMenuBtn"),
  userInitial: document.getElementById("userInitial"),
  userLabel: document.getElementById("userLabel"),
  userMenu: document.getElementById("userMenu"),
  userMenuAvatar: document.getElementById("userMenuAvatar"),
  userMenuName: document.getElementById("userMenuName"),
  userMenuEmail: document.getElementById("userMenuEmail"),
  userMenuProfileBtn: document.getElementById("userMenuProfileBtn"),
  userMenuSettingsBtn: document.getElementById("userMenuSettingsBtn"),
  userMenuSignOutBtn: document.getElementById("userMenuSignOutBtn"),
  mainContent: document.getElementById("mainContent"),
};

let CURRENT_WINDOW_ID = null;
let TAB_ID = null;
let STATE = null;
// Auto Apply — see runAutoApply. RUNNING gates the button into a Start/Stop
// toggle; STOP_REQUESTED is polled between steps so Stop takes effect at
// the next safe point instead of aborting mid-tab.
let AUTO_APPLY_RUNNING = false;
let AUTO_APPLY_STOP_REQUESTED = false;
// Gap between clicking Generate on one tab and switching to the next — long
// enough to actually SEE it start running (the "Generating…" status +
// progress bar) before the panel moves on and repaints for the next tab,
// not just enough for the network calls to settle. Generate itself is still
// NOT awaited before advancing — it keeps running in the background on its
// own tab (see the recent background-tab stability fixes) — this is purely
// about giving the run a visible pulse per tab instead of blinking past it.
const AUTO_APPLY_PACE_MS = 2500;
/** Tabs with an Auto-fill run in flight. The side panel is ONE shared
 *  instance, so disabling the button globally locked Auto-fill in every
 *  tab while a single tab was filling. Busy-ness is per-tab: a run is
 *  refused only for the tab already filling, and the button reflects
 *  whichever tab is currently on screen. @type {Set<number>} */
const RUNNING_TABS = new Set();
/** Tabs whose LAST Auto-fill run finished successfully — the button's own
 *  fill (see stopAutofillProgress) should stay at 100% for these across a
 *  tab switch, same as Generate's persisted generatingStatus does; Auto-fill
 *  has no such persisted field, so this in-memory set (session-only, not
 *  survived by a panel reopen) is what loadForTab checks instead of
 *  unconditionally wiping the fill back to white for every non-running tab.
 *  @type {Set<number>} */
const AUTOFILL_DONE_TABS = new Set();

/** Same idea as AUTOFILL_DONE_TABS, but specifically for whether the resume
 *  FILE got attached during the tab's last Auto-fill run — a real, distinct
 *  pipeline outcome (see autofill/pipeline/basic.js's stepAttachResume /
 *  ctx.result.resumeAttached), separate from whether the rest of the form's
 *  fields got filled. Session-only, same as AUTOFILL_DONE_TABS.
 *  @type {Set<number>} */
const RESUME_UPLOADED_TABS = new Set();

/** Point the Auto-fill buttons at the VISIBLE tab's busy state. */
function syncAutofillButtons() {
  const busy = TAB_ID != null && RUNNING_TABS.has(TAB_ID);
  if (els.autofillBtn) els.autofillBtn.disabled = busy;
  if (els.autofillAdvancedBtn) els.autofillAdvancedBtn.disabled = busy;
}

/** Unlike AUTOFILL_DONE_TABS/RESUME_UPLOADED_TABS (session-only, per-tab
 *  Sets with no visible check-row of their own any more — "Resume Uploaded"/
 *  "Form auto filled" were removed, though the Sets themselves are still
 *  read by watchAutoApplyResult's own toast and the Auto-fill button's own
 *  fill state), this one is server state tied to the generation itself
 *  (STATE.submitted, persisted via savePatch — see markAsApplied) — only
 *  DISABLED (not hidden) until there's actually a generation to mark. A
 *  second click undoes it — see markAsApplied — so the button itself never
 *  disables just because it's already done. */
let markAppliedBtnWidthLocked = false;
/** Measures how wide the button would be showing "Mark as Applied" — the
 *  longer of its two labels — via an offscreen clone, regardless of which
 *  state is actually on screen right now. Doing it off a clone (instead of
 *  only measuring when the real button happens to render un-done) fixes a
 *  real bug: reopening the panel while a generation is already marked
 *  applied rendered the button in its "Applied" state on the very first
 *  paint, so the old "measure it the first time it's un-done" check never
 *  fired and the lock never got set at all — the button just stayed at its
 *  smaller natural width for the whole session. */
function lockMarkAppliedBtnWidth() {
  if (markAppliedBtnWidthLocked || !els.markAppliedBtn) return;
  const probe = els.markAppliedBtn.cloneNode(true);
  probe.removeAttribute("id");
  probe.disabled = false;
  probe.classList.remove("done");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.minWidth = "0";
  const label = probe.querySelector(".check-row__label");
  if (label) label.textContent = "Mark as Applied";
  document.body.appendChild(probe);
  const w = probe.offsetWidth;
  probe.remove();
  if (w > 0) {
    els.markAppliedBtn.style.minWidth = `${w}px`;
    markAppliedBtnWidthLocked = true;
  }
}
function syncMarkAppliedRow() {
  const hasGeneration = !!STATE?.generationId;
  const done = !!STATE?.submitted;
  els.markAppliedBtn?.classList.toggle("done", done);
  // Always clickable now, even with no generation yet — markAsApplied
  // itself tells the user why it didn't work (a toast) instead of the
  // button silently refusing to respond (confirmed real complaint: a
  // disabled button with no generation gave no feedback at all beyond a
  // hover-only tooltip most people never see).
  if (els.markAppliedLabel) {
    els.markAppliedLabel.textContent = done ? "Applied" : "Mark as Applied";
  }
  lockMarkAppliedBtnWidth();
  const title = !hasGeneration
    ? "Generate a resume first"
    : done
      ? "Undo"
      : "Click after you've actually submitted this application on the company's site";
  if (els.markAppliedBtn) {
    els.markAppliedBtn.title = title;
    els.markAppliedBtn.setAttribute("aria-label", done ? "Undo — Mark as Applied" : "Mark as Applied");
  }
}

/** The extension's own "I actually submitted this on the company's site"
 *  button — separate from tryMarkApplied above (which fires automatically
 *  at download time for a different, already-existing feature). A toggle:
 *  clicking it again undoes it, which also clears the check on the BCD
 *  Applications table's own Submitted column (see markSubmitted server-
 *  side). Calls the dedicated mark-submitted endpoint and persists the
 *  result onto this tab's own state so it survives a tab switch/reopen. */
async function markAsApplied() {
  const generationId = STATE?.generationId;
  const tabId = TAB_ID;
  if (!tabId) return;
  if (!generationId) {
    panelToast("Generate a resume first", "error");
    return;
  }
  const next = !STATE?.submitted;
  if (els.markAppliedBtn) els.markAppliedBtn.disabled = true;
  try {
    await apiFetch(`/me/applications/${generationId}/mark-submitted`, {
      method: "POST",
      body: JSON.stringify({ submitted: next }),
    });
    await savePatch(tabId, { submitted: next });
    syncMarkAppliedRow();
    panelToast(next ? "Marked as applied" : "Unmarked");
  } catch (e) {
    panelToast(e?.message || "Could not update", "error");
  } finally {
    // Always re-enabled — only disabled transiently above while this
    // request is in flight, not based on whether a generation exists (see
    // syncMarkAppliedRow's own comment).
    if (els.markAppliedBtn) els.markAppliedBtn.disabled = false;
  }
}
/** @type {{ id: string, name: string }[]} */
let PROFILE_OPTIONS = [];
// The one profile marked with a filled star in the picker (see
// populateProfiles/toggleStarredProfile) — purely a local bookmark, doesn't
// affect which profile is actually selected/generating. Loaded once in
// loadProfilesFromServer, kept in sync with chrome.storage.local from there.
let STARRED_PROFILE_ID = "";
// promptId -> title, from GET /prompts/options (any signed-in member may
// call it — see promptRoutes.js's own comment). Rebuilt alongside
// PROFILE_OPTIONS every time profiles reload, so each profile's dropdown
// row can show which prompt it's using (see loadProfilesFromServer).
let PROMPT_TITLE_BY_ID = new Map();
let DEFAULT_PROMPT_TITLE = "Default";
// Same shape as PROMPT_TITLE_BY_ID/DEFAULT_PROMPT_TITLE above, for Auto-fill
// prompts (GET /prompts/options?kind=autofill) — see loadAutoFillPromptTitles
// and renderApplySettingsReadOnly's Apply-tab mirror.
let AUTOFILL_PROMPT_TITLE_BY_ID = new Map();
let DEFAULT_AUTOFILL_PROMPT_TITLE = "Default";
let PROFILE_LINKS = { linkedin: "", github: "", address: "", phone: "", email: "", zipcode: "", lastCompany: "" };
/** Full BCD profile objects keyed by _id, from the same /profiles call that
 *  populates PROFILE_OPTIONS — see loadProfilesFromServer/loadProfileLinks. */
let PROFILES_BY_ID = new Map();

/**
 * Read an auth value from chrome.storage.local — always persisted, always
 * across browser restarts. ("Keep me signed in" — an opt-out into
 * session-only storage — was removed; the extension only ever behaves the
 * way that checkbox's checked/default state already did.)
 */
async function getAuthValue(key) {
  const v = await chrome.storage.local.get(key);
  return (v && v[key]) || "";
}

async function getToken() {
  return (await getAuthValue(STORAGE.token)) || "";
}

/** The profile bookmarked with a star in the picker (see STARRED_PROFILE_ID). */
async function getStarredProfileId() {
  return (await getAuthValue(STORAGE.starredProfileId)) || "";
}
async function setStarredProfileId(id) {
  try {
    await chrome.storage.local.set({ [STORAGE.starredProfileId]: id || "" });
  } catch { /* best effort */ }
}

async function getRole() {
  return (await getAuthValue(STORAGE.role)) || "";
}

// Stored as a JSON array (chrome.storage values aren't limited to strings,
// but getAuthValue's `|| ""` fallback assumes one — parsed defensively so a
// missing/corrupt value never throws, just reads as "no extra tags").
async function getRoleTags() {
  const raw = await chrome.storage.local.get(STORAGE.roleTags);
  const v = raw && raw[STORAGE.roleTags];
  return Array.isArray(v) ? v : [];
}

async function setAuthStorage({ token, email, name, avatar, role, roleTags }) {
  const p = {};
  if (token !== undefined) p[STORAGE.token] = token;
  if (email !== undefined) p[STORAGE.email] = email;
  if (name !== undefined) p[STORAGE.name] = name;
  if (avatar !== undefined) p[STORAGE.avatar] = avatar;
  if (role !== undefined) p[STORAGE.role] = role;
  if (roleTags !== undefined) p[STORAGE.roleTags] = roleTags;
  await chrome.storage.local.set(p);
  if (token) scheduleSessionExpiry(token);
}

let sessionTimer = null;

function readJwtExpMs(jwtToken) {
  try {
    const parts = String(jwtToken || "").split(".");
    if (parts.length < 2) return null;
    const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(json);
    const exp = Number(payload?.exp);
    if (!Number.isFinite(exp) || exp <= 0) return null;
    return exp * 1000;
  } catch {
    return null;
  }
}

function clearSessionTimer() {
  if (sessionTimer) {
    clearTimeout(sessionTimer);
    sessionTimer = null;
  }
}

// Browsers store setTimeout delays as signed 32-bit ints; anything above
// this (~24.8d) overflows and the callback runs immediately — which, for our
// 30d JWTs, was wiping the session right after sign-in.
const MAX_SAFE_TIMEOUT_MS = 2147483647;

function scheduleSessionExpiry(jwtToken) {
  clearSessionTimer();
  const expMs = readJwtExpMs(jwtToken);
  if (!expMs) return;
  const delay = expMs - Date.now();
  if (delay <= 0) {
    expireSessionNow();
    return;
  }
  const wait = Math.min(delay, MAX_SAFE_TIMEOUT_MS);
  sessionTimer = setTimeout(() => {
    // Clamped early wake: reschedule until the real exp, don't treat as expiry.
    if (Date.now() < expMs) {
      scheduleSessionExpiry(jwtToken);
      return;
    }
    expireSessionNow();
  }, wait);
}

async function expireSessionNow() {
  clearSessionTimer();
  disconnectRealtime();
  await clearAuthStorage();
  PROFILE_OPTIONS = [];
  try {
    populateProfiles(els.profileSelect, "", chooseProfile);
  } catch {
    /* ignore */
  }
  try {
    setTabsyncBadge(0);
  } catch {
    /* ignore */
  }
  await updateLoginGate();
  try {
    await refreshAuthUI();
  } catch {
    /* ignore */
  }
  setLoginModalError("Session expired. Please sign in again.");
  if (TAB_ID != null) setStatus(TAB_ID, "Session expired. Please sign in again.", "idle");
}

async function clearAuthStorage() {
  clearSessionTimer();
  await chrome.storage.local.remove([
    STORAGE.token,
    STORAGE.email,
    STORAGE.name,
    STORAGE.avatar,
    STORAGE.role,
    STORAGE.roleTags,
  ]);
}

// ---- Session heartbeat ------------------------------------------------
// ProActive used this to hold a one-device sign-in lock (POST /me/heartbeat
// every 60s while the panel was open) plus opportunistically retry failed
// application-tracking writes (flushPendingPromotions, /me/applications —
// BCD has neither of those). BCD dropped single-active-session enforcement
// entirely (a user can be signed in from multiple places at once — see the
// web app's sessions[] model), so there's no lock to hold here — but the
// interval itself is reused for a much simpler purpose now: telling the
// server "the extension is actively in use" (PATCH /users/extension-presence
// -> User.extensionLastSeen), same idea as the web/desktop app's own
// lastSeen heartbeat, just a separate field — shown on the org's own
// Resume > Extension page. Runs once immediately (so activity registers the
// moment the panel opens, not up to 60s later) then every 60s while signed
// in; stops when signed out (syncHeartbeat is called after every auth-state
// change via refreshAuthUI, and finds no token).
let HEARTBEAT_ID = null;
const HEARTBEAT_MS = 60000;

function stopHeartbeat() {
  if (HEARTBEAT_ID != null) {
    clearInterval(HEARTBEAT_ID);
    HEARTBEAT_ID = null;
  }
}

async function pingExtensionPresence() {
  try {
    await apiFetch("/users/extension-presence", {
      method: "PATCH",
      // manifest.json's own version — shown next to Use Extension on the
      // Resume > Extension page so an admin can tell who's on an old build.
      body: JSON.stringify({ version: chrome.runtime.getManifest().version }),
    });
  } catch {
    /* offline / signed out — the next tick (or the next refreshAuthUI) retries */
  }
}

async function syncHeartbeat() {
  stopHeartbeat();
  const token = await getToken();
  if (!token) return;
  void pingExtensionPresence();
  HEARTBEAT_ID = setInterval(pingExtensionPresence, HEARTBEAT_MS);
}

// ---- Role-fit rules (server-managed, cached) -------------------------
// The "Likely skip" check's target/avoid keyword lists live server-side now
// (admin-managed global default + optional per-user override). Cache the
// resolved set in chrome.storage.local under ab_fit_rules so content-detect.js
// and this panel share ONE copy, and apply it to this panel's own roles
// module. Everything falls back to the extension's bundled defaults when
// offline / logged-out / not yet fetched.
const FIT_RULES_KEY = "ab_fit_rules";
function applyFitRulesToPanel(rules) {
  try {
    window.ProactiveJobDetect?.normalize?.roles?.setRules?.(rules || null);
  } catch { /* roles module not present — bundled defaults stay active */ }
}
async function applyCachedFitRules() {
  try {
    const { [FIT_RULES_KEY]: cached } = await chrome.storage.local.get(FIT_RULES_KEY);
    if (cached) applyFitRulesToPanel(cached);
  } catch { /* ignore */ }
}
async function refreshFitRules() {
  try {
    const r = await apiFetch("/fit-rules");
    if (r && (Array.isArray(r.avoid) || Array.isArray(r.target))) {
      const rules = { target: r.target || [], avoid: r.avoid || [] };
      await chrome.storage.local.set({ [FIT_RULES_KEY]: rules });
      applyFitRulesToPanel(rules);
    }
  } catch { /* offline / 401 — keep the cache (or bundled defaults) */ }
}

// Tabsync tab's not-yet-applied LinkedIn Jobs badge — same count/endpoint
// the main app's own Application > LinkedIn Jobs nav item polls
// (/linkedin-positions/unapplied-count, per-viewer: an admin sees their own
// applied marks, a bidder sees theirs). Only the outer Tabsync tab button's
// own badge — the LinkedIn Jobs sub-tab underneath it shows the actual rows
// instead of also repeating the number.
function setTabsyncBadge(count) {
  if (!els.tabsyncUnappliedBadge) return;
  const n = count > 0 ? count : 0;
  // Plain dot now, no count text (Tabsync's tab itself went icon-only, same
  // treatment Settings already had) — just needs to say "something's
  // there", not how many.
  els.tabsyncUnappliedBadge.classList.toggle("hidden", n === 0);
}
async function refreshTabsyncUnappliedBadge() {
  try {
    const token = await getToken();
    if (!token) {
      setTabsyncBadge(0);
      return;
    }
    const r = await apiFetch("/linkedin-positions/unapplied-count");
    setTabsyncBadge(r?.count || 0);
  } catch { /* offline / 401 — leave the badge as it was */ }
}

// ---- Mark-applied retry queue ----------------------------------------
// Server-side, a generated CV starts as a "draft" Generation row and
// only becomes a real "applied" row once the user actually downloads
// (or saves) — we call POST /me/applications/:id/mark-applied for that.
//
// If that call fails (network hiccup, transient 5xx, server restart),
// the row stays as draft and the dashboard never shows it — even though
// the user already has the file on disk. To make this self-healing we
// persist failed ids in chrome.storage.local and retry them on every
// subsequent heartbeat until they succeed.
const PENDING_PROMOTIONS_KEY = "ab_pending_promotions";

/**
 * Each queue entry is { id, company, role, jdUrl } so the retry can
 * still post the company / role the user committed at download time
 * even if the form has since changed (or been cleared). Legacy entries
 * stored as bare ids are normalised on read.
 */
function normalisePending(raw) {
  if (!raw) return null;
  if (typeof raw === "string") return { id: raw, company: "", role: "", jdUrl: "" };
  if (typeof raw === "object" && raw.id) {
    return {
      id: String(raw.id),
      company: typeof raw.company === "string" ? raw.company : "",
      role: typeof raw.role === "string" ? raw.role : "",
      jdUrl: typeof raw.jdUrl === "string" ? raw.jdUrl : "",
    };
  }
  return null;
}

async function readPendingPromotions() {
  try {
    const obj = await chrome.storage.local.get(PENDING_PROMOTIONS_KEY);
    const list = obj?.[PENDING_PROMOTIONS_KEY];
    if (!Array.isArray(list)) return [];
    return list.map(normalisePending).filter(Boolean);
  } catch {
    return [];
  }
}

async function writePendingPromotions(list) {
  try {
    // Dedupe by id, keeping the entry with the most metadata (later
    // entries win over earlier ones).
    const byId = new Map();
    for (const e of list || []) {
      const norm = normalisePending(e);
      if (norm) byId.set(norm.id, norm);
    }
    await chrome.storage.local.set({
      [PENDING_PROMOTIONS_KEY]: [...byId.values()],
    });
  } catch {
    /* private mode / quota — non-fatal */
  }
}

async function queuePromotion(generationId, meta = {}) {
  if (!generationId) return;
  const list = await readPendingPromotions();
  const idx = list.findIndex((e) => e.id === generationId);
  const entry = {
    id: generationId,
    company: (meta.company || "").trim(),
    role: (meta.role || "").trim(),
    jdUrl: (meta.jdUrl || "").trim(),
  };
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  await writePendingPromotions(list);
}

async function dequeuePromotion(generationId) {
  if (!generationId) return;
  const list = await readPendingPromotions();
  await writePendingPromotions(list.filter((e) => e.id !== generationId));
}

/**
 * Promote a Generation row from "draft" to "applied". `meta` carries
 * the latest company / role / jdUrl from the form so the server can
 * overwrite anything stale that was captured at generate time (when
 * the user often hasn't filled in the company yet). On failure the id
 * is parked in chrome.storage WITH the meta so flushPendingPromotions
 * can retry later with the same payload — even if the form has been
 * cleared in the meantime.
 */
async function tryMarkApplied(generationId, meta = {}) {
  if (!generationId) return false;
  const body = {};
  const company = (meta.company || "").trim();
  if (company) body.company = company;
  const role = (meta.role || "").trim();
  if (role) body.role = role;
  const jdUrl = (meta.jdUrl || "").trim();
  if (jdUrl) body.jd_url = jdUrl;
  try {
    await apiFetch(`/me/applications/${generationId}/mark-applied`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    await dequeuePromotion(generationId);
    return true;
  } catch (e) {
    // 404 = the server says this id genuinely doesn't exist for this user
    // (account reset, manual delete, etc.). It's a PERMANENT failure —
    // drop it from the queue so the heartbeat doesn't hammer the server
    // with the same dead id every 60s forever. Anything else (network
    // blip, 5xx) is transient and gets re-queued.
    const msg = String(e?.message || "");
    if (/(^|\b)(not_found|404)\b/i.test(msg)) {
      console.warn(`mark-applied permanently failed for ${generationId} — dropping:`, msg);
      await dequeuePromotion(generationId);
      return false;
    }
    console.warn(
      `mark-applied failed for ${generationId} — queued for retry:`,
      e?.message || e,
    );
    await queuePromotion(generationId, meta);
    return false;
  }
}

/**
 * Walk the parked-id queue and retry each one. Successful ids are
 * removed from the queue automatically by tryMarkApplied. Called from
 * the heartbeat tick so it runs roughly once a minute while the side
 * panel is open. Each entry carries its own company / role so the
 * retry posts the same payload the original click would have, not
 * whatever is currently in the form.
 */
async function flushPendingPromotions() {
  const list = await readPendingPromotions();
  if (list.length === 0) return;
  for (const entry of list) {
    // Don't bail on the first failure — try them all, since they may
    // have failed for different reasons (one might be a real "not
    // found" while another was a one-off network blip).
    // eslint-disable-next-line no-await-in-loop
    await tryMarkApplied(entry.id, entry);
  }
}

function buildUrl(ep) {
  return API_BASE.replace(/\/+$/, "") + (ep.startsWith("/") ? ep : "/" + ep);
}

async function apiFetch(path, opts = {}) {
  const { token: tokenOverride, ...fetchOpts } = opts || {};
  const token =
    tokenOverride !== undefined && tokenOverride !== null
      ? String(tokenOverride)
      : await getToken();
  const isLoginPath = typeof path === "string" && path.includes("/auth/login");
  const headers = {
    "Content-Type": "application/json",
    // Lets the server's login-session dedupe (server/src/lib/sessions.js's
    // parseUA) tell this apart from a same-machine, same-browser web tab —
    // without it, both send an identical Chrome User-Agent and dedupe onto
    // the SAME session slot (ip + label), so signing into the web app in an
    // ordinary tab silently stomps the extension's session id and the
    // extension gets 401'd out mid-use on its next request.
    "X-BCD-Client": "extension",
    ...(fetchOpts.headers || {}),
  };
  // Send token on X-BCD-Token (and Authorization). Interview Manager's Auth.js
  // proxy previously treated Authorization Bearer as a NextAuth session JWT and
  // broke extension auth — X-BCD-Token is the reliable channel.
  if (token && !isLoginPath) {
    headers.Authorization = `Bearer ${token}`;
    headers["X-BCD-Token"] = token;
  }
  const url = path.startsWith("http") ? path : buildUrl(path);
  let r;
  try {
    r = await fetch(url, { ...fetchOpts, headers });
  } catch (netErr) {
    // A user-initiated abort (Stop button) must NOT be treated as a transient
    // network drop — otherwise apiFetchRetry would just retry it. Tag it so
    // callers can recognise the cancel and skip the retry/error paths.
    if (netErr?.name === "AbortError") {
      const e = new Error("Generation stopped.");
      e.aborted = true;
      throw e;
    }
    // fetch() rejects on connection failures (ERR_CONNECTION_TIMED_OUT /
    // ERR_CONNECTION_ABORTED / DNS / offline). Tag it so callers can retry
    // transient drops instead of treating them as a hard failure.
    const e = new Error(netErr?.message || "Network request failed");
    e.network = true;
    throw e;
  }
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (r.status === 401) {
    if (!isLoginPath) {
      // Only clear storage when THIS request actually sent a token that is
      // still the active one. An unauthenticated 401 (!token) must not wipe
      // a session stored after the request was already in flight — that race
      // is what produced immediate "Session expired" right after sign-in.
      const currentToken = await getToken();
      if (token && token === currentToken) {
        await clearAuthStorage();
        PROFILE_OPTIONS = [];
        try {
          populateProfiles(els.profileSelect, "", chooseProfile);
        } catch {
          /* ignore */
        }
        await updateLoginGate();
        const code = data?.code;
        if (code === "session_revoked") {
          setLoginModalError(
            "This account is signed in on another device. You've been signed out.",
          );
          throw new Error("This account is signed in on another device.");
        }
        setLoginModalError("Session expired. Please sign in again.");
        throw new Error("Session expired. Please sign in again.");
      }
      throw new Error(data?.message || "Unauthorized");
    }
    const msg = data?.message || data?.detail || "Invalid email or password";
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  if (!r.ok) {
    const code = data?.code;
    const msg =
      data?.message ||
      data?.detail ||
      data?.error ||
      r.statusText ||
      "Request failed";
    const line =
      code && typeof msg === "string"
        ? `${code}: ${msg}`
        : typeof msg === "string"
          ? msg
          : JSON.stringify(msg);
    const err = new Error(line);
    err.status = r.status;
    throw err;
  }
  return data;
}

/** True for errors worth retrying: connection drops (tagged `network`) and
 *  transient server states (429/502/503/504). 4xx (validation / provider
 *  config) and other hard errors are NOT retried — they'd just fail again. */
function isTransientError(err) {
  if (err?.aborted) return false; // user cancelled — never retry
  if (err?.network) return true;
  const s = err?.status;
  if (s === 429 || s === 502 || s === 503 || s === 504) return true;
  if (s && s >= 400 && s < 500) return false; // hard client errors
  return /failed to fetch|networkerror|load failed|timed out|connection|err_/i.test(err?.message || "");
}

/** apiFetch with automatic retry + exponential backoff for transient
 *  failures. Calls onRetry(attempt, maxAttempts, err, delayMs) before each
 *  wait so the UI can show "retrying (2/5)…". Throws the last error only
 *  after exhausting retries (or immediately for non-transient errors). */
async function apiFetchRetry(path, opts = {}, cfg = {}) {
  const retries = cfg.retries ?? 4;
  const baseDelayMs = cfg.baseDelayMs ?? 1200;
  const maxDelayMs = cfg.maxDelayMs ?? 15000;
  let attempt = 0;
  for (;;) {
    try {
      return await apiFetch(path, opts);
    } catch (e) {
      if (attempt >= retries || !isTransientError(e)) throw e;
      attempt += 1;
      // Exponential backoff with a little jitter so a flock of retries
      // doesn't thunder at the server the instant it comes back.
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs) + Math.floor(Math.random() * 300);
      try { cfg.onRetry?.(attempt, retries + 1, e, delay); } catch { /* non-fatal */ }
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

// Capability cache. Filled from /me/whoami on init + after every
// successful login; consulted whenever we need to decide whether to
// show an optional UI piece (the Auto-fill button is the first such
// piece). When the superadmin toggles a capability off in the
// dashboard, the next whoami call picks it up and the UI updates.
let CAPABILITIES = null;
function can(capability) {
  // Permissive default: if the server hasn't told us yet (slow init,
  // offline, very old server), assume the feature is on. The server
  // still enforces the gate, so the worst case is a brief 403 instead
  // of a hidden button.
  if (!CAPABILITIES) return true;
  return CAPABILITIES[capability] !== false;
}

// BCD has no per-capability entitlement/paywall system (unlike ProActive's
// whoami-driven "capabilities" gate) — every signed-in BCD user gets the full
// feature set, so this no longer calls a whoami endpoint. CAPABILITIES stays
// null, and can() below already treats that as "everything enabled". This
// just repaints the header avatar from whatever setAuthStorage cached at
// login (see the /auth/login handler), so the chip is right on every panel
// open without a network round-trip.
async function refreshCapabilities() {
  applyCapabilityVisibility();
  const avatar = await getAuthValue(STORAGE.avatar);
  const name = await getAuthValue(STORAGE.name);
  const email = await getAuthValue(STORAGE.email);
  renderUserAvatar(avatar, name || email);
  // init()'s own call to this happens before there's a token, so it 401s —
  // re-fetch now that a sign-in has actually gone through. Cheap no-op if
  // the list is already populated from a prior successful call this session.
  if (!RESUME_TEMPLATES_CACHE.length) loadResumeTemplates();
}

/** Paint the header account chip: the uploaded photo when present, otherwise
 *  the name/email initial on the gradient. Uses background-image so we don't
 *  have to swap child nodes in/out of the #userInitial span. */
function renderUserAvatar(avatar, label) {
  // Two targets now — the header chip's small avatar and the account
  // dropdown's own bigger copy (#userMenuAvatar) — both driven by the same
  // avatar/label so they can never drift out of sync with each other.
  for (const el of [els.userInitial, els.userMenuAvatar]) {
    if (!el) continue;
    if (avatar) {
      el.textContent = "";
      el.style.backgroundImage = `url("${avatar}")`;
      el.style.backgroundSize = "cover";
      el.style.backgroundPosition = "center";
    } else {
      el.style.backgroundImage = "";
      el.style.backgroundSize = "";
      el.style.backgroundPosition = "";
      el.textContent = (label || "?").trim().charAt(0).toUpperCase();
    }
  }
}

/** Hide / show UI elements whose visibility depends on a capability.
 *  Called after refreshCapabilities + on init. Currently:
 *    - Auto-fill button + its status box. */
function applyCapabilityVisibility() {
  const basicVisible = can("autofill");
  const advancedVisible = can("autofill_advanced");
  if (els.autofillBtn) {
    els.autofillBtn.style.display = basicVisible ? "" : "none";
  }
  // Advanced Auto-fill button is intentionally hidden — Auto-fill is always
  // a manual click (the "Auto-fill" button), never automatic. advancedVisible
  // is still used below to keep the shared status box available for users
  // with that capability, even with no visible Advanced button of their own.
  if (els.autofillAdvancedBtn) {
    els.autofillAdvancedBtn.style.display = "none";
  }
  // Hide the shared status box only when NEITHER capability is on —
  // otherwise the other button needs it for progress reporting.
  if (els.autofillStatus && !basicVisible && !advancedVisible) {
    els.autofillStatus.classList.add("hidden");
    els.autofillStatus.textContent = "";
  }
}

// BCD's GET /api/profiles (role-scoped server-side — a bidder/caller only
// ever gets back their own assigned profiles, same as the web app's Profile
// page) returns a plain array, not `{ profiles: [...] }`, and every profile
// object already carries its full resume fields (firstName/lastName/email/
// phone/location/zipCode/linkedin/github/experience/education) in this one
// call — unlike
// ProActive's shape, there's no separate per-profile detail endpoint to
// follow up with (see loadProfileLinks below, which now reads out of this
// same cache instead of a second /me/profiles/:id request).
// GET /prompts/options — { id, title, isDefault }[]. Best-effort: a failure
// here just means the dropdown rows below show no prompt label, not that
// profiles fail to load at all.
async function loadPromptTitles(token) {
  try {
    const list = await apiFetch("/prompts/options", token ? { token } : {});
    PROMPT_TITLE_BY_ID = new Map();
    for (const p of Array.isArray(list) ? list : []) {
      if (p?.isDefault) DEFAULT_PROMPT_TITLE = p.title || "Default";
      else if (p?.id) PROMPT_TITLE_BY_ID.set(p.id, p.title || "");
    }
  } catch {
    /* best-effort — see this function's own comment */
  }
}

// Same as loadPromptTitles above, but Auto-fill prompts (?kind=autofill) —
// feeds the Settings > Prompt tab's read-only "Auto-fill Prompt" row (see
// renderApplySettingsReadOnly).
async function loadAutoFillPromptTitles(token) {
  try {
    const list = await apiFetch(
      "/prompts/options?kind=autofill",
      token ? { token } : {},
    );
    AUTOFILL_PROMPT_TITLE_BY_ID = new Map();
    for (const p of Array.isArray(list) ? list : []) {
      if (p?.isDefault) DEFAULT_AUTOFILL_PROMPT_TITLE = p.title || "Default";
      else if (p?.id) AUTOFILL_PROMPT_TITLE_BY_ID.set(p.id, p.title || "");
    }
  } catch {
    /* best-effort — see loadPromptTitles' own comment */
  }
}

async function loadProfilesFromServer(token) {
  STARRED_PROFILE_ID = await getStarredProfileId();
  await loadPromptTitles(token);
  await loadAutoFillPromptTitles(token);
  const data = await apiFetch("/profiles", token ? { token } : {});
  const list = Array.isArray(data) ? data : [];
  PROFILE_OPTIONS = list.map((p) => ({
    id: p._id,
    name: p.name,
    // BCD has no per-profile Auto-fill entitlement flag — every assigned
    // profile is usable. Leaving this true unconditionally rather than
    // reading a field BCD's Profile model doesn't have.
    autofillEnabled: true,
  }));
  PROFILES_BY_ID = new Map(list.map((p) => [p._id, p]));
  // Refreshed profile data may include different Apply-tab settings than
  // whatever the Settings > Prompt tab last rendered (an admin edit made on
  // the main app's own Profile page, say) — keep it in sync.
  renderApplySettingsReadOnly();
  return PROFILE_OPTIONS;
}

// Converts BCD's flat profile shape (firstName/lastName/email/phone/
// location/zipCode/linkedin/github/country/experience[]/education[]/
// autoFillPrefs{}) into the nested `{ data: { contact, preferences,
// education, experience } }` shape the autofill pipeline actually reads
// (see autofill/core/values.js's valuesFromProfile and
// autofill/pipeline/basic.js's own `ctx.input.profile?.data?.contact` /
// `?.preferences` destructuring) — this was the TODO(bcd) gap: without
// this conversion the contact-fill step found nothing under `.data` on a
// real BCD profile and the ~65 screening-question presets always fell
// through to their hardcoded generic defaults, never a candidate's own
// answer, even once one was set on the Profile page's Auto-fill tab
// (Profiles.jsx / autoFillPrefs — see server/src/models/Profile.js).
// preferences is autoFillPrefs verbatim: the extension's preset keys
// (autofill/handlers/presets/screening.js) and BCD's autoFillPrefs keys
// (server/src/controllers/profileController.js's AUTOFILL_PREF_KEYS) are
// the exact same strings by design, so no key-by-key mapping is needed —
// just pass the object through.
function autofillProfileFromBcd(p) {
  if (!p) return p;
  const fullName = [p.firstName, p.lastName].filter(Boolean).join(" ").trim() || p.name || "";
  return {
    ...p,
    data: {
      contact: {
        full_name: fullName,
        first_name: p.firstName || "",
        last_name: p.lastName || "",
        email: p.email || "",
        phone: p.phone || "",
        location: p.location || "",
        country: p.country || "",
        postal_code: p.zipCode || "",
        linkedin: p.linkedin || "",
        github: p.github || "",
      },
      preferences: p.autoFillPrefs || {},
      education: p.education || [],
      experience: p.experience || [],
    },
  };
}

// ---- Real-time TabSync refresh (socket.io) -----------------------------
// The LinkedIn Jobs list/badge used to only refresh when the sub-tab was
// reopened — a filter change on the web app's own LinkedIn Jobs page, or a
// teammate posting/applying to one, could sit stale here indefinitely.
// Same socket.io server (and the same JWT the REST calls already use) the
// main web app's own lib/socket.js connects to; the extension only ever
// listens, it never emits. Best-effort throughout — a browser that can't
// hold a WebSocket open (or the vendored client failing to load) just
// leaves TabSync on its existing reopen-to-refresh behavior, same as
// before this existed.
let REALTIME_SOCKET = null;

async function connectRealtime() {
  if (REALTIME_SOCKET || typeof io !== "function") return;
  const token = await getToken();
  if (!token) return;
  try {
    const socket = io(SOCKET_ORIGIN, {
      path: "/socket.io",
      auth: { token },
      transports: ["websocket", "polling"],
      reconnectionDelayMax: 8000,
    });
    socket.on("linkedin:unapplied-changed", () => {
      refreshTabsyncUnappliedBadge();
      if (TABSYNC_SUBTAB === "linkedin") refreshTabsyncLinkedinJobs();
    });
    REALTIME_SOCKET = socket;
  } catch {
    /* offline / blocked — degrades to the old reopen-to-refresh behavior */
  }
}

function disconnectRealtime() {
  if (!REALTIME_SOCKET) return;
  try { REALTIME_SOCKET.disconnect(); } catch { /* ignore */ }
  REALTIME_SOCKET = null;
}

/** True when the given (or, if omitted, the currently displayed tab's)
 *  profile has Auto-fill enabled. Defaults to true for safety (legacy
 *  data, in-flight cache, etc.) so a missing flag never blocks a real
 *  user. Takes an explicit id so a caller acting on a tab OTHER than the
 *  one on screen (runAutofill's post-Generate auto-chain) checks the
 *  right profile instead of whichever one the visible tab has picked. */
function activeProfileAutofillEnabled(profileId) {
  const id = profileId ?? selectedProfileId();
  if (!id) return true;
  const p = PROFILE_OPTIONS.find((x) => x.id === id);
  return p ? p.autofillEnabled !== false : true;
}

// Every custom-select function below takes the dropdown's own root element
// (.custom-select) as its first argument, so the exact same implementation
// drives BOTH Apply's own profile picker (els.profileSelect) and Profile
// tab's picker (els.profileTabSelect) — same markup, same behavior, two
// independent DOM instances (see chooseProfile vs chooseProfileTabView for
// where their behavior actually diverges: persistence + side effects).
// One profile can be bookmarked with a filled star at a time (a plain local
// preference, not tied to which profile is actually selected/generating —
// see STARRED_PROFILE_ID). Clicking a different profile's star just moves
// the star there; clicking the already-starred one is a no-op, there's no
// "no star at all" state once one has been picked.
function toggleStarredProfile(id) {
  if (!id || STARRED_PROFILE_ID === id) return;
  STARRED_PROFILE_ID = id;
  setStarredProfileId(id);
  refreshStarredMarks();
}

// Re-marks every rendered star (both the Apply and Profile tab pickers, if
// both happen to have been populated) against the current STARRED_PROFILE_ID
// — cheaper than re-running populateProfiles, which would also reset
// keyboard focus/scroll position for no reason.
function refreshStarredMarks() {
  document.querySelectorAll(".select-option__star").forEach((star) => {
    const opt = star.closest(".select-option");
    star.classList.toggle("starred", !!opt && opt.dataset.value === STARRED_PROFILE_ID);
  });
}

function buildStarButton(profileId) {
  const star = document.createElement("span");
  star.className = "select-option__star" + (profileId === STARRED_PROFILE_ID ? " starred" : "");
  star.setAttribute("role", "button");
  star.setAttribute("aria-label", "Star this profile");
  star.title = "Star this profile";
  star.innerHTML =
    '<svg viewBox="0 0 24 24" stroke-width="1.8" stroke-linejoin="round"><polygon points="12 2.5 15.3 9.6 23 10.6 17.3 15.9 18.9 23.5 12 19.6 5.1 23.5 6.7 15.9 1 10.6 8.7 9.6"/></svg>';
  // Stops the click from bubbling to the option's own button — starring
  // must never also select the profile.
  star.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleStarredProfile(profileId);
  });
  return star;
}

function populateProfiles(root, selectedId, onPick) {
  const trigger = root?.querySelector(".select-trigger");
  const valueEl = root?.querySelector(".select-value");
  const panel = root?.querySelector(".select-panel");
  if (!trigger || !valueEl || !panel) return;

  panel.innerHTML = "";

  if (PROFILE_OPTIONS.length === 0) {
    const empty = document.createElement("div");
    empty.className = "select-empty";
    empty.textContent = "No profiles available";
    panel.appendChild(empty);
  } else {
    for (const p of PROFILE_OPTIONS) {
      const opt = document.createElement("button");
      opt.type = "button";
      opt.className = "select-option";
      opt.setAttribute("role", "option");
      opt.dataset.value = p.id;
      const text = document.createElement("span");
      text.className = "select-option__text";
      const nameEl = document.createElement("span");
      nameEl.className = "select-option__name";
      nameEl.textContent = p.name;
      text.appendChild(nameEl);
      opt.appendChild(text);
      opt.appendChild(buildStarButton(p.id));
      if (p.id === selectedId) {
        opt.classList.add("selected");
        opt.setAttribute("aria-selected", "true");
      }
      opt.addEventListener("click", () => {
        onPick(p.id, p.name);
      });
      panel.appendChild(opt);
    }
  }

  const selected =
    PROFILE_OPTIONS.find((p) => p.id === selectedId) ||
    PROFILE_OPTIONS[0] ||
    null;
  root.dataset.value = selected ? selected.id : "";
  valueEl.textContent = selected ? selected.name : "";
  valueEl.classList.toggle("placeholder", !selected);
  return selected;
}

function isSelectOpen(root) {
  return !!root?.classList.contains("open");
}

function openSelect(root) {
  if (!root || isSelectOpen(root)) return;
  const trigger = root.querySelector(".select-trigger");
  const panel = root.querySelector(".select-panel");
  if (!trigger || !panel || trigger.disabled) return;
  root.classList.add("open");
  trigger.setAttribute("aria-expanded", "true");
  panel.classList.remove("hidden");
  // focus first selected (or first) option for keyboard nav
  const opts = panel.querySelectorAll(".select-option");
  let active = panel.querySelector(".select-option.selected") || opts[0];
  setActiveOption(root, active);
}

function closeSelect(root) {
  if (!root || !isSelectOpen(root)) return;
  const trigger = root.querySelector(".select-trigger");
  const panel = root.querySelector(".select-panel");
  root.classList.remove("open");
  trigger?.setAttribute("aria-expanded", "false");
  panel?.classList.add("hidden");
  clearActiveOption(root);
}

function toggleSelect(root) {
  if (isSelectOpen(root)) closeSelect(root);
  else openSelect(root);
}

function setActiveOption(root, opt) {
  if (!opt) return;
  const panel = root?.querySelector(".select-panel");
  panel
    ?.querySelectorAll(".select-option.active")
    .forEach((o) => o.classList.remove("active"));
  opt.classList.add("active");
  opt.scrollIntoView({ block: "nearest" });
}

function clearActiveOption(root) {
  const panel = root?.querySelector(".select-panel");
  panel
    ?.querySelectorAll(".select-option.active")
    .forEach((o) => o.classList.remove("active"));
}

function moveActive(root, direction) {
  const panel = root?.querySelector(".select-panel");
  if (!panel) return;
  const opts = Array.from(panel.querySelectorAll(".select-option"));
  if (!opts.length) return;
  const cur = panel.querySelector(".select-option.active");
  let idx = cur ? opts.indexOf(cur) : -1;
  idx += direction;
  if (idx < 0) idx = opts.length - 1;
  if (idx >= opts.length) idx = 0;
  setActiveOption(root, opts[idx]);
}

// Marks `id` selected in `root`'s trigger/panel — the plain visual update
// shared by both chooseProfile (Apply) and chooseProfileTabView (Profile
// tab); everything else (persistence, side effects) is each one's own.
function markSelectChosen(root, id, name) {
  root.dataset.value = id;
  const valueEl = root.querySelector(".select-value");
  if (valueEl) {
    valueEl.textContent = name;
    valueEl.classList.remove("placeholder");
  }
  const panel = root.querySelector(".select-panel");
  panel?.querySelectorAll(".select-option").forEach((o) => {
    const isSel = o.dataset.value === id;
    o.classList.toggle("selected", isSel);
    if (isSel) o.setAttribute("aria-selected", "true");
    else o.removeAttribute("aria-selected");
  });
  closeSelect(root);
}

async function chooseProfile(id, name) {
  markSelectChosen(els.profileSelect, id, name);
  // TAB_ID-scoped only — a profile picked here must stay stuck to this one
  // Chrome tab (see savePatch/fetchState's per-tab storage) and never affect
  // any other tab's own selection, chosen or defaulted. A brand-new tab's
  // own starting default comes from the starred profile instead (see
  // defaultSelectedProfileId/toggleStarredProfile), not from whatever was
  // just picked here.
  await savePatch(TAB_ID, { selectedProfileId: id });
  // Pull the chosen profile's data so the LinkedIn / GitHub copy buttons
  // light up straight from the database — no need to wait for a generation.
  fetchProfileLinks(id);
  // Settings > Prompt tab mirrors THIS profile's own Apply-tab settings —
  // switching profiles here means it should show its values next.
  renderApplySettingsReadOnly();
  // Free/Pro keys are per-profile — refresh the masked preview for the new pick.
  if (RESUME_MODE === "auto" || RESUME_MODE === "free") refreshApiKeyPreview();
}

// Profile tab's own picker — local/display only. Unlike chooseProfile
// above, this never persists (no savePatch) and never touches Apply's own
// selection: picking a profile here only changes which
// profile's Resume (Experience/Education) this tab shows below. Every time
// the user switches back to this tab, populateProfileTabSelect re-derives
// the starting selection from Apply's CURRENT choice (see switchToTab),
// so Apply → here is a one-way mirror, not the other way around.
function chooseProfileTabView(id, name) {
  markSelectChosen(els.profileTabSelect, id, name);
  renderProfileTabDetail(id);
}

// (Re)populates Profile tab's own dropdown and renders whichever profile
// ends up selected — called on every switch to this tab (see switchToTab)
// so it always starts mirroring Apply's current pick.
function populateProfileTabSelect(selectedId) {
  els.profileListEmpty?.classList.toggle("hidden", PROFILE_OPTIONS.length > 0);
  const selected = populateProfiles(els.profileTabSelect, selectedId, chooseProfileTabView);
  renderProfileTabDetail(selected ? selected.id : null);
}

function renderProfileTabDetail(id) {
  if (!els.profileTabDetail) return;
  const p = id ? PROFILES_BY_ID.get(id) : null;
  els.profileTabDetail.innerHTML = p ? profileDetailHtml(p) : "";
}

async function ensureDefaultProfileSelection() {
  if (!PROFILE_OPTIONS.length) return;
  const currentId = selectedProfileId();
  const exists = PROFILE_OPTIONS.some((p) => p.id === currentId);
  if (exists) {
    // populateProfiles defaults the dropdown to the first profile, so a
    // profile is "selected" here even on a fresh load. Pull its LinkedIn /
    // GitHub links so the copy buttons activate without a manual re-select,
    // and persist the selection so it survives reloads.
    fetchProfileLinks(currentId);
    if (currentId && currentId !== STATE?.selectedProfileId) {
      await savePatch(TAB_ID, { selectedProfileId: currentId });
    }
    return;
  }
  const first = PROFILE_OPTIONS[0];
  await chooseProfile(first.id, first.name);
}

function setProfileSelectDisabled(disabled) {
  const trigger = els.profileSelect.querySelector(".select-trigger");
  if (trigger) trigger.disabled = !!disabled;
  if (disabled) closeSelect(els.profileSelect);
}

function renderQA(tabId) {
  if (TAB_ID !== tabId) return;

  els.qaThread.innerHTML = "";

  const items = Array.isArray(STATE?.qa) ? STATE.qa : [];
  for (const item of items) {
    const qEle = document.createElement("li");
    qEle.className = "msg user";
    qEle.innerHTML = `
      <div class="role">Question</div>
      <div class="content">${escapeHtml(item.question)}</div>
    `;
    els.qaThread.appendChild(qEle);

    const aEle = document.createElement("li");
    aEle.className = "msg bot";
    aEle.title = "Click to copy";
    const formattedAnswer = escapeHtml(item.answer)
      .replace(/\*\*([\s\S]*?)\*\*/g, "<strong>$1</strong>")
      .replace(/__([\s\S]*?)__/g, "<em>$1</em>");

    aEle.innerHTML = `
      <div class="role">Answer</div>
      <div class="content">${formattedAnswer}</div>
    `;
    // The whole answer box IS the copy button now — no separate icon
    // button in the corner. A quick .copied pulse (CSS) plus the panel
    // toast confirm the copy without disturbing the visible answer text.
    aEle.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(item.answer);
        aEle.classList.add("copied");
        setTimeout(() => aEle.classList.remove("copied"), 600);
        panelToast("Answer copied.");
      } catch (err) {
        console.error("Failed to copy: ", err);
      }
    });

    els.qaThread.appendChild(aEle);
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Strips simple markdown markers (`**bold**`, `__italic__`) so the clipboard
// receives clean prose. The PDF builder still consumes the original text with
// markers so the rendered PDF keeps its bold/italic styling.
function stripCoverMarkdown(s) {
  return String(s ?? "")
    .replace(/\*\*([\s\S]*?)\*\*/g, "$1")
    .replace(/__([\s\S]*?)__/g, "$1");
}

function normalizeUrl(val) {
  const s = String(val ?? "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(s)) return `https://${s}`;
  return "";
}

function findUrlByHints(node, keyHint, domainHint) {
  if (!node || typeof node !== "object") return "";
  const stack = [node];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);
    for (const [k, v] of Object.entries(cur)) {
      const key = String(k || "").toLowerCase();
      if (typeof v === "string") {
        const candidate = normalizeUrl(v);
        if (!candidate) continue;
        const c = candidate.toLowerCase();
        if (
          (key.includes(keyHint) || c.includes(domainHint)) &&
          c.includes(domainHint)
        ) {
          return candidate;
        }
      } else if (v && typeof v === "object") {
        stack.push(v);
      }
    }
  }
  return "";
}

// Pull a postal code out of a free-form address/location string. Covers US
// ZIP ("94115" / "94115-1234"), UK ("SW1A 1AA"), Canada ("K1A 0B1"), and a
// generic trailing 4-6 digit code. Ported down from the content scripts'
// own autofill/core/values.js#extractPostalCode (that file only runs inside
// a job page's DOM, not this side-panel context, so it can't be imported
// directly — same regexes, kept in sync by hand). Deliberately conservative:
// a bare 4-digit run that looks like a trailing year is skipped.
function extractPostalCode(text) {
  const s = String(text || "").trim();
  if (!s) return "";
  // US ZIP / ZIP+4.
  let m = /\b(\d{5}(?:-\d{4})?)\b/.exec(s);
  if (m) return m[1];
  // Polish / NL-style NN-NNN.
  m = /\b(\d{2}-\d{3})\b/.exec(s);
  if (m) return m[1];
  // UK postcode.
  m = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i.exec(s);
  if (m) return m[1].toUpperCase().replace(/\s+/, " ");
  // Canada postal code.
  m = /\b([A-Z]\d[A-Z]\s*\d[A-Z]\d)\b/i.exec(s);
  if (m) return m[1].toUpperCase().replace(/\s+/, " ");
  // Generic 4-6 digit code as the trailing token (many EU/APAC formats).
  m = /(?:^|[,\s])(\d{4,6})\s*$/.exec(s);
  if (m) return m[1];
  return "";
}

function readProfileLinks(info) {
  if (!info || typeof info !== "object")
    return { linkedin: "", github: "", address: "", phone: "", email: "", lastCompany: "" };
  const directLinkedin =
    normalizeUrl(info.linkedin_url) ||
    normalizeUrl(info.linkedinUrl) ||
    normalizeUrl(info.linkedin) ||
    normalizeUrl(info?.links?.linkedin) ||
    normalizeUrl(info?.social?.linkedin);
  const directGithub =
    normalizeUrl(info.github_url) ||
    normalizeUrl(info.githubUrl) ||
    normalizeUrl(info.github) ||
    normalizeUrl(info?.links?.github) ||
    normalizeUrl(info?.social?.github);
  const c = info.contact || {};
  const address = String(
    info.address || info.location || c.address || c.location || ""
  ).trim();
  const phone = String(
    info.phone ||
      info.phone_number ||
      info.phoneNumber ||
      c.phone ||
      c.phone_number ||
      c.phoneNumber ||
      ""
  ).trim();
  const email = String(
    info.email || c.email || info?.resume?.contact?.email || ""
  ).trim();
  // Most recent/current job on whichever experience list this info object
  // carries — the top-level generation result, or its nested
  // .resume.experience (see formatResumeText's own shape). Resume experience
  // lists are ordered newest-first, so that's index 0, not the last entry.
  const expList = info.experience || info?.resume?.experience || [];
  const lastCompany = String((expList.length ? expList[0]?.company : "") || "").trim();
  const links = {
    linkedin:
      directLinkedin || findUrlByHints(info, "linkedin", "linkedin.com"),
    github: directGithub || findUrlByHints(info, "github", "github.com"),
    address,
    phone,
    email,
    lastCompany,
  };
  return links;
}

function showCopiedCheck(btn) {
  if (!btn) return;
  const original = btn.innerHTML;
  btn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
    `;
  btn.classList.add("copied");
  setTimeout(() => {
    btn.classList.remove("copied");
    btn.innerHTML = original;
  }, 2000);
}

function setCopyUrlButtonState(btn, enabled) {
  if (!btn) return;
  btn.disabled = !enabled;
}

// Cached LinkedIn / GitHub URLs pulled from the currently-selected profile's
// data on the server. Fetched in fetchProfileLinks(); used by the copy
// buttons so the URLs come straight from the database — no manual paste.
let PROFILE_DATA_LINKS = { linkedin: "", github: "", address: "", phone: "", email: "", lastCompany: "" };
const PROFILE_LINKS_CACHE = new Map(); // profileId -> { linkedin, github, address, phone, email, lastCompany }

// Raw location string from the selected profile's contact (e.g.
// "Warsaw, Poland"). The Detect remote/eligibility check derives the
// profile's country from this to decide whether a country-restricted
// posting is a blocker. "" when unknown.
let PROFILE_LOCATION = "";
const PROFILE_LOCATION_CACHE = new Map(); // profileId -> location string

// Latest detect-time result so Generate can re-run assessJobFit
// against the SAME context the page badge used. Without this the
// inline call at Generate-time only sees title+description, which
// produces false-positive "Skip" verdicts on roles where the
// "remote" signal lives in the page's location header (e.g. greenhouse
// postings showing "Remote, USA" outside the JD body). Cleared when
// the user switches tabs / profiles.
let LAST_DETECT_RESULT = null;

// Auto-detect: passively fills company/role/JD from the page (via the
// content-script push in content-detect.js) without clicking Detect. Always
// on now — there used to be a settings-menu toggle for it (and a matching
// one in content-detect.js), both removed; this always runs.

async function fetchProfileLinks(profileId) {
  if (!profileId) {
    PROFILE_DATA_LINKS = { linkedin: "", github: "", address: "", phone: "", email: "", lastCompany: "" };
    PROFILE_LOCATION = "";
    refreshProfileLinksUI();
    return;
  }
  const cached = PROFILE_LINKS_CACHE.get(profileId);
  if (cached) {
    PROFILE_DATA_LINKS = cached;
    PROFILE_LOCATION = PROFILE_LOCATION_CACHE.get(profileId) || "";
    refreshProfileLinksUI();
    return;
  }
  // No separate per-profile fetch needed: BCD's /profiles list call (see
  // loadProfilesFromServer) already returns every field flat on each
  // profile object, cached in PROFILES_BY_ID — unlike ProActive's nested
  // `{ profile: { data: { contact: {...} } } }` shape from a dedicated
  // /me/profiles/:id endpoint BCD doesn't have.
  const p = PROFILES_BY_ID.get(profileId);
  if (p) {
    const loc = String(p.location || "").trim();
    const exp = p.experience || [];
    const links = {
      linkedin: normalizeUrl(p.linkedin || "") || "",
      github: normalizeUrl(p.github || "") || "",
      address: loc,
      phone: String(p.phone || "").trim(),
      email: String(p.email || "").trim(),
      // Most recent/current company — the first entry, not the last:
      // profile experience lists read newest-first (confirmed against real
      // data — an earlier assumption that AddProfileModal.jsx's "append to
      // the end" editing order meant oldest-first was wrong).
      lastCompany: String((exp.length ? exp[0]?.company : "") || "").trim(),
    };
    PROFILE_LINKS_CACHE.set(profileId, links);
    PROFILE_DATA_LINKS = links;
    PROFILE_LOCATION_CACHE.set(profileId, loc);
    PROFILE_LOCATION = loc;
    // Mirror the location to storage so the passive page badge (a content
    // script, which can't reach this in-memory state) can use the same
    // country context for its country-restriction check.
    try {
      chrome.storage?.local?.set({ ab_profile_country: loc });
    } catch {
      /* storage unavailable — badge falls back to no country context */
    }
  } else {
    PROFILE_DATA_LINKS = { linkedin: "", github: "", address: "", phone: "", email: "", lastCompany: "" };
    PROFILE_LOCATION = "";
  }
  refreshProfileLinksUI();
}

function refreshProfileLinksUI() {
  // Prefer URLs from the selected profile's DB record; fall back to anything
  // surfaced by the most recent generation result.
  const fromInfo = readProfileLinks(STATE?.info || null);
  PROFILE_LINKS = {
    linkedin: PROFILE_DATA_LINKS.linkedin || fromInfo.linkedin,
    github: PROFILE_DATA_LINKS.github || fromInfo.github,
    address: PROFILE_DATA_LINKS.address || fromInfo.address,
    phone: PROFILE_DATA_LINKS.phone || fromInfo.phone,
    email: PROFILE_DATA_LINKS.email || fromInfo.email,
    lastCompany: PROFILE_DATA_LINKS.lastCompany || fromInfo.lastCompany,
  };
  // No dedicated zipcode field on a profile — pulled out of whichever
  // address string just won above (see extractPostalCode).
  PROFILE_LINKS.zipcode = extractPostalCode(PROFILE_LINKS.address);
  setCopyUrlButtonState(els.shortcutEmailBtn, !!PROFILE_LINKS.email);
  setCopyUrlButtonState(els.shortcutPhoneBtn, !!PROFILE_LINKS.phone);
  setCopyUrlButtonState(els.shortcutLinkedinBtn, !!PROFILE_LINKS.linkedin);
  setCopyUrlButtonState(els.shortcutGithubBtn, !!PROFILE_LINKS.github);
  setCopyUrlButtonState(els.shortcutAddressBtn, !!PROFILE_LINKS.address);
  setCopyUrlButtonState(els.shortcutZipBtn, !!PROFILE_LINKS.zipcode);
  setCopyUrlButtonState(els.shortcutCompanyBtn, !!PROFILE_LINKS.lastCompany);
}

async function fetchState(tabId) {
  const resp = await sendToBG({ type: "INIT", tabId });
  if (!resp || !resp.ok)
    throw new Error("Init failed: " + (resp && resp.error));
  return resp.state || {};
}

// Last status announced, so a message repeated in quick succession (several
// code paths can land on the same text) doesn't stack duplicate toasts.
let LAST_STATUS_TOAST = { tabId: null, msg: "", at: 0 };

/**
 * Report a status. The panel no longer renders a status box — statuses surface
 * as in-panel toasts (panelToast below), never injected onto the actual
 * webpage. Pass `{ toast: false }` for re-renders that only reflect state
 * already on screen (tab switch, panel reopen); those must not re-announce
 * themselves.
 */
function setStatus(tabId, msg, type = "idle", { toast = true } = {}) {
  if (TAB_ID !== tabId) return;
  // Keep the (never-shown) node's text in sync — some paths read/clear it.
  els.genStatus.textContent = msg || "";
  els.genStatus.className = "status-box hidden";
  if (!toast) return;
  const text = String(msg || "").trim();
  // "idle" is the resting placeholder ("Ready when you are.") — not an event.
  if (!text || type === "idle") return;
  const now = Date.now();
  if (
    LAST_STATUS_TOAST.tabId === tabId &&
    LAST_STATUS_TOAST.msg === text &&
    now - LAST_STATUS_TOAST.at < 2000
  ) {
    return;
  }
  LAST_STATUS_TOAST = { tabId, msg: text, at: now };
  panelToast(text, type === "error" ? "error" : type === "loading" ? "loading" : "success");
}

/** Set the status line to the tab's resting message, derived from persisted
 *  state. Used to clear a transient "Asking…" pill back to the appropriate
 *  idle / success message once the action completes. */
function applyRestingStatus(tabId) {
  // Silent: this only re-derives the resting status from persisted state (tab
  // switch, panel reopen, after a transient action). Toasting here would
  // re-announce "Generated successfully." every time you switch tabs.
  const q = { toast: false };
  if (STATE?.generatingStatus === "generating") {
    setStatus(tabId, "Generating resume and cover letter…", "loading", q);
  } else if (STATE?.generatingStatus === "generated") {
    if ((STATE?.jobText || "").trim()) setStatus(tabId, "Generated successfully.", "success", q);
    else setStatus(tabId, "Ready when you are.", "idle", q);
  } else if (STATE?.generatingStatus === "error") {
    setStatus(tabId, STATE?.genError || "Generate failed — click Retry.", "error", q);
  } else {
    setStatus(tabId, "Ready when you are.", "idle", q);
  }
}

// One icon per kind — success/warning existed already; error/loading added
// so every setStatus/pageToast caller (see panelToast below) has a home in
// here now that nothing shows up on the actual webpage any more.
const PANEL_TOAST_ICONS = {
  success:
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
  warning:
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>',
  error:
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  loading:
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" opacity="0.3"/><path d="M21 12a9 9 0 0 0-9-9"/></svg>',
  // Same three images as the header's own mode toggle (#resumeModeToggle),
  // already the right color (pink/green/blue) — no grayscale filter here
  // unlike the toggle's own idle state, this only ever shows for the mode
  // that was just switched TO.
  "mode-auto": '<img class="panel-toast__mode-icon" src="icons/pro.webp" alt="" />',
  "mode-free": '<img class="panel-toast__mode-icon" src="icons/free.webp" alt="" />',
  "mode-manual": '<img class="panel-toast__mode-icon" src="icons/manual.webp" alt="" />',
};

/** Surface a confirmation INSIDE the extension panel itself — same dark-pill
 *  + coloured-icon look as the main BCD web app's own toast (Toaster.jsx /
 *  lib/toast.js), extended with "error"/"loading" kinds for everything
 *  setStatus used to route to an in-page toast on the actual webpage (see
 *  setStatus below) — every notification now surfaces here instead, never
 *  on the page itself. Auto-dismisses after 3s UNLESS `sticky` is set (see
 *  runAutoApply's own per-tab skip/result reporting) — a sticky one instead
 *  gets its own X close button and stays put, surviving a tab switch (this
 *  container isn't part of any per-tab state a loadForTab repaint would
 *  touch), until the user dismisses it by hand. That's the whole point for
 *  Auto Apply: a run can blow through dozens of tabs faster than a 3s toast
 *  could ever be read, so its own results need to sit there reviewable
 *  after the fact instead of disappearing on their own.
 *
 *  Always at the same spot — horizontally centered, pinned just above the
 *  bottom edge (see .panel-toast in panel.css) — regardless of which tab is
 *  active or what else is on screen. This used to shift per tab (raised
 *  above the Q&A composer, width-matched to the Apply tab's input shell)
 *  which read as the position "randomly" changing between tabs; a plain
 *  fixed position is simpler and reads as one consistent notification
 *  system instead. */
function panelToast(message, kind = "success", { sticky = false, detail = "" } = {}) {
  if (!message || !els.panelToast) return null;
  // Clear any still-showing auto-dismiss toast(s) before adding this one —
  // without this, clicking something that toasts repeatedly in quick
  // succession (e.g. switching resume mode a few times in a row) piled up
  // a stack of overlapping cards, each on its own independent 3s timer
  // (confirmed real complaint). Sticky toasts (dismiss-only, e.g. Auto
  // Apply's own per-tab notices) are left alone — they're a deliberate,
  // longer-lived surface, not transient feedback.
  if (!sticky) {
    els.panelToast.querySelectorAll(".panel-toast__item:not(.panel-toast__item--sticky)").forEach((el) => el.remove());
  }
  const k = PANEL_TOAST_ICONS[kind] ? kind : "success";
  const item = document.createElement("div");
  item.className = "panel-toast__item" + (sticky ? " panel-toast__item--sticky" : "");
  const check = document.createElement("span");
  check.className = "panel-toast__check panel-toast__check--" + k;
  check.innerHTML = PANEL_TOAST_ICONS[k];
  const text = document.createElement("span");
  text.className = "panel-toast__text";
  // `detail` (Auto Apply's own notices — see autoApplyNotice) splits this
  // into a title line + a smaller/muted detail line below it, both plain
  // textContent (never innerHTML — a job page's own company/role text ends
  // up in here, so this has to stay injection-safe). Every other caller
  // passes no detail and keeps today's single-line look exactly as-is.
  const titleEl = document.createElement("span");
  titleEl.className = "panel-toast__title";
  titleEl.textContent = message;
  text.appendChild(titleEl);
  if (detail) {
    const detailEl = document.createElement("span");
    detailEl.className = "panel-toast__detail";
    detailEl.textContent = detail;
    text.appendChild(detailEl);
  }
  item.appendChild(check);
  item.appendChild(text);
  if (sticky) {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "panel-toast__close";
    close.setAttribute("aria-label", "Dismiss");
    close.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    // No listener of its own — a click on it bubbles up to the item's own
    // listener below, same as a click anywhere else on the card. Keeping
    // dismiss logic in ONE place (the item) means an external cleanup
    // callback (autoApplyNotice's per-tab bookkeeping) only has to attach
    // once, there, and fires regardless of where on the card was clicked.
    item.appendChild(close);
    item.addEventListener("click", () => item.remove());
  } else {
    setTimeout(() => item.remove(), 3000);
  }
  els.panelToast.appendChild(item);
  return item;
}

// A real OS-level desktop notification — separate from panelToast's own
// in-panel toast above, which only ever gets seen while the side panel
// itself is open and on screen. "Generate finished" is exactly the kind of
// thing that's still useful to know about after tabbing away to something
// else entirely (another app, or — in Manual mode — while ChatGPT's own
// corner window is quietly working, see openFreshBananaChatGptTab), which a
// panel-scoped toast can't reach. Fires the same way for both Auto and
// Manual mode — they converge on the same success handler (see its own
// call site). Best-effort: a notification failing (permission revoked,
// platform quirk) must never make a successful generation look like it
// failed.
function notifyResumeGenerated({ company, role, profileName }) {
  if (!chrome.notifications?.create) return;
  const message = [
    company ? `Company: ${company}` : null,
    role ? `Role: ${role}` : null,
    profileName ? `Profile: ${profileName}` : null,
  ].filter(Boolean).join("\n");
  try {
    chrome.notifications.create("", {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/logo.png"),
      title: "Resume Generated",
      message: message || "Your resume is ready.",
    });
  } catch { /* best-effort */ }
}

// Auto Apply's own sticky notices — scoped PER CHROME TAB, hidden/restored
// exactly like the fit-warning/dup-warning modals elsewhere in this file
// (FIT_WARNING_OPEN, DUP_WARNING_PENDING — see loadForTab): switching tabs
// HIDES whichever notice was showing (never forgets it) and RESTORES the
// newly-active tab's own, if it has one. TWO independent slots can be
// showing for the SAME tab at once:
//   result  — that tab's own skip reason / Generate outcome.
//   summary — the end-of-run tally, shown ONLY on the LAST tab the run
//             touched (see runAutoApply's finally block) — a single shared
//             summary toast used to show on every tab regardless of which
//             one you were looking at, which is exactly what was reported.
// A single shared slot for `result` (an even earlier version of this) had
// the same problem: it looked right while the run was actively cycling
// through tabs (each tab happened to be the one on screen right when its
// own message was written) but froze on whichever tab was processed LAST
// the moment the run stopped, so every tab checked afterward showed that
// same final message instead of its own.
const AUTO_APPLY_SLOTS = {
  result: { byTab: new Map(), item: null },
  summary: { byTab: new Map(), item: null },
};

// `title` is the short outcome ("Skipped", "Generated & Auto-filled", …);
// `detail` is the specific one-line reason/label underneath it ("No JD
// detected", "Already applied 2 hours ago", the company/role) — no tab
// name in either any more, since this notice only ever shows for whichever
// tab you're currently looking at (see loadForTab's own restore of it).
function autoApplyNotice(slotName, tabId, title, detail, kind) {
  const slot = AUTO_APPLY_SLOTS[slotName];
  slot.byTab.set(tabId, { title, detail, kind });
  if (tabId === TAB_ID) renderAutoApplyNotice(slotName, tabId);
}

function renderAutoApplyNotice(slotName, tabId) {
  const slot = AUTO_APPLY_SLOTS[slotName];
  const rec = slot.byTab.get(tabId);
  if (!rec) return;
  if (slot.item && slot.item.isConnected) {
    const k = PANEL_TOAST_ICONS[rec.kind] ? rec.kind : "success";
    const check = slot.item.querySelector(".panel-toast__check");
    if (check) {
      check.className = "panel-toast__check panel-toast__check--" + k;
      check.innerHTML = PANEL_TOAST_ICONS[k];
    }
    const titleEl = slot.item.querySelector(".panel-toast__title");
    if (titleEl) titleEl.textContent = rec.title;
    let detailEl = slot.item.querySelector(".panel-toast__detail");
    if (rec.detail) {
      if (!detailEl) {
        detailEl = document.createElement("span");
        detailEl.className = "panel-toast__detail";
        titleEl?.parentElement?.appendChild(detailEl);
      }
      detailEl.textContent = rec.detail;
    } else {
      detailEl?.remove();
    }
    // A quick flash so an update (e.g. this tab's skip reason replaced
    // moments later by its real Generate outcome) reads as fresh, not a
    // silent in-place text swap.
    slot.item.classList.remove("panel-toast__item--flash");
    void slot.item.offsetWidth; // restart the animation
    slot.item.classList.add("panel-toast__item--flash");
    return;
  }
  const item = panelToast(rec.title, rec.kind, { sticky: true, detail: rec.detail });
  if (!item) return;
  slot.item = item;
  // panelToast's own item-wide click listener already removes it from the
  // DOM (clicking anywhere on the card dismisses it, not just the X) —
  // this just adds the per-tab bookkeeping on top, on the same click.
  item.addEventListener("click", () => {
    if (slot.item === item) slot.item = null;
    // Explicit dismiss forgets it for THIS tab specifically — switching
    // tabs away and back must not bring a closed notice back.
    slot.byTab.delete(tabId);
  });
}

// Tab-switch-away only: hide both slots without forgetting either —
// loadForTab repaints whichever ones this tab has via renderAutoApplyNotice
// if the user comes back to it.
function hideAutoApplyNotices() {
  for (const slot of Object.values(AUTO_APPLY_SLOTS)) {
    if (slot.item) {
      slot.item.remove();
      slot.item = null;
    }
  }
}

// Auto-fill's real checkpoints, mapped to a rough percentage — unlike
// Generate's GEN_STAGES (a fixed timeline faking progress through ONE long
// blocking call), these are genuine step transitions the run passes through,
// so the bar is driven straight off them instead of a timer.
const AUTOFILL_STAGE_PCT = {
  "Loading profile…": 15,
  "Generating a tailored CV…": 40,
  "Filling the form…": 75,
};

/** Updates the Auto-fill button's own progress fill (.autofill-btn__fill)
 *  for one in-flight checkpoint — a clip-path reveal of the button's own
 *  gradient instead of a separate bar below it. Unmapped messages (a
 *  JD-detect error mid-run, etc.) still nudge the fill forward a bit
 *  rather than leaving it frozen. The actual message text still shows via
 *  #autofillStatus (setAutofillStatus), unrelated to this fill. */
function setAutofillProgress(msg) {
  if (!els.autofillProgressFill) return;
  const pct = AUTOFILL_STAGE_PCT[msg] ?? 50;
  els.autofillProgressFill.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
}

/** Ends the fill for the run that just finished. On success it snaps to
 *  100% and STAYS there — the button keeps its light-gradient "done" fill
 *  rather than reverting to plain white, same as Generate's. Only reset
 *  back to empty on a non-success end (aborted/failed — nothing was
 *  actually completed, so no "done" fill should persist); the NEXT run
 *  starts from empty again via setAutofillProgress. */
function stopAutofillProgress(opts) {
  if (!els.autofillProgressFill) return;
  els.autofillProgressFill.style.clipPath = opts?.success ? "inset(0 0 0 0)" : "inset(0 100% 0 0)";
}

/** Status line under the Auto-fill button. Hidden when empty so the
 *  button block stays compact until the user actually triggers it. */
function setAutofillStatus(msg, type = "idle") {
  if (!els.autofillStatus) return;
  if (!msg) {
    els.autofillStatus.classList.add("hidden");
    els.autofillStatus.textContent = "";
    delete els.autofillStatus.dataset.level;
  } else if (type === "loading") {
    // In-progress chatter ("Loading profile…", "Filling…") now drives the
    // progress bar + ticker below the Auto-fill button (same pattern as
    // Generate) instead of a page toast — keep the box itself hidden, its
    // text still gets read back by some callers.
    els.autofillStatus.textContent = msg;
    els.autofillStatus.className = "status-box autofill-status loading hidden";
    els.autofillStatus.dataset.level = type;
    setAutofillProgress(msg);
  } else {
    els.autofillStatus.classList.remove("hidden");
    els.autofillStatus.textContent = msg;
    els.autofillStatus.className = "status-box autofill-status " + type;
    els.autofillStatus.dataset.level = type;
  }
  // Persist the autofill status into per-tab state so it survives a
  // tab switch and — critically — DOESN'T leak into other tabs. The
  // status DOM element is a singleton in the side panel; without
  // saving it per-tab, "Filled 7 fields…" from tab A would still be
  // showing when the user switches to tab B. applyStateToUI(tabB)
  // restores tab B's own autofillStatus (or hides if none).
  if (TAB_ID) {
    savePatch(TAB_ID, {
      autofillStatus: msg ? { msg, type } : null,
    }).catch(() => {/* persistence is best-effort */});
  }
}

function getAutofillStatusText() {
  return els.autofillStatus?.textContent || "";
}

// Content script's SPA watcher pings AUTOFILL_PAGE_CHANGED on every
// pushState/replaceState/popstate. When a multi-step form advances via
// pushState, the side panel's old status ("Filled 6 of 7 on
// Greenhouse · resume attached") is stale — the user wants to know
// they can click Auto-fill again on the new step. Reset the status so
// it's obvious.
try {
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.type !== "AUTOFILL_PAGE_CHANGED") return;
    if (sender?.tab?.id !== TAB_ID) return;
    // Don't clobber an in-flight loading state — only reset if the
    // status is at rest.
    const cls = els.autofillStatus?.className || "";
    if (/\bloading\b/.test(cls)) return;
    setAutofillStatus("Page changed — click Auto-fill again to detect the new step.", "idle");
    // Re-enable via the per-tab state, never unconditionally: this tab may
    // still have a run in flight, and forcing the button on would let a
    // second run start on top of it.
    syncAutofillButtons();
  });

  // Auto-detect: content-detect.js pushes a `jd-detected` message whenever it
  // extracts a job posting. Fill the panel for the tab we're viewing —
  // smart-refresh (see handleAutoDetect).
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.__proactive !== true || msg.type !== "jd-detected") return;
    handleAutoDetect(msg, sender);
  });

  // Keyboard shortcuts (background.js's chrome.commands.onCommand relay) —
  // fires only when the panel was already open; a panel opened BY the
  // hotkey picks its pending action up from storage instead (see init()'s
  // checkPendingHotkey()). Dispatches a real click rather than calling
  // runAutofill/the generate handler directly — both are declared inside the
  // DOMContentLoaded closure further down the file, out of reach from here,
  // and a real click also respects the button's own disabled state for free.
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "HOTKEY_AUTOFILL") els.autofillBtn?.click();
    else if (msg.type === "HOTKEY_GENERATE") els.generateBtn?.click();
  });

  // Chrome rebinding a shortcut on chrome://extensions/shortcuts doesn't
  // touch this panel at all — without this, the Account tab's rows keep
  // showing whatever they last read until the panel happens to reload.
  chrome.commands.onChanged?.addListener(() => renderShortcuts());
} catch {
  /* ignore — extension context might not be ready yet */
}

// .autofill-btn__title covers #autofillBtn specifically — its icon+title/
// subtitle "card" layout (see panel.css's .autofill-row--card) has no
// .btn-text element at all, so without this the plain textContent fallback
// below would wipe out the icon and subtitle the moment anything called
// setButtonText(els.autofillBtn, ...) — confirmed a real, live call site
// (applyHotkeyButtonLabels), not just a hypothetical.
function setButtonText(btn, text) {
  const span = btn.querySelector(".btn-text") || btn.querySelector(".autofill-btn__title");
  if (span) span.textContent = text;
  else btn.textContent = text;
}

// Job extraction + fit assessment live in job-fit.js (window.ProactiveJobFit),
// shared with the passive page badge so there is ONE implementation.

// Work-model badge colors — not a BidHub port (confirmed via research: its
// own panel renders every locationType chip in one neutral color,
// Remote/Hybrid/Onsite alike) — this is Big Banana's own addition.
const WORK_MODEL_LABELS = { remote: "Remote", hybrid: "Hybrid", onsite: "Onsite" };
const WORK_MODEL_COLORS = { remote: "#16a34a", hybrid: "#d97706", onsite: "#dc2626" };

// Renders the job-posting metadata a detection pass found (see
// job-detect/extractors/structured/jobmeta.js's `meta` shape). Each field
// is its own .field.field-row — same icon + 78px label column + value
// shape as Company/Role above, so the whole list reads as one consistent
// block instead of Company/Role looking "real" and everything else looking
// like a smaller, bolted-on footnote. Every row always shows, same as
// Company/Role's own inputs always show (empty or not) — absent/
// unresolved data just means that row's value reads "—" instead of the
// whole row disappearing, so the Job Details list has a stable, predictable
// shape from the moment the Job tab opens rather than growing/shrinking
// as fields resolve. Location shows its badge whenever a work model is
// known; when jobmeta.js found no explicit remote/hybrid/onsite signal
// anywhere, m.workModel is "unknown" (workModelInferred: true) — all three
// badges shown neutrally (Remote/Onsite/Hybrid, "could be any of these"),
// NOT a single confident guess. Matches BidHub's own observed behavior for
// a posting that genuinely never states a work model (confirmed real
// complaint/comparison: job-boards.greenhouse.io/newrelic/jobs/5444701008
// — BidHub shows all three plain badges, Banana used to guess "Onsite"
// alone).
function renderJobMeta(meta) {
  const m = meta || {};
  const EMPTY = "—";

  if (els.jobMetaLocationRow && els.jobMetaLocationValue) {
    els.jobMetaLocationRow.classList.remove("hidden");
    const modelLabel = WORK_MODEL_LABELS[m.workModel];
    if (m.location) {
      let badge = "";
      if (m.workModel === "unknown") {
        badge = Object.values(WORK_MODEL_LABELS)
          .map((label) => `<span class="work-model-badge work-model-badge--neutral">${label}</span>`)
          .join("");
      } else if (modelLabel) {
        const color = WORK_MODEL_COLORS[m.workModel];
        badge = `<span class="work-model-badge" style="color:${color};background:color-mix(in srgb, ${color} 14%, transparent)">${modelLabel}</span>`;
      }
      // Multi-office postings ("Palo Alto, CA; New York, NY") collapse to
      // just the first + a count — the full list still exists in m.location
      // for anything downstream that wants it (Generate, etc.), this is
      // display-only.
      const parts = m.location.split(";").map((s) => s.trim()).filter(Boolean);
      const displayLocation = parts.length > 1 ? `${parts[0]} (+${parts.length - 1})` : m.location;
      // Location text truncates with an ellipsis instead of wrapping, badge
      // never shrinks — keeps this row the same single-line height as every
      // other one (a long location value used to wrap the badge onto its
      // own second line, making this one row visibly taller than its
      // neighbors and the gaps around it look uneven).
      els.jobMetaLocationValue.innerHTML =
        `<span class="job-meta-location-text" title="${escapeHtml(m.location)}">${escapeHtml(displayLocation)}</span>${badge}`;
      els.jobMetaLocationValue.classList.remove("job-meta-value--empty");
    } else {
      els.jobMetaLocationValue.textContent = EMPTY;
      els.jobMetaLocationValue.classList.add("job-meta-value--empty");
    }
  }

  const setRow = (rowEl, valueEl, text) => {
    if (!rowEl || !valueEl) return;
    rowEl.classList.remove("hidden");
    if (text) {
      valueEl.textContent = text;
      valueEl.classList.remove("job-meta-value--empty");
    } else {
      valueEl.textContent = EMPTY;
      valueEl.classList.add("job-meta-value--empty");
    }
  };
  setRow(els.jobMetaSalaryRow, els.jobMetaSalaryValue, m.salary);
  setRow(els.jobMetaPostedRow, els.jobMetaPostedValue, m.posted);
}

/**
 * Fill the panel fields (company / role / JD) from a detection `result` and
 * refresh the fit chip + duplicate check. Shared by the manual Detect button
 * and the passive auto-detect path. `silent` (auto path) suppresses the error
 * toast on a non-job page; the fit chip + a short "Auto-detected: …" note are
 * still shown. Returns { filled: string[] }.
 */
async function applyDetectionResult(result, { silent = false, url = "" } = {}) {
  const prov = result.provenance || {};
  // Capture the job currently on screen BEFORE we overwrite the fields, so we
  // can tell (below) whether detection is switching to a DIFFERENT job.
  const prevCompany = (els.companyName?.value || "").trim().toLowerCase();
  const prevRole = (els.roleTitle?.value || "").trim().toLowerCase();
  const lowConfidence = [];
  const flagConfidence = (el, fieldProv, label) => {
    if (!el) return;
    const low = fieldProv && fieldProv.confidence === "low";
    el.classList.toggle("ab-low-confidence", !!low);
    if (low) {
      el.title = `Low-confidence guess${fieldProv.source ? ` (from ${fieldProv.source})` : ""} — please double-check.`;
      lowConfidence.push(label);
    } else {
      el.removeAttribute("title");
    }
  };

  renderJobMeta(result.meta);
  // Persisted per-tab, same as company/role/jobText below — otherwise this
  // is pure DOM state: switching to a tab with no detection yet (or one
  // that was never a job tab at all) leaves the PREVIOUS tab's location/
  // salary/etc. rows sitting on screen, since nothing ever told them to
  // clear (confirmed real bug — a brand-new tab showed the last job's
  // Location/Onsite/Salary rows with empty Company/Role above them).
  // applyStateToUI restores (or clears) this on every tab switch.
  await savePatch(TAB_ID, { jobMeta: result.meta || null });

  const filled = [];
  if (result.company) {
    els.companyName.value = result.company;
    await savePatch(TAB_ID, { companyName: result.company });
    filled.push("company");
  }
  if (result.title) {
    els.roleTitle.value = result.title;
    await savePatch(TAB_ID, { roleTitle: result.title });
    filled.push("role");
  }
  if (result.description) {
    els.jobText.value = result.description;
    await savePatch(TAB_ID, { jobText: result.description });
    filled.push("description");
  }

  // Detection switched to a DIFFERENT job than the one on screen? Any
  // generation still shown was made for the PREVIOUS job — drop it, otherwise
  // the panel keeps showing "Generated successfully" / Download CV / cover
  // letter for a job that was never generated in this tab. (Re-detecting the
  // SAME job leaves it as-is.)
  const newCompany = (result.company || "").trim().toLowerCase();
  const newRole = (result.title || "").trim().toLowerCase();
  const jobChanged =
    (!!newCompany && newCompany !== prevCompany) ||
    (!!newRole && newRole !== prevRole);
  if (
    jobChanged &&
    (STATE?.generatingStatus === "generated" || STATE?.generatingStatus === "error" || STATE?.info)
  ) {
    await clearGeneratedWork();
  }

  flagConfidence(els.companyName, prov.company, "company");
  flagConfidence(els.roleTitle, prov.title, "role");

  if (filled.length === 0) {
    if (!silent) {
      setStatus(TAB_ID, "Couldn't recognize job details on this page. Paste manually instead.", "error");
    }
    return { filled };
  }

  const tag = result.source === "json-ld" ? " (via JSON-LD)" : "";
  const lowNote = lowConfidence.length
    ? ` Double-check ${lowConfidence.join(" & ")} — low confidence.`
    : "";
  // Ensure the selected profile's country is loaded (cached, cheap) so the
  // location fit-check doesn't false-skip a role the candidate is eligible for.
  try { await fetchProfileLinks(selectedProfileId()); } catch { /* advisory */ }
  const fit = window.ProactiveJobFit.assessJobFit(result, { country: PROFILE_LOCATION });
  // Keep the status box itself quiet either way — a warning now interrupts
  // via openFitWarningModal below (the ONLY surface for it, replacing both
  // the old window.confirm() at Generate time and the in-page page badge),
  // not a lingering coloured status line behind it. Low-confidence is still
  // surfaced on the fields themselves (.ab-low-confidence + tooltip via
  // flagConfidence above). Any later status write (setStatus / Generate)
  // resets className and re-shows the box.
  els.genStatus.className = "status-box hidden";
  els.genStatus.textContent = "";
  if (fit.level !== "good") {
    openFitWarningModal(TAB_ID, fit, `${silent ? "Auto-detected" : "Filled"} ${filled.join(", ")}${tag}.${lowNote}`);
  }
  // Same "already applied?" gate Generate re-runs right before submitting
  // (see checkRecentDuplicate) — run it here too, right as the job is
  // detected, so the warning surfaces the moment the tab opens instead of
  // only after Generate is clicked. Deliberately checked twice: this one
  // and Generate's own re-check both fire independently, same as the fit
  // warning above never suppresses a re-detect just because it already
  // showed once. Not awaited — detection itself doesn't block on the user
  // dismissing it.
  void checkRecentDuplicate({
    tabId: TAB_ID,
    url,
    company: result.company || "",
    role: result.title || "",
    profileId: selectedProfileId(),
  });
  // Cache the full result so Generate-time can re-run assessJobFit with the
  // same pageText / jobLocationType context this check used.
  LAST_DETECT_RESULT = result;
  return { filled };
}

let AUTO_DETECT_INFLIGHT_URL = null;

/**
 * Smart-refresh eligibility for auto-detect on the current tab (STATE):
 * fill when the fields are empty (fresh tab) OR when the current content was
 * auto-filled for a DIFFERENT posting (you navigated to a new job). NEVER when
 * a generation exists (status, or hydrated info/files/generationId) or when
 * the fields hold content you typed.
 */
function autoDetectEligible(url) {
  if (
    STATE?.generatingStatus === "generating" ||
    STATE?.generatingStatus === "generated" ||
    STATE?.info ||
    (Array.isArray(STATE?.files) && STATE.files.length > 0) ||
    STATE?.generationId
  ) {
    return false;
  }
  if (url && STATE?.autoDetectedUrl && STATE.autoDetectedUrl === url) return false; // done this URL
  const fieldsEmpty =
    !(STATE?.companyName || "").trim() &&
    !(STATE?.roleTitle || "").trim() &&
    !(STATE?.jobText || "").trim();
  const autoOwnedStale = !!STATE?.autoDetectedUrl && (!url || STATE.autoDetectedUrl !== url);
  return fieldsEmpty || autoOwnedStale;
}

/**
 * PRIMARY auto-detect path: pull via executeScript (like the Detect button,
 * but silent). Robust because it injects the CURRENT detector files rather
 * than depending on the version of the content script already in the page —
 * so it works even in tabs opened before the extension was updated. Runs on
 * panel open / tab switch / navigation for the active tab when eligible.
 */
async function autoDetectActiveTab() {
  // Used to opt out entirely in Manual mode (ChatGPT ran against a single
  // shared tab, so a passive re-detect on tab switch could silently
  // overwrite whatever the user had just carried over by hand). Now that
  // Manual mode opens its own fresh ChatGPT tab per run, there's nothing
  // left for it to clobber — autoDetectEligible below already refuses to
  // touch fields the user typed or a generation that's already underway,
  // same protection Auto mode has always relied on.
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    return;
  }
  if (!tab?.id || tab.id !== TAB_ID) return;
  const url = tab.url || "";
  if (!/^https?:/i.test(url)) return;
  // Don't pull while the tab is still loading — injecting into a page that's
  // navigating races the top frame's teardown ("Frame with ID 0 was removed").
  // The onUpdated 'complete' event re-triggers this once the page settles; SPA
  // navigations keep status 'complete', so they're unaffected.
  if (tab.status === "loading") return;
  if (AUTO_DETECT_INFLIGHT_URL === url) return;
  if (!autoDetectEligible(url)) return;
  AUTO_DETECT_INFLIGHT_URL = url;
  try {
    await detectJobFromActiveTab({ silent: true });
  } finally {
    if (AUTO_DETECT_INFLIGHT_URL === url) AUTO_DETECT_INFLIGHT_URL = null;
  }
}

let AUTO_DETECT_TIMER = null;
/** Debounced trigger for the executeScript pull (tab events fire in bursts). */
function scheduleAutoDetect(delay = 350) {
  clearTimeout(AUTO_DETECT_TIMER);
  AUTO_DETECT_TIMER = setTimeout(() => { autoDetectActiveTab(); }, delay);
}

/**
 * SECONDARY auto-detect path: content-detect.js's `jd-detected` push. Catches
 * in-page SPA navigation the panel gets no tab event for. Same eligibility;
 * shares the in-flight guard with the pull so they can't double-fill.
 */
async function handleAutoDetect(msg, sender) {
  // See autoDetectActiveTab's own comment — Manual mode no longer opts out;
  // autoDetectEligible is what actually guards against clobbering below.
  const url = msg?.url || "";
  if (AUTO_DETECT_INFLIGHT_URL === url) return;
  try {
    if (sender?.tab?.id == null || sender.tab.id !== TAB_ID) return;
    const result = msg.result;
    if (!result || !result.title) return;
    if (!autoDetectEligible(url)) {
      // Not eligible for a full (re-)fill — but this may be the SECOND of
      // content-detect.js's / job-detect/engine/parser.js's two-stage
      // send: a fast sync pass (company/role/description, little or no
      // meta) immediately followed by a slower async one once the
      // Greenhouse boards-api round-trip resolves location/posted. The
      // first pass already marked this URL "done" above, so the richer
      // follow-up would otherwise be silently dropped and the meta panel
      // would stay stuck empty until a manual re-click (the original bug
      // report). Still require company+title to match what's already on
      // screen — confirms this is an enrichment of the same job, not a
      // stale push for one the user has since navigated away from.
      if (
        url === (STATE?.autoDetectedUrl || "") &&
        (result.company || "").trim().toLowerCase() === (els.companyName?.value || "").trim().toLowerCase() &&
        (result.title || "").trim().toLowerCase() === (els.roleTitle?.value || "").trim().toLowerCase()
      ) {
        renderJobMeta(result.meta);
        // Same per-tab persistence applyDetectionResult does for the sync
        // pass — otherwise a tab switch right after this enrichment lands
        // (before the user ever triggers a full re-detect) loses it again.
        await savePatch(TAB_ID, { jobMeta: result.meta || null });
      }
      return;
    }
    AUTO_DETECT_INFLIGHT_URL = url; // set before awaiting (single-threaded: safe)
    await applyDetectionResult(result, { silent: true, url });
    await savePatch(TAB_ID, { autoDetectedUrl: url });
  } catch (e) {
    // Passive path — non-actionable if it fails (the pull path / next event
    // recovers). Debug, not a warning that clutters the Errors panel.
    console.debug("[auto-detect] fill failed:", e);
  } finally {
    if (AUTO_DETECT_INFLIGHT_URL === url) AUTO_DETECT_INFLIGHT_URL = null;
  }
}

/**
 * Benign, self-recovering conditions during Detect — NOT real errors. The page
 * navigated or a frame was torn down mid-call, a frame had no injectable
 * content, or a messaging channel closed. The preferred→fallback path and the
 * next navigation event recover on their own, so these are logged at
 * console.debug (which, unlike warn/error, never surfaces in the extension's
 * Errors panel). Genuinely actionable failures — a missing host permission that
 * needs a reload — deliberately do NOT match, so they still warn.
 */
function isTransientDetectError(err) {
  const m = String(err?.message || err || "");
  return /frame with id|frame .*remov|frame was removed|no tab|tab (was )?(closed|not found)|returned no result|receiving end does not exist|message (channel|port) closed|back\/forward cache/i.test(
    m,
  );
}

/**
 * Does `url` match a manifest.json content_scripts `matches` pattern
 * (`<scheme>://<host><path>`, Chrome's own match-pattern grammar — not
 * the same syntax as the URLPattern Web API)? Minimal subset actually
 * used by this manifest's job-detect/sites/* entries: scheme is `*`
 * (http/https) or exact; host is `*`, `*.example.com`, or exact;
 * path's `*` matches any run of characters.
 */
function urlMatchesContentScriptPattern(pattern, url) {
  try {
    const m = /^(\*|https?|file|ftp):\/\/(\*|\*\.[^/*]+|[^/*]+)(\/.*)$/.exec(pattern);
    if (!m) return false;
    const [, scheme, host, path] = m;
    const u = new URL(url);
    if (!(scheme === "*" ? /^https?:$/.test(u.protocol) : u.protocol === scheme + ":")) return false;
    const hostOk =
      host === "*" ||
      (host.startsWith("*.") ? (u.hostname === host.slice(2) || u.hostname.endsWith("." + host.slice(2))) : u.hostname === host);
    if (!hostOk) return false;
    const pathRe = new RegExp("^" + path.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
    return pathRe.test(u.pathname + u.search);
  } catch {
    return false;
  }
}

/**
 * This host's own job-detect/sites/*.js parser file(s) (plus their
 * job-detect/engine/parser.js + jobmeta.js dependencies), read straight
 * from manifest.json's content_scripts — the SAME list Chrome itself uses
 * to passively inject them on page load. Single source of truth: a newly
 * ported site works here automatically the moment it's added to the
 * manifest, nothing to keep in sync by hand. Empty for a host with no
 * ported per-site parser (most of the web) — callers skip the extra
 * injection entirely in that case.
 */
function matchingJobDetectSiteFiles(url) {
  const files = [];
  try {
    for (const entry of chrome.runtime.getManifest().content_scripts || []) {
      const entryFiles = entry.js || [];
      if (!entryFiles.some((f) => f.startsWith("job-detect/sites/"))) continue;
      if ((entry.matches || []).some((p) => urlMatchesContentScriptPattern(p, url))) {
        for (const f of entryFiles) if (!files.includes(f)) files.push(f);
      }
    }
  } catch {
    /* ignore — falls through to the generic job-fit.js result only */
  }
  return files;
}

async function detectJobFromActiveTab({ silent = false } = {}) {
  // Company, Role, and JD already filled in by hand (typed or pasted — e.g.
  // an ATS the page-scraper can't reach) means there's nothing to detect,
  // and no reason to run the "is this even a job page" heuristic below
  // against whatever the current tab happens to be — it may have nothing to
  // do with what the user already pasted. Generate only needs these three
  // filled, not Detect's approval, so this is a no-op rather than a
  // "doesn't look like a job posting" error blocking a click on Generate.
  // Only skips the SILENT auto-detect (tab open/switch) though — a manual
  // click on the re-detect button must always actually re-run detection,
  // even when the fields are already filled, or the button would do nothing
  // the moment detection has already run once (i.e. almost always).
  const alreadyFilled =
    !!els.companyName?.value?.trim() && !!els.roleTitle?.value?.trim() && !!els.jobText?.value?.trim();
  if (silent && alreadyFilled) return;

  const btn = silent ? null : els.detectJobBtn;
  // Manual re-detect is often near-instant (page already scraped, content
  // script already injected) — re-enabling the button the moment the async
  // work resolves could end the disabled/spin state before a single visible
  // rotation completes (one spin is 0.8s — see panel.css's `spin` keyframe).
  // Floor how long it stays disabled/spinning at that same duration so a
  // click always reads as "something happened", not silence.
  const detectStartedAt = Date.now();
  const MIN_SPIN_MS = 800;
  try {
    // Label stays put ("Auto-detected") — swapping it to "Detecting…" and
    // back read as the whole pill flashing when detection was fast. The
    // spinning refresh icon (.detect-pill:disabled .detect-pill__refresh in
    // panel.css) is the only in-flight feedback now.
    if (btn) {
      btn.disabled = true;
    }
    if (!silent) setStatus(TAB_ID, "Reading job details from the current tab…", "loading");

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      if (!silent) setStatus(TAB_ID, "No active tab found.", "error");
      return;
    }
    const url = tab.url || "";
    if (!url || /^(chrome|edge|about|chrome-extension|file):/i.test(url)) {
      if (!silent) setStatus(TAB_ID, "Open a job posting in a normal browser tab first.", "error");
      return;
    }

    if (!chrome?.scripting?.executeScript) {
      if (!silent) setStatus(
        TAB_ID,
        "Reload ProActive at chrome://extensions/ (click the reload icon) to enable Detect from page.",
        "error"
      );
      console.warn("[detect] chrome.scripting is unavailable — extension needs a full reload after the manifest change.");
      return;
    }

    let result;
    try {
      // allFrames:true so we also probe iframes — ATS embed widgets
      // (Greenhouse, Workday) render the JD inside a cross-origin
      // iframe the top frame can't read. CRITICAL: trust iframe
      // results ONLY when the iframe's host is a known ATS — otherwise
      // a Tally/Typeform/Calendly application form embedded on a
      // company career page wins the "longest description" race (the
      // form labels are a substantial text blob) and the JD field
      // gets populated with question titles instead of the role.
      // Detection runs in the page via the content-script global
      // (window.ProactiveJobFit) rather than by serializing
      // extractFromDocument's source. Serializing only worked because the
      // function was one self-contained closure; calling the global frees
      // the detector to be split across files later (loaded the way
      // autofill is). We files-inject job-fit.js first so tabs opened
      // before the content script registered still have it, then call the
      // global in every frame. On ANY problem — injection blocked, wrong
      // world, no results — we fall back to the exact legacy serialized-
      // function path so Detect can never regress.
      let frames;
      try {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            // Order matters: job-detect/* define window.ProactiveJobDetect,
            // which job-fit.js consumes. Keep in sync with manifest
            // content_scripts and sidepanel.html.
            files: [
              "job-detect/_bootstrap.js",
              "job-detect/resolver.js",
              "job-detect/normalize/text.js",
              "job-detect/normalize/html.js",
              "job-detect/normalize/geo.js",
              "job-detect/normalize/language.js",
              "job-detect/normalize/roles.js",
              "job-detect/dom/query.js",
              "job-detect/dom/regions.js",
              "job-detect/extractors/structured/jsonld.js",
              "job-detect/extractors/adapters/index.js",
              "job-detect/extractors/structured/jobmeta.js",
              "job-fit.js",
            ],
          });
        } catch (injectErr) {
          // Some frames reject injection; the content-script global may
          // still be present. Let the empty-result check below decide.
          console.debug("[detect] files-injection partial/blocked:", injectErr);
        }
        frames = await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          func: () =>
            typeof window !== "undefined" && window.ProactiveJobFit
              ? window.ProactiveJobFit.extractFromDocument()
              : null,
        });
        if (!frames || !frames.some((f) => f && f.result)) {
          throw new Error("global call returned no result");
        }
      } catch (preferErr) {
        // Expected: the global path routinely can't run (page navigating, no
        // injected content yet). The serialized fallback below recovers, so
        // this is a debug note, not a warning that clutters the Errors panel.
        console.debug("[detect] global-call path failed; using legacy serialized func:", preferErr);
        frames = await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          func: window.ProactiveJobFit.extractFromDocument,
        });
      }
      const KNOWN_ATS_HOSTS = [
        "linkedin.com", "indeed.com", "lever.co", "greenhouse.io",
        "ashbyhq.com", "workable.com", "wellfound.com", "angel.co",
        "smartrecruiters.com", "hirehive.com", "workdayjobs.com",
        "myworkdayjobs.com", "bamboohr.com", "join.com", "zohorecruit",
        "teamtailor.com", "recruitee.com", "personio", "jobvite.com",
        "icims.com", "taleo.net", "successfactors", "breezy.hr",
        "traffit.com", "recruitcrm.io",
      ];
      const isAtsHost = (h) => KNOWN_ATS_HOSTS.some((k) => h.includes(k));
      let tabHost = "";
      try { tabHost = new URL(tab.url || "").hostname; } catch { /* ignore */ }
      const candidates = (frames || [])
        .map((f) => f && f.result)
        .filter((r) => r && (r.description || "").length > 0)
        .filter((r) => {
          // Top-frame results are always trusted (the user navigated
          // here). Iframe results need an ATS host on the iframe
          // itself, otherwise they get filtered out — that's the
          // Tally / Calendly / Intercom rejection lane.
          let host = "";
          try { host = new URL(r.url || "").hostname; } catch { return false; }
          if (!host) return false;
          if (tabHost && host === tabHost) return true;
          return isAtsHost(host);
        });
      candidates.sort(
        (a, b) => (b.description || "").length - (a.description || "").length,
      );
      result = candidates[0] || null;

      // Prefer this host's own ported job-detect/sites/*.js parser (the
      // exact same one the page's passive content-script injection
      // already runs) over the generic result above, when one exists —
      // see matchingJobDetectSiteFiles/job-detect/engine/parser.js's
      // runNow for why: the generic adapters/JSON-LD scrape above is a
      // one-size-fits-all fallback that doesn't know a given ATS's real
      // data shape (e.g. Ashby's Application tab renders the FORM where
      // Overview renders the description — a DOM-only scrape comes back
      // empty on half of Ashby's own pages), where the ported parser was
      // written and tested against exactly that page's own markup/data.
      try {
        const siteFiles = matchingJobDetectSiteFiles(url);
        if (siteFiles.length) {
          await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: siteFiles });
          const siteFrames = await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            func: () =>
              typeof window !== "undefined" && window.ProactiveJobDetect && window.ProactiveJobDetect.runNow
                ? window.ProactiveJobDetect.runNow()
                : null,
          });
          const siteResult = (siteFrames || []).map((f) => f && f.result).find((r) => r && r.title);
          if (siteResult) {
            result = {
              ...(result || {}),
              source: "site-parser",
              title: siteResult.title,
              company: siteResult.company ?? null,
              description: siteResult.description || (result ? result.description : null) || null,
              url,
              provenance: {
                ...((result && result.provenance) || {}),
                title: { source: "site-parser", confidence: "high", score: 1 },
                company: { source: "site-parser", confidence: "high", score: 1 },
                description: { source: "site-parser", confidence: "high", score: 1 },
              },
            };
          }
        }
      } catch (e) {
        // Non-fatal by design — the generic `result` computed above is
        // still a perfectly usable fallback.
        console.debug("[detect] site-specific parser pull failed; using generic result:", e);
      }
    } catch (e) {
      const msg = String(e?.message || e);
      let hint = msg;
      // Common Chrome permission failure: surface the actionable fix.
      if (/cannot access|cannot read|missing host permission/i.test(msg)) {
        hint =
          "No permission to read this page. Reload ProActive at chrome://extensions/ — the updated manifest grants access to all sites.";
      } else if (/no tab|tab not found|frame/i.test(msg)) {
        hint = "Lost the tab while reading. Switch to the job tab and try again.";
      }
      if (!silent) setStatus(TAB_ID, "Detect failed: " + hint, "error");
      // A page that navigated out from under us (frame removed / tab gone), and
      // any failure on the passive auto-detect path, is non-actionable churn —
      // keep it out of the Errors panel. Genuine, actionable failures on a
      // manual Detect (e.g. missing host permission) still warn.
      if (silent || isTransientDetectError(e)) {
        console.debug("[detect] executeScript failed (transient):", e);
      } else {
        console.warn("[detect] executeScript failed:", e);
      }
      return;
    }

    if (!result) {
      if (!silent) setStatus(TAB_ID, "Detection returned no data.", "error");
      return;
    }

    // ─── Reject non-job pages ────────────────────────────────────────
    // Without this, Detect picks up nonsense on Google search results,
    // Wikipedia, documentation, etc. — anything with a <title> and
    // some text body looks "extractable". Run the same isLikelyJobPage
    // heuristic the floating badge uses; refuse to populate the form
    // when it fails (host + body + title gate).
    try {
      // job-fit.js is already files-injected above, so call the global;
      // fall back to the legacy serialized func on any error / no result.
      let checkFrames;
      try {
        checkFrames = await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          func: (r) =>
            typeof window !== "undefined" && window.ProactiveJobFit
              ? window.ProactiveJobFit.isLikelyJobPage(r)
              : null,
          args: [result],
        });
        if (!checkFrames || !checkFrames.some((f) => f && f.result != null)) {
          throw new Error("global isLikelyJobPage returned no result");
        }
      } catch (preferErr) {
        console.debug("[detect] global isLikelyJobPage failed; using legacy serialized func:", preferErr);
        checkFrames = await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          func: window.ProactiveJobFit.isLikelyJobPage,
          args: [result],
        });
      }
      const passes = (checkFrames || []).some((f) => f && f.result === true);
      if (!passes) {
        if (!silent) setStatus(
          TAB_ID,
          "This page doesn't look like a job posting. Open the role page first, or paste the JD into the field below.",
          "error",
        );
        return;
      }
    } catch (e) {
      // If the check itself fails for some reason, fall through and
      // proceed — preferable to blocking a valid detect on a flaky
      // executeScript call. Non-fatal by design, so debug (not a warning that
      // clutters the Errors panel).
      console.debug("[detect] isLikelyJobPage check failed; proceeding:", e);
    }

    // Job-posting metadata (location/work-model/employment type/experience
    // level/salary/posted/expiration — job-detect/extractors/structured/
    // jobmeta.js, already files-injected above). This manual/pull Detect
    // path never routes through content-detect.js's run() or job-detect/
    // engine/parser.js's defaultMessageSender (the two passive-push hooks),
    // so it needs its own explicit call here — otherwise .meta is never
    // computed at all for a manually-triggered Detect. Run in every frame
    // (same allFrames probe as the detection itself) and keep whichever
    // frame's metadata has the most fields populated.
    try {
      const metaFrames = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: (r) =>
          typeof window !== "undefined" && window.ProactiveJobMeta
            ? window.ProactiveJobMeta.extract(document, r)
            : null,
        args: [result],
      });
      const metaCandidates = (metaFrames || [])
        .map((f) => f && f.result)
        .filter(Boolean);
      metaCandidates.sort(
        (a, b) => Object.values(b).filter(Boolean).length - Object.values(a).filter(Boolean).length,
      );
      if (metaCandidates[0]) {
        result.meta = metaCandidates[0];
        // Greenhouse's own authoritative employer name beats this page's
        // own DOM-guess company resolution when it found one.
        if (metaCandidates[0].company) result.company = metaCandidates[0].company;
      }
    } catch (e) {
      console.debug("[detect] jobmeta extraction failed:", e);
    }

    // Per-field detection confidence (job-fit.js provenance). A field
    // tagged "low" came from a heuristic guess (hostname slug, title
    // split) rather than structured data or a site adapter — flag it so
    // the user double-checks instead of trusting it silently.
    await applyDetectionResult(result, { silent, url });
    // Mark this URL as detection-owned so auto-detect can refresh it later
    // (smart-refresh) but won't treat manually-detected content as user edits.
    await savePatch(TAB_ID, { autoDetectedUrl: url });
  } catch (e) {
    console.error("[detect] failed:", e);
    if (!silent) setStatus(TAB_ID, "Detect failed: " + (e?.message || e), "error");
  } finally {
    if (btn) {
      const elapsed = Date.now() - detectStartedAt;
      if (elapsed < MIN_SPIN_MS) await new Promise((r) => setTimeout(r, MIN_SPIN_MS - elapsed));
      btn.disabled = false;
    }
  }
}

// Keyed by tabId — a poor-fit result detected for tab A has to stay tied to
// tab A even if the user switches away before dismissing it, the same
// per-tab pattern as DUP_WARNING_PENDING below.
const FIT_WARNING_OPEN = new Map();

/**
 * Open the job-fit warning modal (#fitWarningBackdrop) from an
 * assessJobFit() result — only ever called for check/skip (see
 * applyDetectionResult; a "good" fit never opens this). Replaces the old
 * status-box "fit chip", the Generate-time window.confirm(), and the
 * in-page floating badge — this modal is now the ONLY surface for a
 * poor-fit warning. `filledNote` is the "Auto-detected company, role, …"
 * line so the user still sees what Detect populated. Closed only via
 * dismissFitWarningModal (the Continue button) — no back/X button, no
 * backdrop-click-to-close, so it can't be dismissed by accident. Only
 * painted on screen if tabId is the tab currently on screen — otherwise it
 * stays pending for loadForTab to paint once the user switches back to it.
 */
function openFitWarningModal(tabId, fit, filledNote) {
  if (!els.fitWarningBackdrop) return;
  FIT_WARNING_OPEN.set(tabId, { fit, filledNote });
  if (tabId === TAB_ID) renderFitWarningModal(tabId);
}

function renderFitWarningModal(tabId) {
  const pending = FIT_WARNING_OPEN.get(tabId);
  if (!pending || !els.fitWarningBackdrop) return;
  const isSkip = (pending.fit?.level || "check") === "skip";
  const reasons = (pending.fit?.reasons || []).slice(0, 4);

  if (els.fitWarningBadge) {
    els.fitWarningBadge.className = "fit-modal-badge " + (isSkip ? "fit-modal-badge--skip" : "fit-modal-badge--check");
    els.fitWarningBadge.textContent = isSkip ? "✕ Likely skip" : "！ Check";
  }
  if (els.fitWarningReasons) {
    els.fitWarningReasons.innerHTML = "";
    const items = reasons.length ? reasons : ["Remote-friendly, no blockers found."];
    for (const r of items) {
      const li = document.createElement("li");
      li.textContent = r;
      els.fitWarningReasons.appendChild(li);
    }
  }
  if (els.fitWarningNote) els.fitWarningNote.textContent = pending.filledNote || "";
  els.fitWarningBackdrop.classList.remove("hidden");
}

// Tab-switch-away: hide without forgetting — the entry in FIT_WARNING_OPEN
// stays so loadForTab can repaint it if the user comes back to this tab.
function hideFitWarningModal() {
  els.fitWarningBackdrop?.classList.add("hidden");
}

// Continue click: explicit dismissal for the tab currently on screen only.
function dismissFitWarningModal() {
  els.fitWarningBackdrop?.classList.add("hidden");
  FIT_WARNING_OPEN.delete(TAB_ID);
}

// Keyed by tabId — a Generate click on tab A can still be waiting on this
// check when the user switches to tab B, so the resolver and the "how many
// days ago" text have to stay per-tab, not a single global slot (which is
// what let tab B's screen show tab A's "already applied" gate).
const DUP_WARNING_PENDING = new Map();

/**
 * Show the "you already applied" gate and resolve once Continue is
 * clicked. Generate awaits this directly (see checkRecentDuplicate) —
 * unlike openFitWarningModal (advisory only, generation never waits on
 * it), this one genuinely blocks: nothing is sent to the server until
 * the promise resolves. Only painted on screen if tabId is the tab
 * currently on screen — otherwise it stays pending, queued for
 * renderDupWarningModal to paint if/when the user switches back to it.
 */
// "Today" for anything under an hour old (an "0 hours ago" reads oddly),
// then hour granularity through the rest of the first day, then day
// granularity — matches the four example outputs this was designed
// against: Today / 2 hours ago / 2 days ago / 6 days ago.
function formatAppliedAgo(appliedAt) {
  const diffMs = Date.now() - new Date(appliedAt).getTime();
  const hours = Math.floor(diffMs / 3600000);
  if (hours < 1) return "Today";
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

function openDupWarningModal(tabId, appliedAt) {
  return new Promise((resolve) => {
    DUP_WARNING_PENDING.set(tabId, { resolve, appliedAt });
    if (tabId === TAB_ID) renderDupWarningModal(tabId);
  });
}

function renderDupWarningModal(tabId) {
  const pending = DUP_WARNING_PENDING.get(tabId);
  if (!pending) return;
  if (els.dupWarningNote) {
    els.dupWarningNote.innerHTML = "";
    els.dupWarningNote.append(
      "You already applied to this job ",
      Object.assign(document.createElement("strong"), { textContent: formatAppliedAgo(pending.appliedAt) }),
      ". Continue if you still want to generate another application for it."
    );
  }
  els.dupWarningBackdrop?.classList.remove("hidden");
}

// Tab-switch-away: hide it without resolving — the Generate call it belongs
// to is still legitimately waiting, just not for the tab on screen any more.
// loadForTab re-paints it (via renderDupWarningModal) if the user comes back.
function hideDupWarningModal() {
  els.dupWarningBackdrop?.classList.add("hidden");
}

// Continue click: only ever resolves the CURRENTLY DISPLAYED tab's pending
// check — it's the only one the user could actually be looking at.
function continueDupWarningModal() {
  const tabId = TAB_ID;
  els.dupWarningBackdrop?.classList.add("hidden");
  const pending = DUP_WARNING_PENDING.get(tabId);
  if (!pending) return;
  DUP_WARNING_PENDING.delete(tabId);
  pending.resolve();
}

// Tracking-only query params — same rule the main BCD app's own "Clean
// URLs" buttons strip (LinkedIn Jobs / Statistics > Application, and now the
// server itself at generate/mark-applied time — see jobHash.js's
// cleanJobUrl). Duplicated here rather than imported — no shared code path
// between the extension and the server in this monorepo. Cleaning
// client-side too (on top of the server's own normJobUrl now doing it)
// means the CURRENT tab's url compares correctly against a STORED jobUrl
// that predates this fix and still carries different tracking params than
// today's page.
const REMOVABLE_EXACT_URL_PARAMS = new Set(["source", "gh_src", "src"]);
function cleanJobUrl(raw) {
  const str = String(raw || "").trim();
  if (!str) return str;
  let u;
  try {
    u = new URL(str);
  } catch {
    return str; // not a parseable absolute URL — leave it alone
  }
  const kept = [...u.searchParams.entries()].filter(([key]) => {
    const k = key.toLowerCase();
    return !k.startsWith("utm_") && !REMOVABLE_EXACT_URL_PARAMS.has(k);
  });
  u.search = "";
  for (const [k, v] of kept) u.searchParams.append(k, v);
  return u.toString();
}

/**
 * Raw "have I already applied?" lookup — GET check-recent with the exact
 * inputs Generate is about to submit (see applicationController.js's
 * checkRecent: same jobUrlNorm/company/role/profile, applied within the
 * last 7 days). Returns the match (or null) with no UI side effect — used
 * both by checkRecentDuplicate below (which turns a match into the modal
 * gate) and by runAutoApply (which turns a match into a silent skip,
 * never a modal, since nothing's there to click it during an unattended
 * run). Never throws — a network/check failure reads as "no match" either
 * way, since this is advisory, not a hard rule the server enforces.
 */
async function fetchRecentDuplicateMatch({ url, company, role, profileId }) {
  try {
    const qs = new URLSearchParams({
      url: cleanJobUrl(url || ""),
      company: company || "",
      role: role || "",
      profileId: profileId || "",
    });
    const resp = await apiFetch(`/me/applications/check-recent?${qs.toString()}`);
    return resp?.match || null;
  } catch {
    return null;
  }
}

/**
 * Best-effort "have I already applied?" gate — wraps fetchRecentDuplicateMatch
 * above with the modal side effect Generate's own click handler and the
 * auto-detect path want. Never blocks Generate on a network/check failure —
 * this is a courtesy warning, not a hard rule the server enforces. Resolves
 * once the user has acknowledged (or there was nothing to acknowledge).
 */
async function checkRecentDuplicate({ tabId, url, company, role, profileId }) {
  const match = await fetchRecentDuplicateMatch({ url, company, role, profileId });
  if (match) await openDupWarningModal(tabId, match.appliedAt);
}

let isDownloadingCover = false; // guards the cover-letter PDF export/download click
let isDownloadingJd = false; // guards the job-description PDF export/download click

// ============================================================
// Provider error message mapping
// ============================================================

/**
 * Turn a raw provider/server error (string) into a user-actionable message.
 * Looks at substrings that providers consistently use in their error bodies.
 * If nothing matches, returns the original message — no information lost.
 */
function humaniseProviderError(raw) {
  const s = String(raw || "").toLowerCase();
  if (!s) return "Something went wrong.";

  // Zeroed quota — the provider reports a hard limit of 0 (e.g. Gemini's free
  // tier isn't available for this Google project/region, or billing is off).
  // This is NOT a transient rate-limit: retrying never succeeds, so it must be
  // matched BEFORE the generic rate-limit check below (which also catches 429).
  if (/limit:\s*0\b/.test(s)) {
    return "This provider key has no usable quota — its limit is 0 (free tier unavailable for this account/region, or billing is off). Waiting won't help. Ask your admin to enable billing on the key or switch to a different provider/key.";
  }
  // Rate limits — the most common free-tier failure.
  if (/rate.?limit|tpm|rpm|429|too many requests/.test(s)) {
    return "Free quota or rate limit hit. Wait 30–60s and try again, or ask your admin to add a different provider/key.";
  }
  // Provider-side account restrictions (Groq's free-tier abuse detection,
  // OpenAI billing holds, etc.). These can NOT be fixed by changing keys
  // alone — the underlying account is the problem.
  if (/organization.*restrict|account.*(restrict|suspend|disable|terminat|ban)|access.*denied/.test(s)) {
    return "The AI provider's account is restricted or suspended. Rotate to a different key (or different provider) in the admin panel, or contact the provider's support.";
  }
  // No key assigned at all (Pro/Free mode, nothing picked on the
  // Resume/Extension page) — the server's own message for this is a full
  // sentence of setup instructions, way too long for a toast (confirmed
  // real complaint). Matched on the error code itself (no_api_key), not
  // the sentence text, so it doesn't depend on the server's exact wording.
  if (/no_api_key/.test(s)) {
    return "API key is not set.";
  }
  // Auth — bad / missing / revoked key.
  if (/invalid api key|incorrect api key|unauthor|401/.test(s)) {
    return "API key is invalid.";
  }
  // OpenAI quota exhausted (different from rate-limit — billing).
  if (/insufficient_quota|exceeded.*quota|billing/.test(s)) {
    return "The AI account has no credit left. Ask your admin to top it up or switch to a free provider (Groq/Gemini).";
  }
  // Model deprecated / removed / not allowed for this key tier.
  if (/model_not_found|does not have access|model.*not.*available|deprecat/.test(s)) {
    return "Selected model isn't available on this key. Ask your admin to pick a different model.";
  }
  // Server config issues
  if (/encryption_not_configured/.test(s)) {
    return "Server is missing its ENCRYPTION_KEY. Admin: run `npm run gen:key` and add it to .env.";
  }
  if (/openai_config|no api key configured/.test(s)) {
    return "No AI API key is configured for this account. Ask your admin to set one.";
  }
  // Content / length issues. The server already retries once with double
  // the token budget, so by the time the user sees this, raising the env
  // var probably won't help (we've hit the provider's own ceiling).
  if (/truncated_at_cap|truncated even with max_tokens/.test(s)) {
    return "The AI ran out of output room even after retrying with more tokens. Shorten the job description, or switch to a model with a larger completion budget in the admin panel.";
  }
  if (/max_tokens|output was truncated|finish_reason.*length/.test(s)) {
    return "The AI response was cut off. Try again — if it keeps happening, shorten the job description.";
  }
  if (/parse|invalid json|unexpected token/.test(s)) {
    return "The AI returned malformed output. Try again — if it persists, switch model in the admin panel.";
  }
  // Validation / missing fields
  if (/validation_error|invalid email|invalid id/.test(s)) {
    return "The request was rejected as invalid. Check the form fields and try again.";
  }
  // Network
  if (/network|fetch failed|err_empty_response|err_connection|err_internet/.test(s)) {
    return "Couldn't reach the server. Check your internet and that the API host is up.";
  }
  // Fallthrough — return the original (capitalised) so we don't hide useful detail.
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// ============================================================
// Generation progress stepper
// ============================================================

// Backend stages, in execution order, with rough expected durations (ms).
// Numbers are calibrated against llama-3.3-70b-versatile on Groq free tier
// for a typical resume — about 20-35 seconds end to end. The status text
// auto-advances along this timeline so users see realistic progress even
// though the underlying HTTP call is a single blocking request. More/denser
// stages than the actual pipeline has distinct steps for — the point is a
// wait that reads as "actively doing a lot of specific things" rather than
// a handful of long, sparse phrases with dead air between them.
const GEN_STAGES = [
  { label: "Reading the job description…", at: 0 },
  { label: "Identifying key requirements…", at: 1400 },
  { label: "Extracting keywords and must-have skills…", at: 2800 },
  { label: "Matching your experience to the role…", at: 4400 },
  { label: "Ranking your strongest achievements…", at: 5900 },
  { label: "Drafting tailored resume bullets…", at: 7600 },
  { label: "Quantifying impact where the numbers support it…", at: 9800 },
  { label: "Weaving in the job's own keywords…", at: 12000 },
  { label: "Reordering skills to match the JD…", at: 14000 },
  { label: "Polishing the summary and headline…", at: 16200 },
  { label: "Writing the cover letter…", at: 18200 },
  { label: "Matching tone to the company…", at: 20800 },
  { label: "Tightening phrasing and cutting filler…", at: 22800 },
  { label: "Laying out the resume…", at: 24800 },
  { label: "Rendering the PDF…", at: 26800 },
  { label: "Finalising…", at: 29500 },
];

let GEN_PROGRESS_TIMERS = [];
let GEN_PROGRESS_RAF = null;
let GEN_PROGRESS_START = 0;

// AbortController for an in-flight /full-generate-and-download (or Manual
// mode's compose/finish) request, so the Stop button can cancel a stuck
// generation — keyed by job tabId (NOT a single scalar) because several
// tabs can genuinely be generating at once now (Auto-Apply already
// overlaps runs in practice, and Manual mode's own-ChatGPT-tab-per-job
// flow makes real concurrency routine, not an edge case) — a shared
// scalar meant Stop could only ever cancel whichever tab started LAST,
// leaving every other concurrent run un-cancellable. No entry = nothing
// running for that tab.
const GENERATION_ABORT_BY_TAB = new Map();

/** Total expected duration we drive the fill to 90% over. Chosen to
 *  match the typical /full-generate-and-download wall clock so most
 *  runs feel "live" rather than overshooting or stalling. Calibrated
 *  against llama-3.3-70b-versatile on Groq free tier. */
const GEN_PROGRESS_TARGET_MS = 28000;

// Generate's own progress fill (.gd-main__fill) — a clip-path reveal of the
// same gradient the pill's border uses, in place of the old separate bar.
function setGenProgress(pct) {
  if (!els.genProgressFill) return;
  const clamped = Math.max(0, Math.min(100, pct));
  els.genProgressFill.style.clipPath = `inset(0 ${(100 - clamped).toFixed(1)}% 0 0)`;
}

// Swaps the split pill's right segment between Download and Stop — Stop
// while a generation is running (there's nothing to download yet anyway),
// Download otherwise. Same box either way, see .gd-download/.gd-stop.
function setGenerateRunning(running) {
  els.downloadCvBtn?.classList.toggle("hidden", running);
  els.stopGenerateBtn?.classList.toggle("hidden", !running);
}

function startGenerationProgress(tabId) {
  stopGenerationProgress();
  setGenerateRunning(true);
  // Resume from the persisted per-tab start time so switching away and back
  // shows the RIGHT progress for THIS tab (the fill is a shared DOM element;
  // driving it off persisted state is what keeps one tab's generation from
  // showing in another tab's panel).
  GEN_PROGRESS_START = STATE?.generatingStartedAt || Date.now();
  const elapsed0 = Date.now() - GEN_PROGRESS_START;
  // Auto mode's own canned OpenAI-flavoured stage labels ("Reading the job
  // description…", "Calling the AI…", etc.) don't apply to Manual mode —
  // its button label comes from the live ChatGPT round trip instead
  // (runManualGenerate's own setButtonText calls, and the BANANA_STREAM_CHUNK
  // listener above once ChatGPT starts actually answering). Skip scheduling
  // them here so they can't overwrite that with a stale canned label.
  if (RESUME_MODE !== "manual") {
    // Set the button's label to whichever stage is already current right away
    // — no gap where it'd still say "Generate" (fresh click) or the wrong
    // stage (tab-switch resume) until the next timeout below happens to fire.
    if (tabId === TAB_ID) setButtonText(els.generateBtn, currentGenStageLabel());
    // Status-text stages — only schedule the ones still in the future, so a
    // resume doesn't replay "Reading…" from the top. { toast: false }: the
    // progress fill already surfaces this in-panel, so these no longer also
    // spawn a page toast for every stage change. Also drives the Generate
    // button's own label (see currentGenStageLabel) — no separate "Generating…"
    // placeholder any more, this IS what the button shows while running.
    for (const stage of GEN_STAGES) {
      const delay = stage.at - elapsed0;
      if (delay < 0) continue;
      const id = setTimeout(() => {
        if (STATE?.generatingStatus === "generating" && tabId === TAB_ID) {
          setStatus(tabId, stage.label, "loading", { toast: false });
          setButtonText(els.generateBtn, stage.label);
        }
      }, delay);
      GEN_PROGRESS_TIMERS.push(id);
    }
  }
  // Fill sweep — animate from 0% to ~90% over GEN_PROGRESS_TARGET_MS using a
  // decelerating curve so the visible motion feels active early on and
  // gracefully stalls near the top (the actual request usually finishes
  // between 75-90%, at which point stopGenerationProgress snaps it to 100).
  // 1 - (1-t)^2 gives a smooth ease-out that hits 90% on schedule.
  const tick = () => {
    if (STATE?.generatingStatus !== "generating" || tabId !== TAB_ID) {
      GEN_PROGRESS_RAF = null;
      return;
    }
    const elapsed = Date.now() - GEN_PROGRESS_START;
    const t = Math.min(1, elapsed / GEN_PROGRESS_TARGET_MS);
    // Ease-out, capped at 90% so we don't pretend the server is done.
    const pct = 90 * (1 - Math.pow(1 - t, 2));
    setGenProgress(pct);
    GEN_PROGRESS_RAF = requestAnimationFrame(tick);
  };
  GEN_PROGRESS_RAF = requestAnimationFrame(tick);
}

function stopGenerationProgress(opts) {
  for (const id of GEN_PROGRESS_TIMERS) clearTimeout(id);
  GEN_PROGRESS_TIMERS = [];
  if (GEN_PROGRESS_RAF !== null) {
    cancelAnimationFrame(GEN_PROGRESS_RAF);
    GEN_PROGRESS_RAF = null;
  }
  setGenerateRunning(false);
  // On success, snap to 100% and STAY there — the button keeps its
  // light-gradient "done" fill rather than reverting to plain white.
  // Only reset back to empty on a non-success end (aborted/failed —
  // nothing was actually completed, so no "done" fill should persist);
  // the NEXT run starts from 0% again via the rAF tick in
  // startGenerationProgress.
  setGenProgress(opts?.success ? 100 : 0);
}

// ============================================================
// Saved-PDF download helper (used by batch results)
// ============================================================
// (removed) ATS / Refine / Recent applications / Analytics / Recent JDs
// Those features now live in the admin panel's "My Applications" page.
// ============================================================
function setLoginModalError(text) {
  if (!els.loginModalError) return;
  if (text) {
    els.loginModalError.textContent = text;
    els.loginModalError.classList.remove("hidden");
  } else {
    els.loginModalError.textContent = "";
    els.loginModalError.classList.add("hidden");
  }
}

async function updateLoginGate() {
  const token = await getToken();
  const locked = !token;
  document.body.classList.toggle("login-locked", locked);
  if (els.loginModal) {
    els.loginModal.classList.toggle("hidden", !locked);
    els.loginModal.setAttribute("aria-hidden", locked ? "false" : "true");
  }
  if (els.loggedInBar) els.loggedInBar.classList.toggle("hidden", locked);
  if (locked) {
    setTimeout(() => els.loginEmail?.focus(), 0);
  } else {
    setLoginModalError("");
  }
}

// ---------------------------------------------------------------------------
// Profile tab: a card per assigned profile, opening into a detail view with
// its own Profile (resume) / Contact / Sources sub-tabs. Reads entirely out
// of PROFILE_OPTIONS/PROFILES_BY_ID (already populated by
// loadProfilesFromServer for the Job details dropdown) — no new fetch.
// ---------------------------------------------------------------------------

// Same raw month-input format ("2022-01") and rendering as the BCD web app's
// own lib/profiles.js fmtSpan/fmtMonth.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtMonth(v) {
  if (!v) return "";
  const m = /^(\d{4})-(\d{2})$/.exec(v);
  if (!m) return v;
  const idx = Number(m[2]) - 1;
  return MONTHS[idx] ? `${MONTHS[idx]} ${m[1]}` : v;
}
function fmtSpan(start, end) {
  const s = fmtMonth(start);
  const e = fmtMonth(end);
  if (!s && !e) return "";
  if (!e || /^present$/i.test(String(end || "").trim())) return `${s || "—"} – Present`;
  return `${s} – ${e}`;
}
const ICON_GRAD_CAP =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12v5c0 1.1 2.7 2 6 2s6-.9 6-2v-5"/></svg>';
const ICON_BRIEFCASE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>';
// Same shape as client/src/components/Icons.jsx's IconUser — the "Profile"
// card title (14x14, matching ICON_BRIEFCASE/ICON_GRAD_CAP above).
const ICON_USER =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/></svg>';
// Profile-info card icons (.cd-field rows, profileDetailHtml below) — same
// shapes as the main BCD app's own Profile detail panel (IconCopy/IconMapPin
// in client/src/components/Icons.jsx; LinkedIn/GitHub paths match the
// header's own quick-copy row above), so the extension's Profile tab reads
// as the same component, not a re-interpretation of it. The copied-state
// checkmark comes from showCopiedCheck's own inline markup, not from here.
const ICON_COPY =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
// Same shapes as IconUser/IconMail/IconPhone (client/src/components/Icons.jsx)
// — Full Name/Email/Phone previously had no icon at all, unlike Location/
// LinkedIn/GitHub below.
const ICON_USER_SM =
  '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/></svg>';
const ICON_MAIL_SM =
  '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 7l8.5 6 8.5-6"/></svg>';
const ICON_PHONE_SM =
  '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 4h3l1.5 4-2 1.5a11 11 0 0 0 5 5l1.5-2 4 1.5v3a1.5 1.5 0 0 1-1.6 1.5A15 15 0 0 1 5 6.6 1.5 1.5 0 0 1 6.5 4z"/></svg>';
const ICON_MAPPIN_SM =
  '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>';
const ICON_LINKEDIN_SM =
  '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.94 8.5H3.56V20h3.38V8.5Zm.22-3.53c0-1.02-.77-1.84-1.91-1.84-1.14 0-1.91.82-1.91 1.84 0 1 .75 1.84 1.87 1.84h.02c1.16 0 1.93-.84 1.93-1.84ZM20.44 13.34c0-3.57-1.9-5.23-4.43-5.23-2.04 0-2.95 1.13-3.46 1.92V8.5H9.18c.04 1.01 0 11.5 0 11.5h3.37v-6.42c0-.34.02-.68.12-.92.27-.68.89-1.39 1.92-1.39 1.35 0 1.89 1.03 1.89 2.53V20h3.38v-6.66Z"/></svg>';
const ICON_GITHUB_SM =
  '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5A12 12 0 0 0 8.2 23.9c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.6-1.4-1.3-1.8-1.3-1.8-1.1-.8.1-.8.1-.8 1.2.1 1.8 1.2 1.8 1.2 1.1 1.9 2.9 1.3 3.6 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.8 0-1.3.5-2.4 1.2-3.3-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.4 11.4 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 2.9.1 3.2.8.9 1.2 2 1.2 3.3 0 4.5-2.7 5.5-5.3 5.8.4.3.8 1 .8 2v3c0 .3.2.7.8.6A12 12 0 0 0 12 .5Z"/></svg>';

// One .cd-field row (label [+ icon] / value / copy button) — same markup
// BCD's web app renders for its own Profile detail panel (Profiles.jsx),
// down to the class names, so panel.css's .cd-field rules style both
// identically. `opts.icon` prefixes the label; `opts.href` renders the
// value as a real link (LinkedIn/GitHub) instead of plain text. The copy
// button uses data-copy/data-copy-label — the SAME attributes
// #profileTabPanel's existing delegated click listener already reads (see
// wireEventListeners), so no new wiring is needed here.
function cdFieldRow(label, value, opts = {}) {
  const v = String(value || "").trim();
  const safeVal = escapeHtml(v);
  const valueHtml = opts.href && v
    ? `<a class="cd-field__value" href="${escapeHtml(normalizeUrl(v) || v)}" target="_blank" rel="noreferrer">${safeVal}</a>`
    : `<span class="cd-field__value">${safeVal}</span>`;
  return `
    <div class="cd-field">
      <span class="cd-field__label">${opts.icon || ""}${escapeHtml(label)}</span>
      ${valueHtml}
      <button type="button" class="cd-field__copy" title="${v ? `Copy ${escapeHtml(label)}` : ""}" ${
        v ? `data-copy="${safeVal}" data-copy-label="${escapeHtml(label)}"` : "disabled"
      }>${ICON_COPY}</button>
    </div>`;
}

// Profile tab's own dropdown + detail view (populateProfileTabSelect,
// chooseProfileTabView, renderProfileTabDetail) replaced the old FAQ-style
// accordion card list this used to build.

// A numbered entry: company name as the title, the role right below it
// ("N/A" when a profile has none set — same fallback as location already
// uses just below — in the usual muted grey; a real role is red, the same
// "you probably don't want this filled in" cue as the Role field itself in
// AddProfileModal.jsx), then location + date range sharing a row underneath.
function expEntryHtml(index, e) {
  const roleSet = !!(e.role || "").trim();
  return `
    <div class="cd-entry">
      <div class="cd-entry__title">${escapeHtml(e.company || "—")}<sup class="cd-entry__num">${index}</sup></div>
      <div class="cd-entry__sub${roleSet ? " cd-entry__sub--warn" : ""}">Role: ${escapeHtml(e.role || "N/A")}</div>
      <div class="cd-entry__row">
        <span>${escapeHtml(e.location || "N/A")}</span>
        <span>${escapeHtml(fmtSpan(e.start, e.end))}</span>
      </div>
    </div>`;
}

// A numbered entry: "Major" label above the degree title, then University
// and Year side by side below it (University stretches, Year stays its own
// tinted box) — matching the reference layout, unlike experience's single
// combined row.
function eduEntryHtml(index, e) {
  return `
    <div class="cd-entry">
      <span class="cd-entry__label">Major</span>
      <div class="cd-entry__title">${escapeHtml(e.degree || e.school || "—")}<sup class="cd-entry__num">${index}</sup></div>
      <div class="cd-entry__cols">
        <div class="cd-entry__col">
          <span class="cd-entry__flabel">University</span>
          <span class="cd-entry__fvalue">${escapeHtml(e.school || "—")}</span>
        </div>
        <div class="cd-entry__col cd-entry__col--year">
          <span class="cd-entry__flabel">Year</span>
          <span class="cd-entry__fvalue">${escapeHtml(fmtSpan(e.start, e.end) || "—")}</span>
        </div>
      </div>
    </div>`;
}

// Experience/Education for one profile, as the accordion detail panel's own
// innerHTML — same two .cd-card blocks the old separate detail page used.
function profileDetailHtml(p) {
  const eduRows = (p.education || []).map((e, i) => eduEntryHtml(i + 1, e)).join("");
  const expRows = (p.experience || []).map((e, i) => expEntryHtml(i + 1, e)).join("");
  return `
    <div class="cd-card">
      <div class="cd-card__title">${ICON_USER}Profile</div>
      ${cdFieldRow("Full Name", [p.firstName, p.lastName].filter(Boolean).join(" "), { icon: ICON_USER_SM })}
      ${cdFieldRow("Email", p.email, { icon: ICON_MAIL_SM })}
      ${cdFieldRow("Phone", p.phone, { icon: ICON_PHONE_SM })}
      ${cdFieldRow("Location", p.location, { icon: ICON_MAPPIN_SM })}
      ${cdFieldRow("Zip Code", p.zipCode, { icon: ICON_MAPPIN_SM })}
      ${cdFieldRow("LinkedIn", p.linkedin, { icon: ICON_LINKEDIN_SM, href: true })}
      ${cdFieldRow("GitHub", p.github, { icon: ICON_GITHUB_SM, href: true })}
    </div>
    <div class="cd-card">
      <div class="cd-card__title">${ICON_BRIEFCASE}Experience</div>
      ${expRows || '<p class="tab-panel-placeholder">No experience added.</p>'}
    </div>
    <div class="cd-card">
      <div class="cd-card__title">${ICON_GRAD_CAP}Education</div>
      ${eduRows || '<p class="tab-panel-placeholder">No education added.</p>'}
    </div>
  `;
}

// Plain-text rendering of STATE.info.resume (contact/experience/education —
// see generateController.js) for the Resume field: it's a structured
// object, not markdown like the cover letter, so this is a formatter, not
// a strip-down. Feeds both the collapsed preview textarea and Copy.
function formatResumeText(resume) {
  if (!resume) return "";
  const c = resume.contact || {};
  const lines = [];
  if (c.full_name) lines.push(c.full_name);
  // JD-aligned title line + summary — some granted prompts (Settings >
  // Tools' resume prompt) generate these; previously dropped here even
  // though the PDF/DOCX render them (see generateController.js).
  if (resume.headline_role) lines.push(resume.headline_role);
  const contactLine = [c.email, c.phone, c.location].filter(Boolean).join("  ·  ");
  if (contactLine) lines.push(contactLine);
  const linkLine = [c.linkedin, c.github].filter(Boolean).join("  ·  ");
  if (linkLine) lines.push(linkLine);
  if (resume.summary) lines.push("", resume.summary);

  const exp = resume.experience || [];
  if (exp.length) {
    lines.push("", "EXPERIENCE");
    for (const e of exp) {
      const head = [e.role, e.company].filter(Boolean).join(" — ");
      if (head) lines.push(head);
      const meta = [fmtSpan(e.start, e.end), e.location].filter(Boolean).join("  ·  ");
      if (meta) lines.push(meta);
      for (const b of e.bullets || []) lines.push("• " + b);
      if ((e.tools_and_tech || []).length) lines.push("Tools: " + e.tools_and_tech.join(", "));
      if (e.challenges_and_solutions) lines.push(e.challenges_and_solutions);
      lines.push("");
    }
  }

  const edu = resume.education || [];
  if (edu.length) {
    lines.push("EDUCATION");
    for (const e of edu) {
      const head = [e.degree, e.school].filter(Boolean).join(" — ");
      if (head) lines.push(head);
      const span = fmtSpan(e.start, e.end);
      if (span) lines.push(span);
      lines.push("");
    }
  }

  const certs = resume.certifications || [];
  if (certs.length) {
    lines.push("CERTIFICATIONS");
    for (const cert of certs) {
      if (typeof cert === "string") {
        lines.push("• " + cert);
        continue;
      }
      const name = String(cert?.name || "").trim();
      if (!name) continue;
      const date = String(cert?.date || "").trim();
      lines.push(`• ${name}${date ? ` (${date})` : ""}`);
    }
    lines.push("");
  }

  const groups = (resume.skill_groups || []).filter((g) => (g.skills || []).length);
  if (groups.length) {
    lines.push("SKILLS");
    for (const g of groups) {
      lines.push(g.category && groups.length > 1 ? `${g.category}: ${g.skills.join(", ")}` : g.skills.join(", "));
    }
  }

  return lines.join("\n").trim();
}

async function refreshAuthUI() {
  const token = await getToken();
  const email = await getAuthValue(STORAGE.email);
  const name = await getAuthValue(STORAGE.name);
  const { [STORAGE.avatar]: avatar } = await chrome.storage.local.get(STORAGE.avatar);
  const label = name || email || "";
  if (els.userLabel) {
    els.userLabel.textContent = label;
    els.userLabel.title = email || label;
  }
  if (els.userMenuName) els.userMenuName.textContent = label;
  if (els.userMenuEmail) els.userMenuEmail.textContent = email || "";
  // Show the cached photo immediately; refreshCapabilities() will refresh it
  // from whoami right after and repaint if it changed.
  renderUserAvatar(avatar || null, label);
  setProfileSelectDisabled(!token);
  els.jobText.disabled = !token;
  if (els.companyName) els.companyName.disabled = !token;
  if (els.roleTitle) els.roleTitle.disabled = !token;
  refreshProfileLinksUI();
  await updateLoginGate();
  void syncHeartbeat();
}

const TONE_LABELS = { formal: "Formal", balanced: "Balanced", direct: "Direct", casual: "Casual" };

// Tone is chosen on the server from the job description — the panel only
// shows which one was used (read-only; no user selection).
function updateToneDisplay(tone) {
  if (!els.genToneDisplay) return;
  const label = TONE_LABELS[tone];
  if (label) {
    els.genToneDisplay.textContent = label;
    els.genToneDisplay.classList.add("set");
  } else {
    els.genToneDisplay.textContent = "Tone — chosen automatically from the job description";
    els.genToneDisplay.classList.remove("set");
  }
}

/**
 * Drops any generation (resume/cover letter, Auto-fill's check-mark, Q&A)
 * tied to the PREVIOUS job — so the panel doesn't keep showing "Generated
 * successfully" / Download / Auto-fill for a job that was never actually
 * generated for. Used both when Detect lands on a different job than what's
 * on screen, and when the user clicks Update after hand-editing company /
 * role / JD (that's now a different application).
 */
async function clearGeneratedWork() {
  await savePatch(TAB_ID, {
    generatingStatus: null,
    info: null,
    files: [],
    generationId: null,
    qa: [],
    genError: null,
    cvSavedToFolder: false,
    cvSavedFolderRev: 0,
  });
  // We may run mid-detection, so we avoid a full applyStateToUI (which would
  // re-fill fields and clobber whatever the caller is doing) — disabling the
  // now-stale generated UI directly instead. STATE.info was just nulled
  // above (savePatch updates the global STATE synchronously for the current
  // tab), so refreshResumeCoverActions alone disables the Resume/Cover
  // Letter actions and drops their check-marks. Auto-fill's own check-mark
  // is for the PREVIOUS job's fill, so it goes stale too. Generate's and
  // Auto-fill's own gradient progress fills are separate DOM state from all
  // of the above (a clip-path left over from the last run) and don't reset
  // on their own just because STATE.info/generationId went null — same
  // reset stopAutofillProgress already does for an aborted/failed run, and
  // setGenProgress(0) does for Generate's own fill.
  setGenProgress(0);
  stopAutofillProgress();
  els.qaSection?.classList.add("hidden");
  if (els.askBtn) els.askBtn.disabled = true;
  if (els.qaInput) els.qaInput.disabled = true;
  refreshResumeCoverActions();
  syncMarkAppliedRow();
  AUTOFILL_DONE_TABS.delete(TAB_ID);
  RESUME_UPLOADED_TABS.delete(TAB_ID);
  updateToneDisplay(null);
  renderQA(TAB_ID);
}

/**
 * Show the "Update" row only when there IS a saved application for this tab
 * AND the company / role / JD on screen differ from what that application
 * holds — so the button always has something to push. STATE.appCompany /
 * appRole / appJobText track the saved values, seeded wherever a generation
 * is created or hydrated.
 */
function refreshRenameRow() {
  if (!els.updateAppBtn) return;
  const company = els.companyName?.value?.trim() || "";
  const role = els.roleTitle?.value?.trim() || "";
  const jobText = els.jobText?.value || "";
  const changed =
    company !== (STATE?.appCompany || "") ||
    role !== (STATE?.appRole || "") ||
    jobText !== (STATE?.appJobText || "");
  const show = !!STATE?.generationId && (!!company || !!role || !!jobText) && changed;
  els.updateAppBtn.classList.toggle("hidden", !show);
}

/** The profile id a tab should default to: its own persisted choice, else
 *  the starred profile (see STARRED_PROFILE_ID/toggleStarredProfile) — not
 *  whichever profile happened to be picked most recently in some OTHER tab.
 *  A tab explicitly picking its own profile, or another tab's pick, must
 *  never bleed into a DIFFERENT tab; only a brand-new tab that has never had
 *  a choice of its own falls back at all. That fallback is committed into
 *  THIS tab's own state right here (once PROFILE_OPTIONS confirms it's
 *  actually a valid profile) — so the tab locks onto it permanently, and a
 *  later change to which profile is starred only affects tabs that haven't
 *  defaulted yet, never one that already has. Without that write, a tab that
 *  never got an explicit choice of its own would silently keep re-deriving
 *  "whichever profile is starred right now" forever, which would look
 *  exactly like every un-chosen tab tracking a live star change. */
async function defaultSelectedProfileId() {
  if (STATE?.selectedProfileId) return STATE.selectedProfileId;
  const fallback = STARRED_PROFILE_ID;
  if (!fallback) return "";
  // savePatch itself re-syncs STATE from the merged server state once this
  // resolves — no need to also set it here.
  if (TAB_ID && PROFILE_OPTIONS.some((p) => p.id === fallback)) {
    await savePatch(TAB_ID, { selectedProfileId: fallback });
  }
  return fallback;
}

/** Enable/populate the Resume + Cover Letter View/Copy/Download buttons and
 *  their (hidden, modal-only) textareas from the CURRENT global STATE. Reads
 *  live globals (STATE, isDownloadingCover) rather than taking params so it
 *  can be called both from applyStateToUI (tab switch / panel reopen) and
 *  right after a generation finishes — a fresh generation updates STATE.info
 *  via savePatch but doesn't otherwise re-run applyStateToUI, so without this
 *  second call site these buttons stayed disabled/stale until the user next
 *  switched tabs. */
function refreshResumeCoverActions() {
  const hasCover = !!STATE?.info?.cover_letter;
  if (els.viewCoverBtn) els.viewCoverBtn.disabled = !hasCover;
  if (els.copyCoverBtn) els.copyCoverBtn.disabled = !hasCover;
  if (els.downloadCoverPdfBtn) els.downloadCoverPdfBtn.disabled = !hasCover || isDownloadingCover;
  if (els.coverText) {
    els.coverText.disabled = !hasCover;
    els.coverText.value = STATE?.info?.cover_letter || "";
  }
  if (!hasCover) collapseCoverLetter();
  els.coverSectionHead?.classList.toggle("done", hasCover);

  const hasResume = !!STATE?.info?.resume;
  if (els.viewResumeBtn) els.viewResumeBtn.disabled = !hasResume;
  if (els.copyResumeBtn) els.copyResumeBtn.disabled = !hasResume;
  if (els.downloadResumeBtn) els.downloadResumeBtn.disabled = !hasResume;
  if (els.resumeText) {
    els.resumeText.disabled = !hasResume;
    els.resumeText.value = hasResume ? formatResumeText(STATE.info.resume) : "";
  }
  if (!hasResume) collapseResume();
  els.resumeSectionHead?.classList.toggle("done", hasResume);
}

async function applyStateToUI(tabId, state) {
  STATE = state || null;
  populateProfiles(els.profileSelect, await defaultSelectedProfileId(), chooseProfile);
  if (els.companyName) els.companyName.value = STATE?.companyName || "";
  if (els.roleTitle) els.roleTitle.value = STATE?.roleTitle || "";
  els.jobText.value = STATE?.jobText || "";
  // Job metadata (location/salary/posted/etc.) is per-tab state too, same
  // as the three fields above — renderJobMeta(null) hides every row when
  // this tab never had a detection (or never detected a job at all).
  renderJobMeta(STATE?.jobMeta || null);

  // The follow-up question box is a single DOM element shared by every tab, so
  // it MUST be restored from THIS tab's persisted draft on every load —
  // otherwise a question typed on one tab stays visible on the others. Also
  // clear the in-flight lock/spinner: an Ask still running on another tab must
  // never leave this tab's box read-only or its button spinning (the owning
  // tab's own handler re-applies them when it's the active tab).
  if (els.qaInput) {
    els.qaInput.value = STATE?.qaDraft || "";
    els.qaInput.readOnly = false;
  }
  els.askBtn?.classList.remove("is-loading");

  // Restore the per-tab autofill status banner (or hide it if this
  // tab never ran Auto-fill). We assign to the DOM directly instead
  // of calling setAutofillStatus, because the latter re-saves to
  // STATE and would re-trigger the same patch we just loaded.
  if (els.autofillStatus) {
    const a = STATE?.autofillStatus;
    if (a && a.msg) {
      // A persisted "loading" step is in-progress chatter that lives on the
      // page as a toast — restore its text but keep the panel box hidden.
      const lvl = a.type || "idle";
      els.autofillStatus.textContent = a.msg;
      els.autofillStatus.className =
        "status-box autofill-status " + lvl + (lvl === "loading" ? " hidden" : "");
      els.autofillStatus.dataset.level = lvl;
      if (lvl !== "loading") els.autofillStatus.classList.remove("hidden");
    } else {
      els.autofillStatus.classList.add("hidden");
      els.autofillStatus.textContent = "";
      delete els.autofillStatus.dataset.level;
    }
  }

  // Tone is decided server-side from the job description — just show which
  // one the last generation used (read-only).
  updateToneDisplay(STATE?.info?.job_data?.recommended_tone || null);

  const tok = await getToken();
  const genStatus = STATE?.generatingStatus;
  els.generateBtn.disabled = !tok || genStatus === "generating" || !generateGateOk();
  setButtonText(els.generateBtn, generateBtnLabel(genStatus));
  renderKeyChip(els.generateHotkey, genStatus === "generating" ? "" : HOTKEY_GENERATE);

  // Progress bar is per-tab. The panel DOM is shared across tabs, so we MUST
  // derive the bar from THIS tab's state on every render (tab switch / state
  // load) — otherwise one tab's in-flight generation leaks into others.
  if (genStatus === "generating") {
    startGenerationProgress(tabId); // resumes from STATE.generatingStartedAt
  } else if (genStatus === "generated") {
    // A completed run's fill must stay at 100% across tab switches / panel
    // reopens too — passing no opts here (like the plain non-generating
    // case below) reads as "non-success" and was wiping it back to white
    // on every re-render, not just the run's own end.
    stopGenerationProgress({ success: true });
  } else {
    stopGenerationProgress(); // hide immediately for idle/error tabs
  }

  if (STATE?.generatingStatus === "generated") {
    els.qaSection.classList.remove("hidden");
    els.askBtn.disabled = false;
    if (els.qaInput) els.qaInput.disabled = false;
  } else {
    els.qaSection.classList.add("hidden");
    els.askBtn.disabled = !tok || STATE?.generatingStatus !== "generated";
    if (els.qaInput) els.qaInput.disabled = els.askBtn.disabled;
  }

  // Download CV always reads as enabled/clickable now (downloadGeneratedCv
  // itself already handles "no CV yet" with a friendly status message
  // instead of needing the button disabled to prevent it).
  setProfileSelectDisabled(!tok);
  els.jobText.disabled = !tok;
  if (els.companyName) els.companyName.disabled = !tok;
  if (els.roleTitle) els.roleTitle.disabled = !tok;

  // Job Description's own Copy/Download — same hasX-gated pattern as Cover
  // Letter/Resume below, keyed off the textarea's own content rather than a
  // separate STATE flag (there isn't one — JD is user-typed/auto-detected,
  // not something "generated").
  const hasJd = !!(STATE?.jobText || "").trim();
  if (els.copyJdBtn) els.copyJdBtn.disabled = !hasJd;
  if (els.downloadJdBtn) els.downloadJdBtn.disabled = !hasJd || isDownloadingJd;

  // Cover Letter + Resume View/Copy/Download buttons and their (hidden,
  // modal-only) textareas — see refreshResumeCoverActions, also called
  // right after a generation finishes so these don't wait for a tab switch.
  refreshResumeCoverActions();
  syncMarkAppliedRow();

  // Pull the profile's contact details (LinkedIn / GitHub / address / phone)
  // from the DB whenever this tab's state is applied (panel reopen, tab switch).
  // Use selectedProfileId() rather than STATE.selectedProfileId: on a fresh tab
  // nothing is persisted yet, but populateProfiles above has already defaulted
  // the dropdown to the first profile, so the copy buttons should light up for
  // that default without waiting for the user to open the dropdown. Cached
  // after first fetch.
  fetchProfileLinks(selectedProfileId());

  renderQA(tabId);

  await refreshAuthUI();
  // Re-syncs the API Key preview (Auto mode) / ChatGPT URL field (Manual
  // mode) too — initResumeModeToggle's own first call to this happens from
  // a chrome.storage.local.get callback at panel start, which can land
  // BEFORE the stored token is confirmed valid; refreshApiKeyPreview's own
  // apiFetch would 401 at that point and never get a second chance, stuck
  // showing "No key assigned" even once actually signed in. loadForTab
  // re-runs on every panel open/tab switch, well after auth settles.
  syncResumeModeUI();

  // Derive status from persisted state so it survives tab switches. (Only claims
  // "Generated successfully" when the JD is still present — a restored/hydrated
  // or cleared generation falls back to the neutral default.)
  applyRestingStatus(tabId);
  refreshRenameRow();
}

// Bumped on every loadForTab so a slow state fetch for a tab the user has
// already switched away from can't paint over the current tab's UI.
let LOAD_SEQ = 0;

async function loadForTab(tabId) {
  if (!tabId) return;
  const seq = ++LOAD_SEQ;
  // Every modal/expanded overlay this panel can have open — the job-fit
  // warning, the JD/Cover Letter/Resume field modal, the Tabsync "mark as
  // applied" confirm, the expanded Ask Anything overlay, and the "already
  // applied" gate — is scoped to whatever tab was on screen when it opened.
  // A switch to a DIFFERENT browser tab only HIDES it (the content
  // underneath — job description, profile, thread — is about to change out
  // from under it, so leaving it painted just blocks the panel over a job
  // the user isn't even looking at any more) — it does NOT close/forget it.
  // Switching back to this exact tab restores it below, so from the user's
  // side it just stays open the whole time; only an explicit dismissal
  // (Continue/back/backdrop-click) actually closes it for good.
  if (TAB_ID !== tabId) {
    hideFitWarningModal();
    hideFieldModalForTabSwitch();
    hideTabsyncAppliedConfirm();
    hideQAForTabSwitch();
    hideDupWarningModal();
    hideAutoApplyNotices();
  }
  TAB_ID = tabId;
  // Repaint whatever this tab still has pending from before the user
  // switched away — the plain re-render ones can happen immediately here;
  // the ones that need this tab's content already loaded/laid out (the
  // field modal, the Ask Anything overlay) happen further below, after
  // applyStateToUI.
  if (FIT_WARNING_OPEN.has(tabId)) renderFitWarningModal(tabId);
  if (TABSYNC_CONFIRM_OPEN.has(tabId)) renderTabsyncAppliedConfirm(tabId);
  // Generate on this tab may still be waiting on an "already applied" gate
  // from before the user switched away — repaint it now that it's back on
  // screen (see openDupWarningModal/hideDupWarningModal).
  if (DUP_WARNING_PENDING.has(tabId)) renderDupWarningModal(tabId);
  // Auto Apply's own last result/summary for this tab, if any — see
  // autoApplyNotice/AUTO_APPLY_SLOTS.
  if (AUTO_APPLY_SLOTS.result.byTab.has(tabId)) renderAutoApplyNotice("result", tabId);
  if (AUTO_APPLY_SLOTS.summary.byTab.has(tabId)) renderAutoApplyNotice("summary", tabId);
  try {
    const state = await fetchState(tabId);
    if (seq !== LOAD_SEQ) return; // a newer tab load won the race
    await applyStateToUI(tabId, state);
    // Restore whichever main tab (Apply/Profile/Settings/Tabsync) — and, via
    // switchToTab's own body, whichever Settings/Tabsync sub-tab — this
    // Chrome tab was last showing. Placed after applyStateToUI so a restore
    // into Profile reads THIS tab's just-reloaded profile selection, not the
    // previous tab's; placed before the modal/overlay restores below so
    // their layout math (expandQA's getBoundingClientRect in particular)
    // runs against the section that's actually visible.
    switchToTab(MAIN_TAB_FOR.get(tabId) || "apply");
    reopenFieldModalIfPending(tabId);
    reopenQAIfPending(tabId);
    // The button belongs to the tab now on screen — a run still going in
    // another tab must not leave it stuck disabled here (or vice versa).
    syncAutofillButtons();
    // This tab's own form count — see refreshAutofillButtonTitle's own
    // comment on why this is a separate, lighter scan from the review
    // modal's.
    refreshAutofillButtonTitle();
    // The Auto-fill button's own fill is one shared DOM node too — for a
    // tab with no run in flight, restore it from AUTOFILL_DONE_TABS: a tab
    // whose last run succeeded keeps its 100% "done" fill across a tab
    // switch (was unconditionally wiped back to white here, even for a
    // just-completed successful run — that's the bug); anything else
    // (never run, or last run failed) resets to white, same as before.
    // (runAutofill's own start/finally control it while the visible tab IS
    // the one running.)
    if (els.autofillProgressFill && !RUNNING_TABS.has(tabId)) {
      els.autofillProgressFill.style.clipPath = AUTOFILL_DONE_TABS.has(tabId)
        ? "inset(0 0 0 0)"
        : "inset(0 100% 0 0)";
    }
    // Auto-detect this tab (executeScript pull) — covers opening the panel on
    // an already-loaded job page and switching to a job tab.
    scheduleAutoDetect(150);
  } catch (e) {
    if (seq !== LOAD_SEQ) return;
    setStatus(tabId, "Failed to load tab " + tabId + ": " + e.message, "error");
  }
}

// Settings tab > File Names — the downloaded file's own name (not the
// destination folder, see downloadFolderHint above), as a token template:
// {first_name}/{last_name}/{profile}/{company}/{role}. The file extension is
// added separately by each download call site (buildFilenameFromTemplate
// below), never part of the template itself. Resume defaults to the
// candidate's own name ({first_name} {last_name}, from the profile's resume
// fields) rather than {profile} (the profile's internal org-facing label,
// e.g. "Bidder 3") — a downloaded resume should read like the candidate's
// real name.
const FILENAME_RESUME_KEY = "ab_filename_resume";
const FILENAME_COVER_KEY = "ab_filename_cover";
const FILENAME_JD_KEY = "ab_filename_jd";
const DEFAULT_FILENAME_RESUME = "{first_name} {last_name}";
const DEFAULT_FILENAME_COVER = "{company}-{role} (Cover Letter)";
const DEFAULT_FILENAME_JD = "{company}-{role} (Job Description)";
let FILENAME_RESUME = DEFAULT_FILENAME_RESUME;
let FILENAME_COVER = DEFAULT_FILENAME_COVER;
let FILENAME_JD = DEFAULT_FILENAME_JD;

// "auto" (today's flow — call OpenAI with the built params) or "manual"
// (send the same prompt/profile/JD to a live ChatGPT tab instead, and read
// its reply back as the resume JSON — see runManualGenerate below).
let RESUME_MODE = "auto";

// The exact ChatGPT chat Manual mode opens for every Generate — a specific
// conversation (chatgpt.com/c/…) or a custom GPT/Project entry point
// (chatgpt.com/g/…), pasted by the user into the Job tab's own
// #manualChatGptUrlRow (Manual mode only, right above Generate).
// Required in Manual mode (see generateGateOk) since there's no "just use
// whichever ChatGPT tab is open" fallback any more — openFreshBananaChatGptTab
// always opens a brand new tab and needs somewhere to point it.
let MANUAL_CHATGPT_URL = "";

// BANANA_CHATGPT_TAB_URL_RE is declared further down (next to the other
// Manual-mode ChatGPT-tab helpers) — fine to reference here since this is a
// function body, only evaluated on calls made after the whole module has
// finished its top-level run.
function isValidManualChatGptUrl(url) {
  return BANANA_CHATGPT_TAB_URL_RE.test(String(url || "").trim());
}

// Used to gate every place that decides els.generateBtn.disabled. Pro,
// Free and Manual mode are all unconditional here now — Manual mode's own
// missing/invalid ChatGPT URL used to disable the button outright,
// silently, with no feedback beyond a hover-only tooltip (confirmed real
// complaint, same shape as markAsApplied's own "Generate a resume first"
// fix below) — Generate now always stays clickable and the click handler
// itself toasts "Set a ChatGPT link first" when Manual mode isn't ready
// yet. Free mode used to be blocked outright here (it had no generation
// path at all) — it now resolves User.freeApiKeyId server-side exactly
// the way Pro resolves apiKeyId (see currentKeySelection below + the
// server's resolveApiKey), so it's just as "always clickable, server
// catches a missing key" as Pro already was.
function generateGateOk() {
  return true;
}

// "auto" (Pro, User.apiKeyId) or "free" (Free, User.freeApiKeyId) — the
// two independent key slots a member can be assigned (BCD web app's
// Contacts.jsx Role tab). Manual mode has no key of its own; callers of
// this only ever run while the API Key row is visible, which is already
// gated to auto/free (see syncResumeModeUI).
function apiKeyModeOf(resumeMode) {
  return resumeMode === "free" ? "free" : "pro";
}

// Per-mode "which key in the pool is selected" — only meaningful once a
// mode's resolved entry turns out to be a Group (see refreshApiKeyPreview/
// renderApiKeyGroupUI). Persisted per mode so Pro and Free each remember
// their own pick independently, and across panel reloads.
const API_KEY_GROUP = {
  pro: { isGroup: false, keyCount: 0, keyPreviews: [], index: 0 },
  free: { isGroup: false, keyCount: 0, keyPreviews: [], index: 0 },
};
async function loadApiKeyIndex(mode) {
  const storeKey = mode === "free" ? STORAGE.apiKeyIndexFree : STORAGE.apiKeyIndexPro;
  const got = await chrome.storage.local.get(storeKey);
  const n = got?.[storeKey];
  return Number.isInteger(n) && n >= 0 ? n : 0;
}
function saveApiKeyIndex(mode, index) {
  const storeKey = mode === "free" ? STORAGE.apiKeyIndexFree : STORAGE.apiKeyIndexPro;
  chrome.storage.local.set({ [storeKey]: index });
}

// What the next Generate/Ask call should actually send — spread straight
// into the /full-generate-and-download and /answer-questions request
// bodies (see those call sites). `keyIndex` only matters server-side when
// the resolved entry is a Group; harmless to always send it.
function currentKeySelection() {
  const mode = apiKeyModeOf(RESUME_MODE);
  return { mode, keyIndex: API_KEY_GROUP[mode].index };
}

// Re-applies generateGateOk (plus the token/generating checks every other
// Generate-disabled call site already does) right away — so typing/pasting
// a valid ChatGPT URL into the Manual-mode field enables Generate the moment
// it's valid, not just at the next unrelated re-render.
async function refreshGenerateDisabled() {
  if (!els.generateBtn) return;
  const tok = await getToken();
  const genStatus = STATE?.generatingStatus;
  els.generateBtn.disabled = !tok || genStatus === "generating" || !generateGateOk();
}

function syncResumeModeUI() {
  // Generate/Auto-fill's own numbered badge (1/2) recolors per mode — see
  // body[data-resume-mode] in panel.css. A data attribute instead of a
  // toggled class since it's one of exactly three values, never more than
  // one true at once — simpler than three separate booleans to keep in
  // sync.
  document.body.dataset.resumeMode = RESUME_MODE;
  if (els.resumeModeToggle) {
    els.resumeModeToggle.querySelectorAll("[data-mode]").forEach((btn) => {
      const on = btn.dataset.mode === RESUME_MODE;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-checked", String(on));
    });
  }
  if (els.detectJobBtn) setButtonText(els.detectJobBtn, "Auto Detect");
  updateManualChatGptStatusBox();
  syncManualChatGptUrlUI();
  // "auto" (Pro) and "free" both show the key row — only "manual" (ChatGPT)
  // has no key of its own to check.
  const showApiKeyRow = RESUME_MODE === "auto" || RESUME_MODE === "free";
  els.apiKeyCheckRow?.classList.toggle("hidden", !showApiKeyRow);
  if (showApiKeyRow) refreshApiKeyPreview();
}

// Shows/hides the ChatGPT URL field (Manual mode only) and reflects whether
// MANUAL_CHATGPT_URL currently holds something Generate will accept (same
// check generateGateOk runs) — a red border instead of letting a bad paste
// silently do nothing when Generate is clicked. No separate hint text any
// more (see the API Key row's own checkMyApiKey for the same "pass/fail
// only, no message" call on the Auto-mode side of this toggle).
function syncManualChatGptUrlUI() {
  els.manualChatGptUrlRow?.classList.toggle("hidden", RESUME_MODE !== "manual");
  if (els.manualChatGptUrlInput && els.manualChatGptUrlInput.value !== MANUAL_CHATGPT_URL) {
    els.manualChatGptUrlInput.value = MANUAL_CHATGPT_URL;
  }
  const empty = !MANUAL_CHATGPT_URL.trim();
  const ok = empty || isValidManualChatGptUrl(MANUAL_CHATGPT_URL);
  els.manualChatGptUrlInput?.classList.toggle("input-invalid", !ok);
}

// Pro/Free mode's own "what key will my next Generate actually use"
// display — the masked preview of whatever resolveApiKey would resolve for
// the CURRENT mode (own apiKeyId/freeApiKeyId → org vault entry, else the
// org's granted platform key), same resolution test-mine itself uses but
// without testing it — see getMyApiKeyPreview. Called whenever the row
// comes into view (syncResumeModeUI) or the mode toggle switches between
// Pro/Free, not just once at load, since either assignment can change from
// the Member page's own Role tab while the panel is open. For a Group
// entry this also pulls every key's own preview + restores this mode's
// last-picked index, so the </> row (renderApiKeyGroupUI) comes up already
// on the right slot instead of resetting to #1 every time.
// initResumeModeToggle fires this twice in quick succession on a fresh
// panel open — once from its own chrome.storage.local.get callback
// (before the stored token is confirmed valid, see its comment) and again
// from loadForTab once auth has actually settled. Those two async calls
// can resolve out of order: the early one 401s and lands on "No key
// assigned" with no spinner at all, and if it happens to finish AFTER the
// later (correct) one, it silently clobbers the right result back to
// nothing — exactly the "first open doesn't show the circle" bug. This
// sequence number makes only the LATEST call's result ever get applied,
// regardless of which one's apiFetch actually resolves first.
let API_KEY_PREVIEW_SEQ = 0;
async function refreshApiKeyPreview() {
  if (!els.apiKeyPreviewText) return;
  const mode = apiKeyModeOf(RESUME_MODE);
  const seq = ++API_KEY_PREVIEW_SEQ;
  const profileId = selectedProfileId();
  try {
    if (!profileId) {
      if (seq !== API_KEY_PREVIEW_SEQ) return;
      API_KEY_GROUP[mode] = { isGroup: false, keyCount: 0, keyPreviews: [], index: 0 };
      els.apiKeyPreviewText.textContent = "No key assigned";
      els.apiKeyPreviewText.classList.add("chatgpt-url-field__value--empty");
      renderApiKeyGroupUI(mode);
      maybeAutoTestApiKey(mode);
      return;
    }
    const r = await apiFetch(
      `/api-keys/mine?mode=${encodeURIComponent(mode)}&profileId=${encodeURIComponent(profileId)}`,
    );
    if (seq !== API_KEY_PREVIEW_SEQ) return; // a newer call already started — don't clobber it
    const isGroup = !!r?.isGroup;
    const keyPreviews = isGroup && Array.isArray(r.keyPreviews) ? r.keyPreviews : [];
    const savedIndex = isGroup ? await loadApiKeyIndex(mode) : 0;
    if (seq !== API_KEY_PREVIEW_SEQ) return; // same guard, re-checked after the extra await above
    API_KEY_GROUP[mode] = {
      isGroup,
      keyCount: r?.keyCount || 0,
      keyPreviews,
      index: keyPreviews.length ? savedIndex % keyPreviews.length : 0,
    };
    if (!r?.keyPreview) {
      els.apiKeyPreviewText.textContent = "No key assigned";
      els.apiKeyPreviewText.classList.add("chatgpt-url-field__value--empty");
    } else {
      els.apiKeyPreviewText.textContent = r.keyPreview;
      els.apiKeyPreviewText.classList.remove("chatgpt-url-field__value--empty");
    }
  } catch {
    if (seq !== API_KEY_PREVIEW_SEQ) return;
    API_KEY_GROUP[mode] = { isGroup: false, keyCount: 0, keyPreviews: [], index: 0 };
    els.apiKeyPreviewText.textContent = "No key assigned";
    els.apiKeyPreviewText.classList.add("chatgpt-url-field__value--empty");
  }
  renderApiKeyGroupUI(mode);
  maybeAutoTestApiKey(mode);
}

// Auto-tests ONLY when the resolved key is genuinely new for this mode —
// first sign-in (nothing recorded yet) or an actual change (switching
// Pro/Free lands on a different key, or cycleApiKey below picks a
// different slot in a Group). refreshApiKeyPreview also re-runs on every
// plain tab switch (loadForTab) with the SAME key as before — that's not a
// change, so this intentionally does nothing then: whatever check/X is
// already showing just stays put instead of re-testing (or worse,
// flickering) on every tab switch.
const API_KEY_LAST_TESTED = { pro: null, free: null };
function maybeAutoTestApiKey(mode) {
  if (!hasApiKeyAssigned()) {
    API_KEY_LAST_TESTED[mode] = null;
    els.apiKeyTestResult?.classList.add("hidden");
    return;
  }
  const current = els.apiKeyPreviewText.textContent;
  if (API_KEY_LAST_TESTED[mode] === current) return; // unchanged since last test — leave it alone
  API_KEY_LAST_TESTED[mode] = current;
  checkMyApiKey();
}

// Renders the current mode's API_KEY_GROUP state: the </> nav (hidden for
// a single key, shown with "N/total" for a Group) and the preview text for
// whichever slot is currently selected. Pure render, no fetch — cycling
// (cycleApiKey below) just updates the index and calls this again against
// the already-fetched keyPreviews.
function renderApiKeyGroupUI(mode) {
  const g = API_KEY_GROUP[mode];
  const show = g.isGroup && g.keyPreviews.length > 1;
  els.apiKeyGroupNav?.classList.toggle("hidden", !show);
  if (show && els.apiKeyGroupIndex) {
    els.apiKeyGroupIndex.textContent = `${g.index + 1}/${g.keyPreviews.length}`;
  }
  // A Group's own per-slot preview overrides the plain keyPreview text
  // once we know which slot is selected — same masked-key format either
  // way (see apiKeyController's keyPreview), just scoped to one of the N.
  if (g.isGroup && g.keyPreviews.length && els.apiKeyPreviewText) {
    els.apiKeyPreviewText.textContent = g.keyPreviews[g.index] || "No key assigned";
    els.apiKeyPreviewText.classList.toggle("chatgpt-url-field__value--empty", !g.keyPreviews[g.index]);
  }
}

// </> button handlers — wraps around both ends (Previous past #1 goes to
// the last key, Next past the last wraps to #1), matching how a cyclic
// pool is actually used (there's no "first"/"last" that matters more than
// any other slot). Persisted immediately so the pick survives a panel
// reload. Picking a different key is itself the "key changed" event this
// row's whole point is to surface — toasted, and re-tested automatically
// right away rather than leaving a stale pass/fail (or nothing at all)
// sitting next to a key that's no longer the one that'll actually be used.
function cycleApiKey(direction) {
  const mode = apiKeyModeOf(RESUME_MODE);
  const g = API_KEY_GROUP[mode];
  if (!g.isGroup || g.keyPreviews.length < 2) return;
  g.index = (g.index + direction + g.keyPreviews.length) % g.keyPreviews.length;
  saveApiKeyIndex(mode, g.index);
  renderApiKeyGroupUI(mode);
  panelToast("API key changed", "success");
  // Always resolves to an actual test (not a no-op) — renderApiKeyGroupUI
  // just set the preview text to the newly-selected slot, which by
  // definition differs from whatever maybeAutoTestApiKey last recorded.
  maybeAutoTestApiKey(mode);
}

const KEY_TEST_ICONS = {
  ok: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>',
  error: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>',
  // A 3/4-circle arc — panel.css's .key-test-result--testing spins it via
  // the same @keyframes spin every other loading glyph in this panel uses
  // (.detect-pill's own refresh icon, Auto Apply's running pill, etc).
  testing: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9" /></svg>',
};
let API_KEY_TESTING = false;

// Auto/Free mode's own pre-flight check — "is the key resolveApiKey would
// actually use for my next Generate currently working" — same question the
// Manual-mode URL field answers for ITS own Generate-time dependency.
// Mirrors the BCD web app's own "Test connect" (TestConnectButton.jsx).
// Runs automatically whenever the resolved key changes (mode switch,
// picking a different key in a Group — see refreshApiKeyPreview/
// cycleApiKey) as well as on a manual click of the key icon/preview text —
// the result (spinner while running, then a green check / red X) always
// stays visible once there's a key to test, never just blank waiting for a
// click.
async function checkMyApiKey() {
  if (API_KEY_TESTING) return;
  API_KEY_TESTING = true;
  if (els.apiKeyTestResult) {
    els.apiKeyTestResult.innerHTML = KEY_TEST_ICONS.testing;
    els.apiKeyTestResult.className = "key-test-result key-test-result--testing";
  }
  let ok = false;
  try {
    const { mode, keyIndex } = currentKeySelection();
    const profileId = selectedProfileId();
    if (!profileId) {
      ok = false;
    } else {
      const r = await apiFetch(
        `/api-keys/test-mine?mode=${encodeURIComponent(mode)}&keyIndex=${keyIndex}&profileId=${encodeURIComponent(profileId)}`,
        {
          method: "POST",
          body: JSON.stringify({ mode, keyIndex, profileId }),
        },
      );
      ok = !!r?.ok;
    }
  } catch {
    ok = false;
  }
  API_KEY_TESTING = false;
  if (els.apiKeyTestResult) {
    els.apiKeyTestResult.innerHTML = KEY_TEST_ICONS[ok ? "ok" : "error"];
    els.apiKeyTestResult.className = "key-test-result key-test-result--" + (ok ? "ok" : "error");
  }
}

// Whether the API Key row currently has anything to test — mirrors
// whatever refreshApiKeyPreview/renderApiKeyGroupUI just put in
// apiKeyPreviewText (the empty-state class is the one source of truth
// already driving "No key assigned" styling there).
function hasApiKeyAssigned() {
  return !els.apiKeyPreviewText?.classList.contains("chatgpt-url-field__value--empty");
}

// Icon click or Enter in the input — open MANUAL_CHATGPT_URL when it's a
// valid chatgpt.com conversation URL, otherwise just open chatgpt.com
// itself (empty/garbage input used to make the old Open button silently do
// nothing — this is never a dead end now).
function openManualChatGptUrl() {
  const url = MANUAL_CHATGPT_URL.trim();
  chrome.tabs.create({ url: isValidManualChatGptUrl(url) ? url : "https://chatgpt.com" });
}

// Used to live in Auto Apply's own slot (Job Details' section-head, above
// the JD textarea), swapped in for it in Manual mode — back when Manual
// mode could only ever run ONE job at a time against a single shared
// ChatGPT tab, Auto Apply (which fires Generate across every open tab at
// once) genuinely made no sense there, so Manual mode swapped it out for
// this connection-status readout, same slot. Now that runManualGenerate
// opens its OWN fresh, disposable ChatGPT tab per run
// (openFreshBananaChatGptTab), several jobs really can generate
// concurrently in Manual mode too — Auto Apply stays visible in both
// modes now (same slot it's always had, no swap needed any more), and
// this status box has nothing left to explain (Generate was the only
// thing it ever gated, see generateGateOk's own comment on that no longer
// applying), so it just always stays hidden now instead of trying to
// share the row with Auto Apply.
function updateManualChatGptStatusBox() {
  els.manualChatGptStatus?.classList.add("hidden");
}

// Namespaced (BANANA_*) so this never collides with the separate Bold
// Banter extension's own GPTMIRROR_* messages if both are installed and
// pointed at the same ChatGPT tab. chatgpt-bridge.js answers these — it's
// registered as a static content script on chatgpt.com/chat.openai.com in
// manifest.json, so it's normally already there; the fallback re-inject
// below only matters for a tab that was already open before this
// extension was installed/reloaded.
const BANANA_CHATGPT_TAB_URL_RE = /^https:\/\/(chat\.openai\.com|chatgpt\.com)\//;
// How long to wait for a freshly-opened ChatGPT tab to finish loading
// before giving up and letting sendToBananaChatGptTab's own inject-and-
// retry fallback take a shot anyway — a slow connection/cold tab shouldn't
// hang a run forever, but the static content_scripts registration (see
// BANANA_CHATGPT_TAB_URL_RE's own comment) means messaging too early just
// means one harmless extra executeScript call, not a hard failure.
const FRESH_CHATGPT_TAB_LOAD_TIMEOUT_MS = 10000;

// Opens a brand-new, disposable ChatGPT tab for ONE run (runManualGenerate's
// caller closes it again once that run finishes, see that function's own
// finally) instead of reusing/requiring an already-open one — each run
// getting its own tab is what makes several jobs able to generate at once in
// Manual mode, and the user doesn't have to keep any ChatGPT tab open
// themselves beforehand any more (see generateGateOk's own comment).
// Navigates to MANUAL_CHATGPT_URL (validated before Generate was ever
// clickable — see generateGateOk/isValidManualChatGptUrl), e.g. a Project/
// custom GPT link (chatgpt.com/g/…), so every run starts from whatever
// instructions/context that chat already has. Pasting a specific saved
// conversation (chatgpt.com/c/…) instead means concurrent runs share that
// one thread — the user's call, not something this function second-guesses.
//
const CORNER_WINDOW_WIDTH = 420;
const CORNER_WINDOW_HEIGHT = 560;
const CORNER_WINDOW_MARGIN = 12;

// Chrome's "is this window actually hidden" throttle is about screen
// OCCLUSION (is any pixel of it visible), not focus — a window that's
// merely unfocused but not covered by anything else is NOT throttled the
// same way a same-window background tab is. Picks the bottom-right corner
// of whichever display the job tab's own window is on, sized small — a
// genuine bet that pixels nobody else is drawing over stay un-occluded
// regardless of OS focus, which is mechanically different from (and
// untested relative to) the focus-based things already tried. Best-effort:
// a maximized main window can still cover this corner entirely, in which
// case this doesn't help and the window gets created at Chrome's own
// default position instead (still fine, just not specifically corner-safe).
async function pickCornerWindowBounds() {
  try {
    const displays = await chrome.system.display.getInfo();
    if (!displays?.length) return null;
    const current = await chrome.windows.getCurrent();
    const cx = (current.left ?? 0) + (current.width ?? 0) / 2;
    const cy = (current.top ?? 0) + (current.height ?? 0) / 2;
    const display =
      displays.find((d) => {
        const b = d.workArea || d.bounds;
        return cx >= b.left && cx < b.left + b.width && cy >= b.top && cy < b.top + b.height;
      }) || displays[0];
    const area = display.workArea || display.bounds;
    // Clamped to the display's own bounds — an unusually small/narrow
    // secondary display could otherwise put left/top outside it, and an
    // off-screen position is its own separate way to end up effectively
    // invisible (same end result as a covered or minimized window).
    return {
      left: Math.round(Math.max(area.left, area.left + area.width - CORNER_WINDOW_WIDTH - CORNER_WINDOW_MARGIN)),
      top: Math.round(Math.max(area.top, area.top + area.height - CORNER_WINDOW_HEIGHT - CORNER_WINDOW_MARGIN)),
      width: Math.min(CORNER_WINDOW_WIDTH, Math.round(area.width)),
      height: Math.min(CORNER_WINDOW_HEIGHT, Math.round(area.height)),
      // The job tab's own window id — openFreshBananaChatGptTab needs it
      // back to hand focus straight back after its own initial flash (see
      // its own comment), and this already has it from the getCurrent()
      // call above, so no second lookup.
      originWindowId: current.id,
    };
  } catch {
    return null; // chrome.system.display unavailable or denied — fall back to no explicit position
  }
}

// A SEPARATE WINDOW, corner-placed (see pickCornerWindowBounds) instead of
// Chrome's own default position (almost always sitting right behind the
// user's own main window, which throttles it the same as a background tab)
// — AND opened with focused: true, then immediately handed back to the job
// tab's own window a moment later. Three things were tried and ruled out
// before landing here, each confirmed by actually running it, not just
// reasoning about it:
//   1. Same-window background tab — rAF never fires for a non-selected
//      tab; the typed prompt never even got submitted.
//   2. Unfocused window, Chrome's default (occluded) position — typing and
//      submitting worked, but ChatGPT itself never started generating.
//   3. Unfocused window, CORNER position, from the very first open — fixed
//      #2 most of the time, but inconsistently: Windows has its own
//      foreground-lock behavior that can withhold ever actually PAINTING a
//      window that was never given permission to take focus, independent
//      of anything Chrome itself decides — so sometimes nothing ever
//      rendered until the user clicked its taskbar icon by hand.
// Opening focused (this version) gives Windows that permission up front,
// so it reliably actually shows/activates the window at least once — then
// focus is handed right back, same "doesn't steal your attention"
// result as before, just after a brief real flash instead of a maybe-never
// risk. Once shown, Windows doesn't un-show it just because focus moves on
// — and the corner position means Chrome's own occlusion-based throttling
// (see chatgpt-visibility-shim.js for the OTHER half of that fight) still
// doesn't kick back in later when the user clicks over to a different job
// tab, which is exactly the scenario that broke the plain focused:true
// attempt before this one.
async function openFreshBananaChatGptTab() {
  const corner = await pickCornerWindowBounds();
  const win = await chrome.windows.create({
    url: MANUAL_CHATGPT_URL.trim(),
    focused: true,
    state: "normal",
    type: "popup",
    width: corner?.width ?? 1000,
    height: corner?.height ?? 760,
    ...(corner ? { left: corner.left, top: corner.top } : {}),
  });
  // Best-effort, fire-and-forget — the window's own load/composer-wait
  // below doesn't need to wait on this, and the whole point is handing
  // focus back as fast as possible, not holding it a moment longer than
  // it takes Windows to register the window as actually shown.
  if (corner?.originWindowId != null) {
    chrome.windows.update(corner.originWindowId, { focused: true }).catch(() => {});
  }
  const tab = win.tabs?.[0] || (await chrome.tabs.query({ windowId: win.id }))[0];
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tab.id && changeInfo.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    const timer = setTimeout(finish, FRESH_CHATGPT_TAB_LOAD_TIMEOUT_MS);
  });
  return tab;
}
async function sendToBananaChatGptTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    if (!/Receiving end does not exist/i.test(e?.message || "")) throw e;
    await chrome.scripting.executeScript({ target: { tabId }, files: ["chatgpt-bridge.js"] });
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}
async function runOnBananaChatGptTab(tab, text) {
  return sendToBananaChatGptTab(tab.id, { type: "BANANA_RUN_PROMPT", text });
}

// Was initSettingsMenu — the gear used to open a small anchored dropdown
// right here; Settings is an ordinary tab now (see #mainTabs), and this
// toggle lives in that tab's own Shortcuts sub-tab instead (sidepanel.html's
// #settingsShortcutsPanel). Still the same storage-backed RESUME_MODE
// state/listeners/click handler, just no
// open/close bookkeeping left to do.
function initResumeModeToggle() {
  try {
    chrome.storage?.local?.get([STORAGE.resumeMode, STORAGE.manualChatGptUrl], (v) => {
      RESUME_MODE = (v && v[STORAGE.resumeMode]) || "auto";
      MANUAL_CHATGPT_URL = (v && v[STORAGE.manualChatGptUrl]) || "";
      syncResumeModeUI();
    });
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area !== "local") return;
      let dirty = false;
      if (changes[STORAGE.resumeMode]) {
        RESUME_MODE = changes[STORAGE.resumeMode].newValue || "auto";
        dirty = true;
      }
      if (changes[STORAGE.manualChatGptUrl]) {
        MANUAL_CHATGPT_URL = changes[STORAGE.manualChatGptUrl].newValue || "";
        dirty = true;
      }
      if (dirty) syncResumeModeUI();
    });
  } catch { /* ignore */ }

  // Label + toast "kind" (see PANEL_TOAST_ICONS' "mode-*" entries) per
  // data-mode value — one shared lookup so the toggle's click handler and
  // anything else that ever needs "the display name for this mode" don't
  // each keep their own copy.
  const RESUME_MODE_LABELS = { auto: "PRO", free: "FREE", manual: "MANUAL" };
  els.resumeModeToggle?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-mode]");
    if (!btn) return;
    RESUME_MODE = btn.dataset.mode;
    syncResumeModeUI();
    panelToast(`Switched to ${RESUME_MODE_LABELS[RESUME_MODE] || RESUME_MODE} mode`, `mode-${RESUME_MODE}`);
    // generateGateOk() depends on RESUME_MODE (now also blocks Free mode
    // outright) — without this, switching modes via the toggle itself
    // never re-evaluated els.generateBtn.disabled at all (only typing in
    // the Manual-mode URL field did), so Free's own Generate-disabled
    // state wouldn't actually apply until something else happened to
    // trigger a refresh.
    refreshGenerateDisabled();
    try { await chrome.storage?.local?.set({ [STORAGE.resumeMode]: RESUME_MODE }); } catch { /* ignore */ }
  });

  // Live (not just on blur) — "Generate button enabled the moment a correct
  // URL is put" means the hint/border/Generate-disabled state all need to
  // track every keystroke, not just a committed value.
  els.manualChatGptUrlInput?.addEventListener("input", async (e) => {
    MANUAL_CHATGPT_URL = e.target.value;
    syncManualChatGptUrlUI();
    refreshGenerateDisabled();
    try { await chrome.storage?.local?.set({ [STORAGE.manualChatGptUrl]: MANUAL_CHATGPT_URL }); } catch { /* ignore */ }
  });
  // Open button removed — Enter in the field and clicking the icon both
  // open the URL now (see openManualChatGptUrl's own comment).
  els.manualChatGptUrlInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      openManualChatGptUrl();
    }
  });
  els.manualChatGptUrlOpenIcon?.addEventListener("click", () => openManualChatGptUrl());
  els.manualChatGptUrlOpenIcon?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openManualChatGptUrl();
    }
  });

  // Test button removed — clicking the icon or the preview text both run
  // the check now (see checkMyApiKey's own comment).
  const runKeyTest = () => checkMyApiKey();
  els.apiKeyCheckIcon?.addEventListener("click", runKeyTest);
  els.apiKeyPreviewText?.addEventListener("click", runKeyTest);
  for (const el of [els.apiKeyCheckIcon, els.apiKeyPreviewText]) {
    el?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        runKeyTest();
      }
    });
  }
  // Group key cycling — stopPropagation so a click here doesn't also
  // bubble up into apiKeyPreviewText's own click (that would re-run
  // checkMyApiKey on every single cycle click, which isn't what Prev/Next
  // are for).
  els.apiKeyPrevBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    cycleApiKey(-1);
  });
  els.apiKeyNextBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    cycleApiKey(1);
  });
}

// The avatar+name chip's dropdown (Profile / Settings / Sign out) — same
// outside-click-closes pattern as the Autofill button's own format menu
// (see runExport's own ref-based listener elsewhere in this file). Takes
// onSignOut rather than calling doSignOut directly — that function is
// declared inside the DOMContentLoaded handler's own closure, out of reach
// from this top-level function.
function initUserMenu(onSignOut) {
  const closeMenu = () => {
    els.userMenu?.classList.add("hidden");
    els.userMenuBtn?.setAttribute("aria-expanded", "false");
  };
  els.userMenuBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = els.userMenu?.classList.contains("hidden");
    els.userMenu?.classList.toggle("hidden", !willOpen);
    els.userMenuBtn?.setAttribute("aria-expanded", String(!!willOpen));
  });
  document.addEventListener("click", (e) => {
    if (els.userMenu?.classList.contains("hidden")) return;
    if (els.userMenu.contains(e.target) || els.userMenuBtn?.contains(e.target)) return;
    closeMenu();
  });
  els.userMenuProfileBtn?.addEventListener("click", () => {
    closeMenu();
    switchToTab("profile");
  });
  els.userMenuSettingsBtn?.addEventListener("click", () => {
    closeMenu();
    switchToTab("account");
  });
  els.userMenuSignOutBtn?.addEventListener("click", () => {
    closeMenu();
    onSignOut?.();
  });
}

function initFilenameSettings() {
  try {
    chrome.storage?.local?.get([FILENAME_RESUME_KEY, FILENAME_COVER_KEY, FILENAME_JD_KEY], (v) => {
      FILENAME_RESUME = (v && v[FILENAME_RESUME_KEY]) || DEFAULT_FILENAME_RESUME;
      FILENAME_COVER = (v && v[FILENAME_COVER_KEY]) || DEFAULT_FILENAME_COVER;
      FILENAME_JD = (v && v[FILENAME_JD_KEY]) || DEFAULT_FILENAME_JD;
      syncFilenameSettingsUI();
    });
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[FILENAME_RESUME_KEY]) FILENAME_RESUME = changes[FILENAME_RESUME_KEY].newValue || DEFAULT_FILENAME_RESUME;
      if (changes[FILENAME_COVER_KEY]) FILENAME_COVER = changes[FILENAME_COVER_KEY].newValue || DEFAULT_FILENAME_COVER;
      if (changes[FILENAME_JD_KEY]) FILENAME_JD = changes[FILENAME_JD_KEY].newValue || DEFAULT_FILENAME_JD;
      syncFilenameSettingsUI();
    });
  } catch { /* ignore */ }
}

// Skips a field the user is actively typing in — an onChanged echo from this
// same panel's own save (below) would otherwise stomp the cursor mid-edit.
function syncFilenameSettingsUI() {
  if (els.filenameResumeInput && document.activeElement !== els.filenameResumeInput) {
    els.filenameResumeInput.value = FILENAME_RESUME;
  }
  if (els.filenameCoverInput && document.activeElement !== els.filenameCoverInput) {
    els.filenameCoverInput.value = FILENAME_COVER;
  }
  if (els.filenameJdInput && document.activeElement !== els.filenameJdInput) {
    els.filenameJdInput.value = FILENAME_JD;
  }
}

async function setFilenameTemplate(kind, value) {
  const v = String(value || "").trim();
  if (kind === "resume") {
    FILENAME_RESUME = v || DEFAULT_FILENAME_RESUME;
    try { await chrome.storage?.local?.set({ [FILENAME_RESUME_KEY]: FILENAME_RESUME }); } catch { /* ignore */ }
  } else if (kind === "cover") {
    FILENAME_COVER = v || DEFAULT_FILENAME_COVER;
    try { await chrome.storage?.local?.set({ [FILENAME_COVER_KEY]: FILENAME_COVER }); } catch { /* ignore */ }
  } else if (kind === "jd") {
    FILENAME_JD = v || DEFAULT_FILENAME_JD;
    try { await chrome.storage?.local?.set({ [FILENAME_JD_KEY]: FILENAME_JD }); } catch { /* ignore */ }
  }
}

// Fills a {profile}/{company}/{role} template and sanitizes it into one
// filesystem-safe filename (same sanitizer resolveAppFolder's own
// companyFolderSegment/jdFileName use), then appends `ext`. Falls back to
// `fallback` (also sanitized) if the filled-in template comes out empty —
// e.g. a template that's ONLY "{role}" with no role detected yet.
function buildFilenameFromTemplate(template, vars, ext, fallback) {
  const filled = String(template || "")
    .replace(/\{profile\}/gi, vars.profile || "")
    .replace(/\{first_name\}/gi, vars.first_name || "")
    .replace(/\{last_name\}/gi, vars.last_name || "")
    .replace(/\{company\}/gi, vars.company || "")
    .replace(/\{role\}/gi, vars.role || "");
  const safe = sanitizePathSegment(filled) || sanitizePathSegment(fallback || "") || "file";
  return `${safe}.${ext}`;
}

// The extension server already returns on a generated file's own name
// (e.g. "resume.pdf"/"cover-letter.pdf") — read back off of that instead
// of hardcoding "pdf", so this stays correct even if the server's own
// default ever changes.
function extOf(name, fallback) {
  return (String(name || "").match(/\.([a-z0-9]+)$/i)?.[1] || fallback || "pdf").toLowerCase();
}

// The currently-selected profile's own {profile}/{first_name}/{last_name}
// filename token values (PROFILES_BY_ID, see loadProfilesFromServer).
// {profile} is the profile's internal org-facing label (its "Profile
// name"); {first_name}/{last_name} are the resume's own name fields —
// separate concepts, see AddProfileModal.jsx.
function currentProfileFilenameVars() {
  const id = selectedProfileId();
  const p = (id && PROFILES_BY_ID.get(id)) || null;
  return {
    profile: p?.name || "",
    first_name: p?.firstName || "",
    last_name: p?.lastName || "",
  };
}


// Tells this bidder whether {{bullet_count}} is actually in the prompt
// they'll get at generate time (see checkBulletCountToken in
// generateController.js, which resolves it with the exact same precedence
// fullGenerateAndDownload uses) — otherwise the range above silently does
// nothing and there'd be no way to tell. Prompt is a per-PROFILE setting
// now, not per-member, so this checks against the currently selected
// profile (falls back to the org/granted layers with none picked, same as
// passing a profile with no promptId of its own). Re-checked every
// time the Prompt subtab is opened (see switchSettingsSubTab) so it can't
// go stale if an admin edits the prompt elsewhere, or the selected profile
// changes, while this panel stays open.
async function refreshBulletCountTokenStatus() {
  const el = els.bulletCountTokenStatus;
  if (!el) return;
  let present = null;
  try {
    const pid = selectedProfileId();
    const qs = pid ? `?profileId=${encodeURIComponent(pid)}` : "";
    const resp = await apiFetch(`/bullet-count-token-check${qs}`);
    present = !!resp?.present;
  } catch { /* offline / not signed in — leave it hidden rather than guess */ }
  if (present === null) {
    el.className = "status-box hidden";
    return;
  }
  el.className = "status-box " + (present ? "success" : "warning");
  el.textContent = present
    ? "Found in your prompt"
    : "Not found in your prompt — this range currently has no effect. Ask your admin to add the {{bullet_count}} token.";
}

// Settings tab > Resume Template — which of the server's RESUME_TEMPLATES
// (GET /resume-templates — fetched, not hardcoded here, so the two never
// drift) Generate renders the resume with. This is a PER-PROFILE pick
// (Profile.resumeTemplateId) — the exact same field the main app's own
// Profile page > Apply tab reads/writes (see profileController.js's
// updateProfileResumeTemplate), so picking one here or there shows up in
// the other instantly. See currentResumeTemplateId below for the actual
// resolution order.
const RESUME_TEMPLATE_FALLBACK_KEY = "ab_resume_template";
// Legacy per-device setting — now only consulted with NO profile selected
// at all (see currentResumeTemplateId), since there's nowhere per-profile
// to persist a pick in that case. Kept rather than dropped so the picker
// still does something sane instead of erroring in that edge case.
let RESUME_TEMPLATE_FALLBACK_ID = "";
// The server's own recommended default (GET /resume-templates' defaultId)
// — the fallback for a profile that hasn't had a template pinned yet, same
// "profile pin, else org default" precedence the server's own
// fullGenerateAndDownload uses.
let RESUME_TEMPLATE_SERVER_DEFAULT_ID = "";
let RESUME_TEMPLATES_CACHE = [];

// The template that actually applies right now: the selected profile's own
// pin, else the server's recommended default, else (no profile selected
// at all) this device's own last-used fallback.
function currentResumeTemplateId() {
  const pid = selectedProfileId();
  const profile = pid ? PROFILES_BY_ID.get(pid) : null;
  if (profile?.resumeTemplateId) return profile.resumeTemplateId;
  const fallback = RESUME_TEMPLATE_SERVER_DEFAULT_ID || RESUME_TEMPLATES_CACHE[0]?.id || "";
  return pid ? fallback : RESUME_TEMPLATE_FALLBACK_ID || fallback;
}

// Bullet Range is a per-PROFILE admin setting now (Profile.bulletMin/
// bulletMax — same field the main app's own Profile page > Resume tab >
// Apply sub-tab writes), sent along with every generate call so the server
// has it even for an older deploy reading req.body first. Falls back to
// 10/12 (Profile.js's own schema defaults) with no profile selected, or
// for a profile from before this field existed.
function currentBulletRange() {
  const pid = selectedProfileId();
  const profile = pid ? PROFILES_BY_ID.get(pid) : null;
  const min = Number.isFinite(profile?.bulletMin) ? profile.bulletMin : 10;
  const max = Number.isFinite(profile?.bulletMax) ? profile.bulletMax : 12;
  return { min, max };
}

async function initResumeTemplateSetting() {
  try {
    const stored = await new Promise((resolve) => {
      chrome.storage?.local?.get([RESUME_TEMPLATE_FALLBACK_KEY], (v) => resolve(v && v[RESUME_TEMPLATE_FALLBACK_KEY]));
    });
    if (stored) RESUME_TEMPLATE_FALLBACK_ID = stored;
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area === "local" && changes[RESUME_TEMPLATE_FALLBACK_KEY]) {
        RESUME_TEMPLATE_FALLBACK_ID = changes[RESUME_TEMPLATE_FALLBACK_KEY].newValue || RESUME_TEMPLATE_FALLBACK_ID;
        renderApplySettingsReadOnly();
      }
    });
  } catch { /* ignore */ }
  await loadResumeTemplates();
}

// Best-effort — called again once signed in (see refreshCapabilities) since
// the very first call at init() usually has no token yet.
async function loadResumeTemplates() {
  try {
    const resp = await apiFetch("/resume-templates");
    RESUME_TEMPLATES_CACHE = resp?.templates || [];
    RESUME_TEMPLATE_SERVER_DEFAULT_ID = resp?.defaultId || RESUME_TEMPLATES_CACHE[0]?.id || "";
    renderApplySettingsReadOnly();
  } catch { /* not signed in yet, or offline */ }
}

// Settings > Prompt tab's Date Format row — same value/label pairs as the
// main app's own Profiles.jsx DATE_FORMAT_OPTIONS (keep in sync by hand;
// there's no shared import between the extension and the web app). "" is a
// profile that explicitly chose "AI decides" — distinct from a profile that
// has never touched this at all, which reads as the mon_yyyy default (see
// renderApplySettingsReadOnly below, same distinction
// applyDateFormatOverride makes server-side).
const DATE_FORMAT_LABELS = {
  "": "AI decides",
  mon_yyyy: "Sep 2021 - Dec 2026",
  month_yyyy: "September 2021 - December 2026",
  "mm/yyyy": "09/2021 - 12/2026",
  "yyyy/mm": "2021/09 - 2026/12",
  "yyyy-mm": "2021-09 - 2026-12",
  "mm-yyyy": "09-2021 - 12-2026",
};

// Settings > Prompt tab — read-only mirror of every Apply-tab setting
// (Resume Prompt, Auto-fill Prompt, Resume Template, Date Format, Education
// Dates, Bullet Range), all six admin-only to CHANGE now (see
// profileController.js's isManager guards) — so this just displays
// whichever profile is currently selected (or each field's own org/
// platform default with none selected), same "profile pin, else default"
// resolution each field already used server-side. Called on profile switch
// (chooseProfile), on profile/template/prompt-title reload
// (loadProfilesFromServer/loadResumeTemplates), and when this subtab opens
// (switchSettingsSubTab).
function renderApplySettingsReadOnly() {
  const pid = selectedProfileId();
  const profile = pid ? PROFILES_BY_ID.get(pid) : null;

  if (els.applyPromptValue) {
    const title = profile?.promptId ? PROMPT_TITLE_BY_ID.get(String(profile.promptId)) : null;
    els.applyPromptValue.textContent = title || `${DEFAULT_PROMPT_TITLE} (default)`;
  }
  if (els.applyAutofillPromptValue) {
    const title = profile?.autoFillPromptId
      ? AUTOFILL_PROMPT_TITLE_BY_ID.get(String(profile.autoFillPromptId))
      : null;
    els.applyAutofillPromptValue.textContent = title || `${DEFAULT_AUTOFILL_PROMPT_TITLE} (default)`;
  }
  if (els.applyTemplateValue) {
    const pinned = profile?.resumeTemplateId || "";
    const id = pinned || RESUME_TEMPLATE_SERVER_DEFAULT_ID || RESUME_TEMPLATES_CACHE[0]?.id || "";
    const name = RESUME_TEMPLATES_CACHE.find((t) => t.id === id)?.name || "—";
    els.applyTemplateValue.textContent = pinned ? name : `${name} (default)`;
  }
  if (els.applyDateFormatValue) {
    const fmt = profile?.resumeDateFormat === "" ? "" : profile?.resumeDateFormat || "mon_yyyy";
    els.applyDateFormatValue.textContent = DATE_FORMAT_LABELS[fmt] ?? DATE_FORMAT_LABELS.mon_yyyy;
  }
  if (els.applyEducationValue) {
    const yearOnly = profile?.educationYearOnly !== false;
    els.applyEducationValue.textContent = yearOnly
      ? "Year only (e.g. 2021 - 2026)"
      : "Month and year (follows Date Format)";
  }
  if (els.bulletRangeValue) {
    const lo = Number.isFinite(profile?.bulletMin) ? profile.bulletMin : 10;
    const hi = Number.isFinite(profile?.bulletMax) ? profile.bulletMax : 12;
    els.bulletRangeValue.textContent = `Min ${lo} - Max ${hi}`;
  }
}

async function savePatch(tabId, patch) {
  if (!tabId) return null;
  const resp = await sendToBG({ type: "SAVE_STATE", tabId: tabId, patch });
  // Adopt the saved state as the panel's live STATE only when it belongs
  // to the tab currently on screen. A run that continues after the user
  // switched tabs must still PERSIST to its own tab — but it must not
  // hijack the view by pushing that tab's state into the visible panel.
  if (resp && resp.ok && tabId === TAB_ID) STATE = resp.state;
  // Returned so a background run can keep ITS OWN copy of the tab's state
  // fresh without depending on the (visible-tab) global.
  return resp && resp.ok ? resp.state : null;
}

/** The generated CV PDF for the current tab, if any. Server resultFiles entries
 *  are shaped { name, type, file } where `file` is raw base64 (NOT a data: URL).
 *  Returns null when nothing has been generated yet. */
// Matches by the "resume." filename prefix, not a specific extension —
// always resume.pdf today, but every caller here finds it this way
// regardless. `files` entries are always { name, type, file } (file =
// base64), the shape /full-generate-and-download's resultFiles and
// STATE.files both use.
function findResumeFile(files) {
  return (
    (files || []).find(
      (f) => f && typeof f.file === "string" && f.file.length > 0 && /^resume\./i.test(f.name || ""),
    ) || null
  );
}

function getGeneratedCvFile() {
  return findResumeFile(STATE?.files);
}

function base64ToUint8Array(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---- Download folder (File System Access) ------------------------------
// The user can pick a base folder; CV / cover-letter PDFs are then saved into
// <base>/<Company>/ instead of piling up in Downloads under the same name. The
// chosen directory handle is persisted in IndexedDB so it survives reloads.
// With no folder picked (default), files go to Downloads/<Company>/ via
// chrome.downloads. Wired to browseDownloadFolderBtn + downloadFolderHint.
const FOLDER_DB_NAME = "proactive-download-root";
const FOLDER_STORE = "rootHandle";
let DOWNLOAD_DIR_HANDLE = null; // FileSystemDirectoryHandle | null (→ Downloads)
// Chrome doesn't always keep readwrite permission granted on a restored handle
// across a browser restart — the handle itself survives in IndexedDB, but a
// write can silently fall back to Downloads until the user re-approves it via
// a real gesture. Tracked so the hint never claims a folder is active when it
// isn't (see ensureDirPermission / updateDownloadFolderHint).
let DOWNLOAD_DIR_NEEDS_REGRANT = false;

const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
function sanitizePathSegment(raw) {
  let t = String(raw ?? "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "") // trailing dots/spaces are invalid on Windows
    .slice(0, 120)
    .replace(/[.\s]+$/, ""); // the slice can re-expose a trailing dot
  if (RESERVED_DEVICE_NAMES.test(t)) t = `_${t}`;
  return t;
}
function sanitizeFilenameOnly(name) {
  const base = String(name || "file")
    .replace(/[\\/]+/g, "-")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .trim();
  return (base || "file").slice(0, 180).replace(/[.\s]+$/, "") || "file";
}

function openFolderIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FOLDER_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FOLDER_STORE)) db.createObjectStore(FOLDER_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbPutFolderHandle(handle) {
  const db = await openFolderIdb();
  try {
    await new Promise((res, rej) => {
      const tx = db.transaction(FOLDER_STORE, "readwrite");
      tx.objectStore(FOLDER_STORE).put(handle, "root");
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  } finally { db.close(); }
}
async function idbGetFolderHandle() {
  const db = await openFolderIdb();
  try {
    return await new Promise((res, rej) => {
      const tx = db.transaction(FOLDER_STORE, "readonly");
      const r = tx.objectStore(FOLDER_STORE).get("root");
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => rej(r.error);
    });
  } finally { db.close(); }
}

// queryPermission first; only requestPermission on a real user gesture (the
// download / browse click). Returns false if the handle is gone or denied.
async function ensureDirPermission(handle, gesture) {
  if (!handle) return false;
  try {
    const opts = { mode: "readwrite" };
    if ((await handle.queryPermission(opts)) === "granted") {
      DOWNLOAD_DIR_NEEDS_REGRANT = false;
      return true;
    }
    if (gesture && (await handle.requestPermission(opts)) === "granted") {
      DOWNLOAD_DIR_NEEDS_REGRANT = false;
      return true;
    }
  } catch { /* handle invalidated (folder moved/deleted) */ }
  DOWNLOAD_DIR_NEEDS_REGRANT = true;
  return false;
}

/** Company sub-folder name for the current form (fallback keeps files grouped). */
function companyFolderSegment() {
  return sanitizePathSegment(els.companyName?.value || "") || "Applications";
}

/** The .txt filename this application's job description is saved as (named after
 *  the role). Also used to recognise which company folder belongs to this role. */
function jdFileName() {
  const role = (els.roleTitle?.value || STATE?.roleTitle || "").trim();
  return `${sanitizePathSegment(role) || "Job Description"}.txt`;
}

/** Does this company folder belong to the current role? True when it has no
 *  job-description .txt yet (free to use) or already has THIS role's .txt (same
 *  application → reuse + overwrite). A folder holding a DIFFERENT role's JD is a
 *  separate application, so we skip it and try the next numbered folder. */
async function dirMatchesRole(dirHandle, roleFile) {
  try {
    const wanted = roleFile.toLowerCase();
    let hasOther = false;
    for await (const [name, entry] of dirHandle.entries()) {
      if (entry.kind === "file" && /\.txt$/i.test(name)) {
        if (name.toLowerCase() === wanted) return true; // same role
        hasOther = true;
      }
    }
    return !hasOther; // no JD → free; only other-role JDs → skip
  } catch {
    return true; // can't enumerate → assume usable
  }
}

/** Drop the role marker (a .txt named after the role) into a resolved folder
 *  so it's "claimed" for THIS role — even when the application only ever
 *  downloads a cover letter, or has an empty JD. Without a marker, dirMatchesRole
 *  treats the folder as free, so a later download for a DIFFERENT role at the
 *  same company would reuse + overwrite it instead of getting "<Company> (n)".
 *  Best-effort; only meaningful for the picked folder (Downloads can't
 *  enumerate). Won't clobber an existing marker (e.g. a real JD from the CV).
 *
 *  dirMatchesRole (above) only ever checks this file's NAME, never its
 *  content — so it used to hold the raw job description text, purely as a
 *  human-readable nicety. That backfired: resolveAppFolder awaits this
 *  BEFORE saving the actual resume/cover-letter/JD files, so on a brand-new
 *  folder this marker landed on disk a beat before them — anyone checking
 *  the folder right after clicking Download would see what looked exactly
 *  like a plain-text JD file instead of their real download, and only see
 *  the real files a moment later (or on a second click). A short, explicit
 *  label instead of the JD text can't be mistaken for a real deliverable. */
async function ensureRoleMarker(folderName) {
  if (!DOWNLOAD_DIR_HANDLE) return;
  try {
    const dir = await DOWNLOAD_DIR_HANDLE.getDirectoryHandle(folderName, { create: true });
    const marker = jdFileName();
    const wanted = marker.toLowerCase();
    for await (const [n, e] of dir.entries()) {
      if (e.kind === "file" && n.toLowerCase() === wanted) return; // already claimed
    }
    const role = (els.roleTitle?.value || STATE?.roleTitle || "").trim() || "this role";
    const note =
      `This is a folder marker, not a downloaded file — it just claims this folder for "${role}" ` +
      `so a later download for a different role lands in its own folder instead of overwriting ` +
      `this one. Your resume, cover letter, and job description download separately.`;
    const fh = await dir.getFileHandle(marker, { create: true });
    const w = await fh.createWritable();
    await w.write(new Blob([note], { type: "text/plain" }));
    await w.close();
  } catch { /* best-effort — never block the download over the marker */ }
}

// One download action's files (CV, JD, cover) share a folder, resolved once per
// generation and cached.
let APP_FOLDER_CACHE = { key: null, name: null };

/** Resolve (and cache) the destination folder. Same company + role reuses (and
 *  overwrites) its folder; a DIFFERENT role at the same company gets a fresh
 *  "<Company> (n)". Role-aware numbering only works in the picked folder — the
 *  Downloads API can't enumerate folders, so there we keep the base name. */
async function resolveAppFolder(gesture) {
  const base = companyFolderSegment();
  const roleFile = jdFileName();
  const key = STATE?.generationId || `${base}|${roleFile}`;
  if (APP_FOLDER_CACHE.key === key && APP_FOLDER_CACHE.name) return APP_FOLDER_CACHE.name;

  let name = base;
  if (DOWNLOAD_DIR_HANDLE) {
    try {
      if (await ensureDirPermission(DOWNLOAD_DIR_HANDLE, gesture)) {
        for (let i = 0; i < 200; i++) {
          const candidate = i === 0 ? base : `${base} (${i})`;
          let dir;
          try {
            dir = await DOWNLOAD_DIR_HANDLE.getDirectoryHandle(candidate, { create: false });
          } catch {
            name = candidate; // doesn't exist → new folder for this role
            break;
          }
          if (await dirMatchesRole(dir, roleFile)) { name = candidate; break; } // reuse
          // else occupied by a different role → try the next number
        }
        // Claim the folder for THIS role now, so a later download for a
        // different role at the same company is correctly pushed to
        // "<Company> (n)" even if this application only downloads the cover
        // letter (which otherwise never writes the role marker).
        await ensureRoleMarker(name);
      }
    } catch { /* fall back to the base name */ }
  }
  APP_FOLDER_CACHE = { key, name };
  return name;
}

/** Save one file (bytes) into <chosen base>/<folderName>/<filename>, OVERWRITING
 *  any existing file of the same name — so re-downloading the same application
 *  (same company + role → same folder + filenames) replaces its files instead
 *  of piling up "(1)" copies. Uses the picked folder via File System Access when
 *  set + permitted; otherwise falls back to Downloads/<folderName>/<filename>
 *  via chrome.downloads. Returns the display path. */
async function saveOneFile({ bytes, mime, filename, folderName, gesture = true }) {
  const safeName = sanitizeFilenameOnly(filename);
  if (DOWNLOAD_DIR_HANDLE) {
    try {
      const permitted = await ensureDirPermission(DOWNLOAD_DIR_HANDLE, gesture);
      updateDownloadFolderHint(); // reflects a mid-session re-grant (or a fresh revoke) right away
      if (permitted) {
        const dir = await DOWNLOAD_DIR_HANDLE.getDirectoryHandle(folderName, { create: true });
        // createWritable() truncates, so writing an existing handle overwrites it.
        const fh = await dir.getFileHandle(safeName, { create: true });
        const w = await fh.createWritable();
        await w.write(new Blob([bytes], { type: mime }));
        await w.close();
        return `${DOWNLOAD_DIR_HANDLE.name}/${folderName}/${safeName}`;
      }
    } catch (e) {
      console.warn("[download] folder write failed — falling back to Downloads:", e?.message || e);
    }
  }

  // Default / fallback: Downloads/<folderName>/<filename>. conflictAction
  // "overwrite" replaces the existing file instead of chrome's default "(1)".
  const blobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
  try {
    await chrome.downloads.download({
      url: blobUrl,
      filename: `${folderName}/${safeName}`,
      conflictAction: "overwrite",
      saveAs: false,
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  }
  return `Downloads/${folderName}/${safeName}`;
}

/** Reflect the current download target in the small hint under the buttons. */
function updateDownloadFolderHint() {
  if (els.downloadFolderHint) {
    const base = DOWNLOAD_DIR_HANDLE ? DOWNLOAD_DIR_HANDLE.name : "Downloads";
    if (DOWNLOAD_DIR_HANDLE && DOWNLOAD_DIR_NEEDS_REGRANT) {
      els.downloadFolderHint.textContent = `"${base}" needs to be reconnected — click Browse folder.`;
      els.downloadFolderHint.title =
        `Chrome needs you to re-approve access to "${base}" (this can happen after a browser restart). ` +
        `Until you reconnect it, downloads go to Downloads/<Company>/ instead.`;
    } else {
      els.downloadFolderHint.textContent = `Saving to ${base}/<Company>/`;
      els.downloadFolderHint.title = DOWNLOAD_DIR_HANDLE
        ? `CV, job description (named after the role) and cover letter are saved into a company-named folder inside "${DOWNLOAD_DIR_HANDLE.name}". Re-downloading the same application replaces the files.`
        : "CV, job description (named after the role) and cover letter are saved into a company-named folder inside your Downloads folder. Click Browse to choose a different location.";
    }
  }
  if (els.browseDownloadFolderBtn) {
    setButtonText(els.browseDownloadFolderBtn, DOWNLOAD_DIR_HANDLE ? "Change folder" : "Browse folder");
  }
}

/** Browse-folder click: open the OS folder picker and remember the choice. */
async function pickDownloadFolder() {
  if (typeof window.showDirectoryPicker !== "function") {
    setStatus(TAB_ID, "This browser can't pick a folder — files go to Downloads/<Company>/.", "error");
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    if (!(await ensureDirPermission(handle, true))) {
      setStatus(TAB_ID, "Folder access wasn't granted.", "error");
      return;
    }
    DOWNLOAD_DIR_HANDLE = handle;
    await idbPutFolderHandle(handle).catch(() => {});
    updateDownloadFolderHint();
    panelToast(`Downloads will be saved to "${handle.name}/<Company>/".`);
  } catch (e) {
    if (e?.name === "AbortError") return; // user cancelled the picker
    setStatus(TAB_ID, "Couldn't set the folder: " + (e?.message || e), "error");
  }
}

/** Restore the persisted download folder on startup (best-effort). Also checks
 *  (query-only, no gesture needed) whether Chrome still has it granted, so the
 *  hint never claims a folder is active when a write would actually fall back
 *  to Downloads — see DOWNLOAD_DIR_NEEDS_REGRANT. */
async function restoreDownloadFolder() {
  try {
    const h = await idbGetFolderHandle();
    if (h) {
      DOWNLOAD_DIR_HANDLE = h;
      await ensureDirPermission(h, false);
    }
  } catch { /* ignore */ }
  updateDownloadFolderHint();
}

/** Download the generated CV — and the job description alongside it — into
 *  <base>/<Company>/ (default Downloads). Same company + role overwrites the
 *  existing files rather than creating "(1)" copies. The JD is named after the
 *  role so different roles at the same company stay distinct. */
// The Generate row's own Download button — saves all three: resume, cover
// letter, and the job description — as the SAME PDF /export/jd produces for
// the standalone JD download button below, not the plain .txt dump this used
// to save. The role-marker .txt that folder-matching depends on
// (dirMatchesRole/jdFileName) is written independently by resolveAppFolder's
// own ensureRoleMarker call above, so switching this one to PDF doesn't
// touch that.
async function downloadGeneratedCv(tabId) {
  const file = getGeneratedCvFile();
  if (!file?.file) {
    setStatus(tabId, "Generate a CV first, then download.", "error");
    return;
  }
  const folderName = await resolveAppFolder(true);
  const company = els.companyName?.value || STATE?.companyName || "";
  const role = els.roleTitle?.value || STATE?.roleTitle || "";
  const nameVars = currentProfileFilenameVars();
  const saved = [];
  const failed = [];

  // Resume — now its own try/catch (used to be the one unguarded call in
  // this function: if it threw, the whole thing jumped straight to a
  // generic error and the cover-letter/JD saves below never even ran).
  // Each of the three files is independent now: one failing doesn't block
  // the others, and the final toast says what ACTUALLY happened instead
  // of a hardcoded "Resume and Job Description downloaded" regardless of
  // which files really saved (confirmed real complaint: clicking this
  // only ever produced the JD, with no error shown and no resume in
  // Downloads — the old hardcoded toast would have claimed success either
  // way, masking exactly this).
  try {
    await saveOneFile({
      bytes: base64ToUint8Array(file.file),
      mime: file.type || "application/pdf",
      filename: buildFilenameFromTemplate(FILENAME_RESUME, { ...nameVars, company, role }, extOf(file.name), "resume"),
      folderName,
    });
    saved.push("resume");
  } catch (e) {
    console.warn("[download] resume save failed:", e);
    failed.push("resume");
  }

  // Cover letter, if one's been generated.
  const info = STATE?.info;
  if (info?.cover_letter) {
    try {
      const resp = await apiFetch("/export/cover?type=pdf", {
        method: "POST",
        body: JSON.stringify({
          cover_letter: info.cover_letter,
          resume: info.resume,
          job_data: info.job_data,
        }),
      });
      const f = resp?.file;
      if (f?.file) {
        await saveOneFile({
          bytes: base64ToUint8Array(f.file),
          mime: f.type || "application/pdf",
          filename: buildFilenameFromTemplate(
            FILENAME_COVER,
            { ...nameVars, company, role },
            extOf(f.name),
            "cover-letter"
          ),
          folderName,
        });
        saved.push("cover letter");
      }
    } catch (e) {
      console.warn("[download] cover letter save failed:", e);
      failed.push("cover letter");
    }
  }

  // Job description, as a PDF — same /export/jd endpoint and style as the
  // JD field's own hover-download button, so both downloads produce the
  // same file instead of this one being a plain .txt dump.
  const jd = (STATE?.jobText || els.jobText?.value || "").trim();
  if (jd) {
    try {
      const resp = await apiFetch("/export/jd", {
        method: "POST",
        body: JSON.stringify({
          job_description: jd,
          company,
          role,
          jobUrl: STATE?.autoDetectedUrl || "",
        }),
      });
      const f = resp?.file;
      if (f?.file) {
        await saveOneFile({
          bytes: base64ToUint8Array(f.file),
          mime: f.type || "application/pdf",
          filename: buildFilenameFromTemplate(
            FILENAME_JD,
            { ...nameVars, company, role },
            extOf(f.name),
            "job-description"
          ),
          folderName,
        });
        saved.push("job description");
      }
    } catch (e) {
      console.warn("[download] job description save failed:", e);
      failed.push("job description");
    }
  }

  // In-panel, not an in-page notification on the actual webpage — this is
  // about the extension's own download, not something the page did. Says
  // what actually saved, not a fixed claim — and if the one thing anyone
  // actually cares about (the resume) failed, that's an error, not a
  // quiet success toast.
  if (saved.length) {
    panelToast(`${saved.join(", ").replace(/,(?=[^,]*$)/, " and")} downloaded`);
  }
  if (failed.includes("resume")) {
    setStatus(tabId, "Couldn't download the resume — try again.", "error");
  } else if (!saved.length) {
    setStatus(tabId, "Nothing to download.", "error");
  }
}

// Resume only — unlike downloadGeneratedCv above (the Generate row's own
// Download button, which saves all three), this is the Resume field's own
// hover-overlay Download button and saves just the one file.
async function downloadResumeOnly(tabId) {
  const file = getGeneratedCvFile();
  if (!file?.file) {
    setStatus(tabId, "Generate a CV first, then download.", "error");
    return;
  }
  try {
    const where = await saveOneFile({
      bytes: base64ToUint8Array(file.file),
      mime: file.type || "application/pdf",
      filename: buildFilenameFromTemplate(
        FILENAME_RESUME,
        {
          ...currentProfileFilenameVars(),
          company: els.companyName?.value || STATE?.companyName || "",
          role: els.roleTitle?.value || STATE?.roleTitle || "",
        },
        extOf(file.name),
        "resume"
      ),
      folderName: await resolveAppFolder(true),
    });
    panelToast(`Resume saved to ${where}.`);
  } catch (e) {
    setStatus(tabId, "Couldn't download the resume: " + (e?.message || e), "error");
  }
}

async function getActiveInWindow(windowId) {
  const tabs = await chrome.tabs.query({ active: true, windowId });
  return tabs && tabs[0] ? tabs[0].id : null;
}

// Account / Profile / Apply section switcher — shared by the segmented tabs
// themselves, the gear icon (jumps to Settings) and the avatar/name chip
// (jumps to Profile) — see their own click handlers below. There's no
// dropdown menu behind either of them any more.
// Which main tab (Apply/Profile/Account-Settings/Tabsync), and which
// sub-tab within Settings or Tabsync, was last viewed for a given Chrome
// tab — so switching Chrome tabs doesn't drag one tab's section choice
// onto another. Same per-tab-memory pattern as the modals above: recorded
// on every switch (user click or restore, both idempotent), read back by
// loadForTab to restore each Chrome tab's own section when it comes back
// on screen.
const MAIN_TAB_FOR = new Map(); // tabId -> 'apply' | 'apply2' | 'profile' | 'autofill' | 'account' | 'tabsync'
const SETTINGS_SUBTAB_FOR = new Map(); // tabId -> 'prompt' | 'filenames' | 'shortcuts'
const TABSYNC_SUBTAB_FOR = new Map(); // tabId -> 'linkedin' | 'manual'

function switchToTab(tab) {
  if (!els.mainTabs) return;
  const btn = els.mainTabs.querySelector(`.seg-tabs-btn[data-tab="${tab}"]`);
  if (!btn) return;
  for (const b of els.mainTabs.querySelectorAll(".seg-tabs-btn")) {
    const on = b === btn;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  }
  els.accountTabPanel?.classList.toggle("hidden", tab !== "account");
  els.profileTabPanel?.classList.toggle("hidden", tab !== "profile");
  els.applyTabPanel?.classList.toggle("hidden", tab !== "apply");
  els.apply2TabPanel?.classList.toggle("hidden", tab !== "apply2");
  els.tabsyncTabPanel?.classList.toggle("hidden", tab !== "tabsync");
  MAIN_TAB_FOR.set(TAB_ID, tab);
  // Re-derive from Apply's CURRENT selection every time this tab is
  // switched to — a one-way mirror (see populateProfileTabSelect's own
  // comment), so this always starts in sync no matter what was last
  // browsed here or changed on Apply since.
  if (tab === "profile") populateProfileTabSelect(selectedProfileId());
  // Re-read in case the user just came back from changing a shortcut on
  // Chrome's own chrome://extensions/shortcuts page — chrome.commands.onChanged
  // (below) already covers that while this panel stays open in the
  // background, but re-checking on every visit here is a cheap extra guard.
  if (tab === "account") {
    renderShortcuts();
    // Restores THIS tab's own remembered sub-tab (defaulting to Prompt,
    // the HTML's own default) — covers both a direct click on the Settings
    // main tab and loadForTab restoring a Chrome tab that was last showing
    // Settings on some other sub-tab.
    switchSettingsSubTab(SETTINGS_SUBTAB_FOR.get(TAB_ID) || "prompt");
  }
  if (tab === "tabsync") {
    // Same restore as Settings above — switchTabsyncSubTab's own body
    // already covers the LinkedIn Jobs refetch (see its comment), so no
    // separate fetch trigger is needed here any more.
    switchTabsyncSubTab(TABSYNC_SUBTAB_FOR.get(TAB_ID) || "linkedin");
  }
  if (tab === "apply2") {
    // Re-scans every time this tab is switched to — same "cheap, can't go
    // stale" reasoning the old modal-open trigger had (see
    // loadAutofillReview's own comment). Replaces openAutofillFormsModal,
    // removed along with the modal/#autofillViewFormsBtn it used to open.
    syncAutofillJobsiteChip();
    loadAutofillReview();
  }
}

// ============================================================
// "Form Questions" review list for whichever job application page is open
// in this Chrome tab — lives on the Apply tab (data-tab="apply2", see
// switchToTab), not a modal any more. Nothing here writes to the page
// until autofillReviewCommitBtn or a row's own Attach button is clicked —
// see AUTOFILL_REVIEW's own comment in autofill.js for exactly what a scan
// collects and why it's safe to call freely.
// ============================================================

// Known jobsite logos (jobsites/*.webp) for the Apply tab's own head
// — same hostname conventions the autofill adapters themselves use where
// one exists (greenhouse.js/workday.js/workable.js's own hostTest), written
// fresh here for the other five since there's no adapter (and so no
// hostTest) for a plain job board that doesn't need one for autofill
// purposes. Order doesn't matter — host suffixes don't overlap.
const JOBSITE_LOGOS = [
  { name: "Ashby", logo: "jobsites/ashby.webp", hostTest: (h) => /(^|\.)ashbyhq\.com$/i.test(h) },
  { name: "Dice", logo: "jobsites/dice.webp", hostTest: (h) => /(^|\.)dice\.com$/i.test(h) },
  { name: "Greenhouse", logo: "jobsites/greenhouse.webp", hostTest: (h) => /\.greenhouse\.io$/i.test(h) },
  { name: "Indeed", logo: "jobsites/indeed.webp", hostTest: (h) => /(^|\.)indeed\.com$/i.test(h) },
  { name: "LinkedIn", logo: "jobsites/linkedin.webp", hostTest: (h) => /(^|\.)linkedin\.com$/i.test(h) },
  { name: "Workable", logo: "jobsites/workable.webp", hostTest: (h) => /\.workable\.com$/i.test(h) },
  { name: "Workday", logo: "jobsites/workday.webp", hostTest: (h) => /myworkdayjobs\.com$/i.test(h) || /workday\./i.test(h) },
  { name: "ZipRecruiter", logo: "jobsites/ziprecruiter.webp", hostTest: (h) => /(^|\.)ziprecruiter\.com$/i.test(h) },
];

function detectJobsiteFromHostname(hostname) {
  const h = String(hostname || "").toLowerCase();
  for (const site of JOBSITE_LOGOS) {
    try { if (site.hostTest(h)) return site; } catch { /* a broken pattern shouldn't block the rest */ }
  }
  return null;
}

// Resolves the ACTIVE tab's own URL (not necessarily TAB_ID/the panel's own
// job tab — this always describes whatever page is actually on screen
// right now) against JOBSITE_LOGOS and paints the Apply tab's own head
// logo + name. Unrecognised host (or no host at all, e.g. a chrome://
// page) falls back to the generic briefcase glyph + "Job Site" rather than
// leaving it blank.
async function syncAutofillJobsiteChip() {
  let hostname = "";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    hostname = tab?.url ? new URL(tab.url).hostname : "";
  } catch { /* no active tab / restricted URL — falls back below */ }
  const site = detectJobsiteFromHostname(hostname);
  if (site) {
    if (els.autofillReviewLogo) {
      els.autofillReviewLogo.src = site.logo;
      els.autofillReviewLogo.alt = site.name;
      els.autofillReviewLogo.classList.remove("hidden");
    }
    els.autofillReviewLogoFallback?.classList.add("hidden");
    if (els.autofillReviewTitle) els.autofillReviewTitle.textContent = site.name;
  } else {
    els.autofillReviewLogo?.classList.add("hidden");
    els.autofillReviewLogoFallback?.classList.remove("hidden");
    if (els.autofillReviewTitle) els.autofillReviewTitle.textContent = "Job Site";
  }
}

// One row per detected contact field / free-text question, rebuilt from
// scratch on every loadAutofillReview() call (a fresh page scan
// invalidates any id a previous scan's rows were keyed by — same temp-id
// scheme detectQuestions' own elements get, see makeTempId). `status` is
// only ever 'loading'/'error' for a 'question' row waiting on (or that
// failed to get) its AI-generated answer; a 'contact' row is 'ready'
// immediately, resolved straight from the profile, no AI involved.
let AUTOFILL_REVIEW_ROWS = [];
let AUTOFILL_REVIEW_LOADING = false;
// Which tab+job this scan's current AUTOFILL_REVIEW_ROWS actually covers —
// lets a caller that doesn't need a GUARANTEED fresh scan (switching back
// to the Apply tab, or the Job tab's own button wanting a matching count)
// just reuse what's already loaded instead of re-scanning blind. Re-
// scanning blind on every visit was the actual bug behind two separate
// complaints: switching to the Apply tab after clicking Auto-fill on the
// Job tab re-scanned the now-partially-filled real page, and the detector
// correctly finds fewer EMPTY fields on a page that's partly filled —
// legitimate behavior, but it reads as "my fields disappeared" instead of
// "here's what you already filled, reviewable, plus what's still left"
// (applyAutofillResultToReview already flags the former — see its own
// comment — a blind re-scan right after just threw that away and rebuilt
// from the now-different page state instead).
let AUTOFILL_REVIEW_LOADED_KEY = null;

/** @param {boolean} force — true always re-scans (the explicit Refresh
 *  button, and the Attach button's own re-check after it just wrote the
 *  resume). Default false reuses the current rows when they already cover
 *  this exact tab+job and nothing in between (a scan completing, a tab
 *  switch) invalidated them. */
async function loadAutofillReview(force = false) {
  if (!els.autofillReviewList) return;
  const key = `${TAB_ID}|${STATE?.autoDetectedUrl || ""}`;
  if (!force && AUTOFILL_REVIEW_LOADED_KEY === key && !AUTOFILL_REVIEW_LOADING) {
    renderAutofillReviewList();
    return;
  }
  if (AUTOFILL_REVIEW_LOADING) return;
  AUTOFILL_REVIEW_LOADING = true;
  AUTOFILL_REVIEW_ROWS = [];
  els.autofillReviewEmpty?.classList.add("hidden");
  els.autofillReviewCommitBtn?.classList.add("hidden");
  els.autofillReviewList.innerHTML = '<p class="tab-panel-placeholder">Scanning the page…</p>';
  try {
    const profileId = selectedProfileId();
    const profile = profileId ? PROFILES_BY_ID.get(profileId) : null;
    if (!TAB_ID || !profile) {
      AUTOFILL_REVIEW_LOADED_KEY = null;
      // renderAutofillReviewList (not a manual innerHTML/empty-toggle here)
      // so the commit button also comes back with its icon+title intact —
      // same "always shown, generic fallback label" parity as the Job
      // tab's own #autofillBtn instead of staying stuck hidden (confirmed
      // real complaint: no job detected left just the bare hotkey chip
      // showing, button-less).
      renderAutofillReviewList();
      return;
    }
    const reply = await chrome.runtime.sendMessage({
      type: "AUTOFILL_REVIEW",
      tabId: TAB_ID,
      profile: autofillProfileFromBcd(profile),
    });
    if (!reply?.ok) {
      AUTOFILL_REVIEW_LOADED_KEY = null;
      renderAutofillReviewList();
      return;
    }
    const contactRows = (reply.contactFields || []).map((f) => ({
      id: f.id, kind: "contact", label: f.label, value: f.value, originalValue: f.value, status: "ready", order: f.order,
    }));
    // A question with real `options` (Ashby's own "button-group"/"radio"/
    // "checkbox" questions, see ashby-autofill.js's classifyAshbyField —
    // same `options` convention every other ported site's choice-kind
    // fields already use) is a FIXED-CHOICE question, not a free-text one —
    // routing it through the free-text AI-answer pipeline below
    // (fetchAutofillReviewAnswers) can only ever fail, since there's no
    // sensible "generated" answer for a question whose only valid answers
    // are a closed set of buttons (confirmed real complaint: "Couldn't
    // generate an answer" on Ashby's own "How did you hear about X?"
    // button-group question). kind:"choice" instead — renders the
    // question with its real options listed underneath (same as BidHub's
    // own review list does) and status:"ready" so it's never sent to the
    // AI-answer fetch at all.
    const questionRows = [...(reply.questions || []), ...(reply.inputQuestions || [])].map((q) => {
      const options = Array.isArray(q.options) ? q.options.filter(Boolean) : [];
      // status:"choice", not "ready" — "ready" is what renderAutofillReviewList's
      // own `fillable` filter uses to decide what the commit button actually
      // sends (see commitAutofillReview's answer: r.value payload). A choice
      // row has no .value and no real fill mechanism yet (that would mean
      // clicking the right button/radio on the page, a different action
      // entirely from the free-text AUTOFILL_FILL_QUESTIONS round trip) — it
      // must never be swept into that commit, just displayed for reference.
      return options.length > 0
        ? { id: q.id, kind: "choice", label: q.label, options, required: !!q.required, status: "choice", order: q.order }
        : { id: q.id, kind: "question", label: q.label, value: "", required: !!q.required, status: "loading", order: q.order };
    });
    // The resume slot used to always render as its own card pinned after
    // the whole list, regardless of where the actual file input sat on the
    // page — folded in here as an ordinary row (kind:'resume') instead, so
    // it sorts into its real position below alongside everything else. A
    // legacy (non-ported) site's response has no resumeOrder at all —
    // falls back to Number.POSITIVE_INFINITY, i.e. still last, same as
    // the old fixed-card behavior for those.
    const resumeRows = reply.hasResumeFileInput
      ? [{ id: "__resume__", kind: "resume", label: "Resume/CV", status: "resume", order: reply.resumeOrder }]
      : [];
    // Same treatment as resume — a detected cover-letter upload slot used
    // to be correctly found by dispatcher.js (classify() already splits it
    // out from contactFields/questions, mirroring resumeEntry) but never
    // actually reached this list, since handleReview() never passed along
    // a hasCoverLetterFileInput flag the way it always did for resume.
    const coverLetterRows = reply.hasCoverLetterFileInput
      ? [{ id: "__cover_letter__", kind: "resume", label: "Cover Letter", status: "resume", order: reply.coverLetterOrder }]
      : [];
    // Repeatable Education/Work-history sections (see
    // autofill/engine/section-hierarchy.js) — reply.sections is a flat
    // root/group/leaf list (BidHub's own "no special nested wire format"
    // design: a node's parentFieldId is all that's needed to rebuild the
    // tree). Nested here client-side, same as BidHub's panel does, into
    // one card per root carrying its own groups/leaves — not individual
    // rows in AUTOFILL_REVIEW_ROWS, since a leaf has no independent AI
    // regenerate/edit affordance (its value comes straight from the
    // profile's education/experience array, not a per-field AI call).
    const sectionNodes = reply.sections || [];
    const groupsByRoot = new Map();
    const leavesByGroup = new Map();
    for (const n of sectionNodes) {
      if (n.kind === "group") {
        if (!groupsByRoot.has(n.parentFieldId)) groupsByRoot.set(n.parentFieldId, []);
        groupsByRoot.get(n.parentFieldId).push(n);
      } else if (n.kind === "leaf") {
        if (!leavesByGroup.has(n.parentFieldId)) leavesByGroup.set(n.parentFieldId, []);
        leavesByGroup.get(n.parentFieldId).push(n);
      }
    }
    const existingSectionRows = new Map(AUTOFILL_REVIEW_ROWS.filter((r) => r.kind === "section").map((r) => [r.id, r]));
    const sectionRows = sectionNodes
      .filter((n) => n.kind === "root")
      .map((root) => ({
        id: root.fieldId,
        kind: "section",
        label: root.label,
        status: "section",
        order: root.order,
        // Preserve whatever collapse state the user already set for this
        // section across a reload (same id every scan — rootFieldId is a
        // fixed string like "educationHistory", not a per-scan temp id).
        collapsed: existingSectionRows.get(root.fieldId)?.collapsed ?? false,
        groups: (groupsByRoot.get(root.fieldId) || []).map((g) => ({
          label: g.label,
          leaves: (leavesByGroup.get(g.fieldId) || []).map((l) => ({ label: l.label, value: l.value })),
        })),
      }));
    const order = (r) => (typeof r.order === "number" ? r.order : Number.POSITIVE_INFINITY);
    AUTOFILL_REVIEW_ROWS = [...contactRows, ...questionRows, ...resumeRows, ...coverLetterRows, ...sectionRows].sort((a, b) => order(a) - order(b));
    AUTOFILL_REVIEW_LOADED_KEY = key;
    renderAutofillReviewList();
    // Only the free-text ones — kind:"choice" rows are already "ready"
    // (their fixed options, not an AI answer) and must never reach the
    // free-text AI-answer fetch.
    const freeTextQuestionRows = questionRows.filter((r) => r.kind === "question");
    if (freeTextQuestionRows.length) fetchAutofillReviewAnswers(freeTextQuestionRows.map((r) => r.id));
  } catch {
    AUTOFILL_REVIEW_LOADED_KEY = null;
    renderAutofillReviewList();
  } finally {
    AUTOFILL_REVIEW_LOADING = false;
  }
}

function autofillReviewRowHtml(row) {
  if (row.kind === "section") {
    const count = row.groups.length;
    const groupsHtml = row.groups.length
      ? row.groups
          .map(
            (g) => `
        <div class="autofill-section__group">
          <div class="autofill-section__group-title">${escapeHtml(g.label)}</div>
          ${g.leaves
            .map(
              (l) => `
          <div class="autofill-section__leaf">
            <span class="autofill-section__leaf-label">${escapeHtml(l.label)}</span>
            <span class="autofill-section__leaf-value">${escapeHtml(l.value) || "—"}</span>
          </div>`
            )
            .join("")}
        </div>`
          )
          .join("")
      : '<span class="autofill-qrow__hint">No entries detected on this page</span>';
    return `
    <div class="autofill-qrow autofill-section${row.collapsed ? " autofill-section--collapsed" : ""}" data-row-id="${escapeHtml(row.id)}">
      <div class="autofill-section__header">
        <div class="autofill-qrow__label">${escapeHtml(row.label)}${count ? `<span class="autofill-section__count">${count} ${count === 1 ? "entry" : "entries"}</span>` : ""}</div>
        <button type="button" class="icon-btn icon-btn--sm autofill-section__toggle" title="${row.collapsed ? "Expand" : "Collapse"}">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="${row.collapsed ? "9 18 15 12 9 6" : "6 9 12 15 18 9"}" />
          </svg>
        </button>
      </div>
      <div class="autofill-section__body">${groupsHtml}</div>
    </div>`;
  }
  if (row.kind === "choice") {
    // Fixed-choice question (Ashby's own "button-group"/"radio"/"checkbox"
    // questions — see ashby-autofill.js's classifyAshbyField) — the real
    // options listed below the question, same as BidHub's own review list
    // shows them (confirmed real complaint: Banana only showed the bare
    // question text). Reference only for now, not yet clickable — picking
    // one and writing it to the page is a different action (clicking the
    // actual button/radio control) from every other row's free-text
    // AUTOFILL_FILL_QUESTIONS commit, not wired up here.
    const optionsHtml = row.options.map((opt) => `<span class="autofill-choice-pill">${escapeHtml(opt)}</span>`).join("");
    return `
    <div class="autofill-qrow autofill-qrow--choice" data-row-id="${escapeHtml(row.id)}">
      <div class="autofill-qrow__label">${escapeHtml(row.label)}${row.required ? '<span class="autofill-qrow__required" aria-hidden="true" title="Required">*</span>' : ""}</div>
      <div class="autofill-choice-options">${optionsHtml}</div>
    </div>`;
  }
  if (row.kind === "resume") {
    const filled = row.filledOnPage === true;
    return `
    <div class="autofill-qrow autofill-qrow--resume${filled ? " autofill-qrow--filled" : ""}" data-row-id="${escapeHtml(row.id)}">
      <div class="autofill-qrow__label">${escapeHtml(row.label)}${row.required ? '<span class="autofill-qrow__required" aria-hidden="true" title="Required">*</span>' : ""}${filled ? '<span class="autofill-qrow__filled-badge">✓ Filled</span>' : ""}</div>
      <div class="autofill-qrow__answer"><span class="autofill-qrow__hint">Detected on this page</span></div>
      <div class="autofill-qrow__actions">
        <button type="button" class="folder-btn autofill-qrow__attach" title="Run Auto-fill to generate and attach the resume">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <span class="btn-text">Attach</span>
        </button>
      </div>
    </div>`;
  }
  const loading = row.status === "loading";
  const errored = row.status === "error";
  const filled = row.filledOnPage === true;
  let valueHtml;
  if (loading) {
    valueHtml = '<span class="autofill-qrow__hint">Generating…</span>';
  } else if (row.editing) {
    valueHtml = `<textarea class="autofill-qrow__input" rows="3">${escapeHtml(row.value)}</textarea>`;
  } else if (errored && !row.value) {
    valueHtml = '<span class="autofill-qrow__hint autofill-qrow__hint--error">Couldn’t generate an answer — try the refresh icon.</span>';
  } else {
    valueHtml = `<span class="autofill-qrow__value">${escapeHtml(row.value) || "—"}</span>`;
  }
  const refreshTitle = row.kind === "contact" ? "Reset to the profile's value" : "Regenerate";
  return `
    <div class="autofill-qrow${loading ? " autofill-qrow--loading" : ""}${filled ? " autofill-qrow--filled" : ""}" data-row-id="${escapeHtml(row.id)}">
      <div class="autofill-qrow__label">${escapeHtml(row.label)}${row.required ? '<span class="autofill-qrow__required" aria-hidden="true" title="Required">*</span>' : ""}${filled ? '<span class="autofill-qrow__filled-badge">✓ Filled</span>' : ""}</div>
      <div class="autofill-qrow__answer">${valueHtml}</div>
      <div class="autofill-qrow__actions">
        <button type="button" class="icon-btn icon-btn--sm autofill-qrow__edit" title="${row.editing ? "Save" : "Edit"}"${loading ? " disabled" : ""}>
          ${row.editing
            ? '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>'
            : '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>'}
        </button>
        <button type="button" class="icon-btn icon-btn--sm autofill-qrow__refresh" title="${refreshTitle}"${loading ? " disabled" : ""}>
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
            <path d="M21 3v5h-5" />
          </svg>
        </button>
      </div>
    </div>`;
}

function renderAutofillReviewList() {
  if (!els.autofillReviewList) return;
  const hasAnything = AUTOFILL_REVIEW_ROWS.length > 0;
  els.autofillReviewEmpty?.classList.toggle("hidden", hasAnything || AUTOFILL_REVIEW_LOADING);
  els.autofillReviewList.innerHTML = AUTOFILL_REVIEW_ROWS.map(autofillReviewRowHtml).join("");
  // filledOnPage rows (confirmed by the real runAutofill — see
  // applyAutofillResultToReview) are excluded here so the count/commit only
  // ever covers what's actually still left to do. `fillable` is what
  // clicking the button actually WRITES (only a resolved "ready" row has a
  // value to commit) — `totalCount` is what the button LABEL shows, every
  // row in the list (contact, question, resume, section alike), so the
  // number on the button matches what the user is actually looking at
  // instead of silently only counting the subset that happened to resolve
  // without AI help.
  const fillable = AUTOFILL_REVIEW_ROWS.filter((r) => r.status === "ready" && r.id && r.filledOnPage !== true);
  const totalCount = AUTOFILL_REVIEW_ROWS.filter((r) => r.filledOnPage !== true).length;
  if (els.autofillReviewCommitBtn) {
    // Same convention as the Job tab's own #autofillBtn
    // (refreshAutofillButtonTitle) — always shown with its icon+title,
    // falling back to a generic label instead of disappearing entirely
    // when there's nothing to count yet (no job site detected, empty tab).
    setButtonText(
      els.autofillReviewCommitBtn,
      totalCount > 0 ? `Autofill ${totalCount} Field${totalCount === 1 ? "" : "s"}` : "Autofill Forms",
    );
    els.autofillReviewCommitBtn.classList.remove("hidden");
  }
  // Keep focus on whichever row just entered edit mode — re-rendering the
  // whole list (the simplest way to keep every row's markup in sync with
  // its state) would otherwise drop keyboard focus on every edit toggle.
  const editingRow = AUTOFILL_REVIEW_ROWS.find((r) => r.editing);
  if (editingRow) {
    const ta = els.autofillReviewList.querySelector(".autofill-qrow__input");
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }
}


// Batch AI fetch for one or more 'question' rows — same /answer-questions
// endpoint and request shape the Job tab's own Autofill button already
// uses (see runAutofill), just without ever writing the result anywhere
// until the user explicitly commits it (autofillReviewCommitBtn) or it's
// shown here for review/edit first. Used both for the initial fetch (every
// question row at once) and a single-row regenerate (array of one).
async function fetchAutofillReviewAnswers(rowIds) {
  const rows = rowIds.map((id) => AUTOFILL_REVIEW_ROWS.find((r) => r.id === id)).filter(Boolean);
  if (!rows.length) return;
  const profileId = selectedProfileId();
  if (!profileId) {
    rows.forEach((r) => { r.status = "error"; });
    renderAutofillReviewList();
    return;
  }
  try {
    const jd = (STATE?.jobText || els.jobText?.value || "").trim();
    const jobData = STATE?.info?.job_data || {
      company_name: STATE?.companyName || els.companyName?.value?.trim() || "",
      job_title: STATE?.roleTitle || els.roleTitle?.value?.trim() || "",
      job_description: jd,
    };
    const ar = await apiFetch("/answer-questions", {
      method: "POST",
      body: JSON.stringify({
        profileId,
        questions: rows.map((r) => r.label),
        job_data: jobData,
        resume: STATE?.info?.resume || null,
        ...currentKeySelection(),
      }),
    });
    const answers = Array.isArray(ar?.answers) ? ar.answers : [];
    rows.forEach((r, i) => {
      r.value = String(answers[i]?.answer || "").trim();
      r.status = r.value ? "ready" : "error";
    });
  } catch {
    rows.forEach((r) => { r.status = "error"; });
  }
  renderAutofillReviewList();
}

async function regenerateAutofillReviewRow(rowId) {
  const row = AUTOFILL_REVIEW_ROWS.find((r) => r.id === rowId);
  if (!row || row.kind !== "question") return;
  row.status = "loading";
  row.editing = false;
  renderAutofillReviewList();
  await fetchAutofillReviewAnswers([rowId]);
}

// A contact row's own "refresh" is a pure local revert (no AI, no network —
// its value was only ever the profile's own, resolved once when the page
// was scanned) rather than a regenerate, unlike a question row's.
function resetAutofillReviewContactRow(rowId) {
  const row = AUTOFILL_REVIEW_ROWS.find((r) => r.id === rowId);
  if (!row || row.kind !== "contact") return;
  row.value = row.originalValue;
  row.editing = false;
  renderAutofillReviewList();
}

function toggleAutofillReviewRowEdit(rowId, rowEl) {
  const row = AUTOFILL_REVIEW_ROWS.find((r) => r.id === rowId);
  if (!row || row.status === "loading") return;
  if (row.editing) {
    const ta = rowEl?.querySelector(".autofill-qrow__input");
    if (ta) row.value = ta.value;
    row.editing = false;
  } else {
    // Only one row editable at a time — keeps the "which textarea has my
    // cursor" question unambiguous after a re-render.
    AUTOFILL_REVIEW_ROWS.forEach((r) => { r.editing = false; });
    row.editing = true;
  }
  renderAutofillReviewList();
}

// Writes every ready row's current (AI-generated-then-possibly-edited, or
// profile-resolved) value into the page — same AUTOFILL_FILL_QUESTIONS
// write-back the Job tab's own Autofill button uses for its free-text
// questions, just carrying the review list's contact rows too (each got
// the same stable temp id a question gets, see reviewSnapshot in
// autofill.js) so an edited contact override is written the same way.
// Incremented by stopCommitAutofillReview to invalidate an in-flight run —
// AUTOFILL_FILL_QUESTIONS is one fast request/reply round trip, not a
// cancellable stream, so "stop" can't un-send it (same caveat Generate's
// own Stop has for a request already in flight); what it DOES do is make
// the UI stop waiting on/reacting to that reply the moment it arrives.
let COMMIT_REVIEW_RUN_ID = 0;

async function commitAutofillReview() {
  const rows = AUTOFILL_REVIEW_ROWS.filter((r) => r.status === "ready" && r.id && r.filledOnPage !== true);
  if (!rows.length || !TAB_ID || !els.autofillReviewCommitBtn) return;
  const runId = ++COMMIT_REVIEW_RUN_ID;
  els.autofillReviewCommitBtn.disabled = true;
  setButtonText(els.autofillReviewCommitBtn, "Filling…");
  // Same swap-in-for-Download language Generate's own #stopGenerateBtn
  // uses — shown only while this run is actually in flight.
  els.autofillReviewStopWrap?.classList.remove("hidden");
  // Same clip-path-reveal mechanism as the Job tab's own Autofill button
  // (setAutofillProgress/stopAutofillProgress) — a separate span/state since
  // this is a different button, driven off this one request/reply round
  // trip instead of runAutofill's multi-stage checkpoints.
  if (els.autofillReviewCommitFill) els.autofillReviewCommitFill.style.clipPath = "inset(0 35% 0 0)";
  let ok = false;
  try {
    const reply = await chrome.runtime.sendMessage({
      type: "AUTOFILL_FILL_QUESTIONS",
      tabId: TAB_ID,
      answers: rows.map((r) => ({ id: r.id, label: r.label, answer: r.value })),
    });
    // Stopped while this was in flight — stopCommitAutofillReview already
    // reset the UI; don't let a late reply undo that or double-toast.
    if (runId !== COMMIT_REVIEW_RUN_ID) return;
    if (reply?.ok) {
      ok = true;
      const failedNote = reply.failed ? `, ${reply.failed} couldn’t be matched on the page` : "";
      panelToast(`Filled ${reply.filled || 0} field${reply.filled === 1 ? "" : "s"}${failedNote}.`);
      // Best-effort: we don't get a per-row result back, so mark every row
      // in THIS batch filled only when nothing was reported as failed —
      // same conservative "whole batch or nothing" rule
      // applyAutofillResultToReview uses for the Autofill button's own run.
      if (!reply.failed) {
        rows.forEach((r) => { r.filledOnPage = true; });
      }
    } else {
      panelToast("Couldn’t fill the page — try again.", "warning");
    }
  } catch {
    if (runId !== COMMIT_REVIEW_RUN_ID) return;
    panelToast("Couldn’t reach the page — try again.", "warning");
  } finally {
    if (runId === COMMIT_REVIEW_RUN_ID) {
      els.autofillReviewCommitBtn.disabled = false;
      els.autofillReviewStopWrap?.classList.add("hidden");
      if (els.autofillReviewCommitFill) {
        els.autofillReviewCommitFill.style.clipPath = ok ? "inset(0 0 0 0)" : "inset(0 100% 0 0)";
      }
      renderAutofillReviewList();
    }
  }
}

function stopCommitAutofillReview() {
  if (COMMIT_REVIEW_RUN_ID === 0) return; // nothing running
  COMMIT_REVIEW_RUN_ID++; // invalidate — commitAutofillReview's own reply handler now no-ops
  if (els.autofillReviewCommitBtn) els.autofillReviewCommitBtn.disabled = false;
  els.autofillReviewStopWrap?.classList.add("hidden");
  if (els.autofillReviewCommitFill) els.autofillReviewCommitFill.style.clipPath = "inset(0 100% 0 0)";
  renderAutofillReviewList();
}

// Reconciles AUTOFILL_REVIEW_ROWS against what the REAL Basic Auto-fill run
// (runAutofill — a completely separate content-script round trip from this
// tab's own preview-only AUTOFILL_REVIEW scan) actually wrote to the page.
// Called after the Job tab's own Autofill button click (see its own call
// site) so the Form Questions modal, if the user opens it afterward,
// reflects what actually got filled rather than just the original preview.
//
// Contact rows match 1:1 by field KEY — both sides share the exact same
// core/values.js vocabulary ("email", "first_name", …), so this is exact,
// not a guess. Free-text question rows can only be marked filled as a whole
// BATCH: AUTOFILL_FILL_QUESTIONS' reply is an aggregate filled/failed COUNT,
// not a per-question result, so summary.questionsFilledOk (set in
// runAutofill, only when that whole batch had zero failures) is the most
// precise signal available — a row never gets a fabricated "filled" claim
// just because its label resembles something the run touched.
function applyAutofillResultToReview(summary) {
  if (!summary || !AUTOFILL_REVIEW_ROWS.length) return;
  const filledKeys = new Set((summary.filled || []).map((f) => f.key));
  const presetLabels = new Set((summary.presetFilled || []).map((p) => (p.label || "").trim().toLowerCase()));
  const okQuestionLabels = new Set((summary.questionsFilledOk || []).map((l) => String(l).trim().toLowerCase()));
  for (const row of AUTOFILL_REVIEW_ROWS) {
    if (row.kind === "contact") {
      if (filledKeys.has(row.id)) row.filledOnPage = true;
    } else {
      const label = (row.label || "").trim().toLowerCase();
      if (presetLabels.has(label) || okQuestionLabels.has(label)) row.filledOnPage = true;
    }
  }
  renderAutofillReviewList();
}

// Settings' own second-level tabs — Prompt / File Names / Shortcuts. Same
// active-class + hidden-panel pattern as switchToTab above, one level down.
function switchSettingsSubTab(subtab) {
  if (!els.settingsSubTabs) return;
  const btn = els.settingsSubTabs.querySelector(`.seg-tabs-btn[data-subtab="${subtab}"]`);
  if (!btn) return;
  for (const b of els.settingsSubTabs.querySelectorAll(".seg-tabs-btn")) {
    const on = b === btn;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  }
  els.settingsPromptPanel?.classList.toggle("hidden", subtab !== "prompt");
  els.settingsFilenamesPanel?.classList.toggle("hidden", subtab !== "filenames");
  els.settingsShortcutsPanel?.classList.toggle("hidden", subtab !== "shortcuts");
  SETTINGS_SUBTAB_FOR.set(TAB_ID, subtab);
  if (subtab === "prompt") {
    renderApplySettingsReadOnly();
    refreshBulletCountTokenStatus();
  }
}

// Tabsync's own second-level tabs — LinkedIn Jobs (the org's not-yet-applied
// board rows) / Links (paste your own list). Same pattern as
// switchSettingsSubTab above; "linkedin" is the default so the number the
// outer Tabsync tab's own badge advertises has somewhere to actually show
// its rows. Re-fetches the LinkedIn Jobs list every time that sub-tab is
// opened (same reasoning as refreshBulletCountTokenStatus — cheap, and
// can't go stale while the panel stays open).
let TABSYNC_SUBTAB = "linkedin";
function switchTabsyncSubTab(subtab) {
  if (!els.tabsyncSubTabs) return;
  const btn = els.tabsyncSubTabs.querySelector(`.seg-tabs-btn[data-subtab="${subtab}"]`);
  if (!btn) return;
  for (const b of els.tabsyncSubTabs.querySelectorAll(".seg-tabs-btn")) {
    const on = b === btn;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  }
  TABSYNC_SUBTAB = subtab;
  TABSYNC_SUBTAB_FOR.set(TAB_ID, subtab);
  els.tabsyncLinkedinPanel?.classList.toggle("hidden", subtab !== "linkedin");
  els.tabsyncManualPanel?.classList.toggle("hidden", subtab !== "manual");
  updateTabsyncStats();
  updateOpenTabsBtnLabel();
  if (subtab === "linkedin") refreshTabsyncLinkedinJobs();
}

// Job Description / Cover Letter: both collapse to a short, click-to-open
// summary (readonly, ellipsised). Clicking one REPARENTS that same textarea
// node into the shared #fieldModalBackdrop's #fieldModalBody — not a clone,
// the actual element, so its value/scroll/undo-history need no syncing — and
// dims everything behind it. A comment node left in its original spot marks
// where to put it back on close. Only one field's modal can be open at a
// time (there's one shared modal), which matches the interaction anyway.
let fieldModalOrigin = null; // { ta, placeholder } while a field is inside the modal

// Which field ('job' | 'cover' | 'resume') was expanded for a given tab —
// there's only one shared textarea per field type (reused by every tab), so
// the modal can't stay literally mounted through a tab switch the way a
// plain text modal can. Instead, a switch-away does a full close (the node
// has to go back to its slot so the NEW tab's collapsed row has something to
// show) but keeps this tab's entry here, and loadForTab reopens it — with
// that tab's own content, already reloaded by then — the moment the user
// switches back. See reopenFieldModalIfPending / hideFieldModalForTabSwitch.
const FIELD_MODAL_OPEN = new Map();

function isFieldModalOpen() {
  return !!els.fieldModalBackdrop && !els.fieldModalBackdrop.classList.contains("hidden");
}

function expandField(ta, title, fieldKey) {
  const body = els.fieldModalBody;
  const card = ta?.closest(".tab-panel");
  if (!ta || !body || !card || ta.disabled || isFieldModalOpen()) return;
  const placeholder = document.createComment("field-modal-origin");
  ta.parentNode.insertBefore(placeholder, ta);
  fieldModalOrigin = { ta, placeholder };
  if (els.fieldModalTitle) els.fieldModalTitle.textContent = title;
  body.appendChild(ta);
  ta.classList.remove("field-collapsed");
  ta.classList.add("field-modal__textarea");
  // Resume stays read-only in the modal too — it's a generated rendering,
  // not a directly-authored field, unlike Job Description/Cover Letter.
  if (ta !== els.resumeText) ta.removeAttribute("readonly");
  els.fieldModalBackdrop.classList.remove("hidden");
  ta.focus();
  if (fieldKey) FIELD_MODAL_OPEN.set(TAB_ID, fieldKey);
}

// Shared DOM teardown used by both an explicit close and a tab-switch-away —
// the physical reparent-back has to happen either way. What differs is
// whether FIELD_MODAL_OPEN remembers it (see the two callers below).
function hideFieldModalDom() {
  if (fieldModalOrigin) {
    const { ta, placeholder } = fieldModalOrigin;
    placeholder.parentNode.replaceChild(ta, placeholder);
    ta.classList.remove("field-modal__textarea");
    ta.classList.add("field-collapsed");
    ta.setAttribute("readonly", "");
    ta.blur();
    fieldModalOrigin = null;
  }
  if (els.fieldModalBackdrop) els.fieldModalBackdrop.classList.add("hidden");
}

// Explicit user dismissal (back button, backdrop click, or a field being
// cleared out from under it) — this tab no longer wants it reopened.
function closeFieldModal() {
  FIELD_MODAL_OPEN.delete(TAB_ID);
  hideFieldModalDom();
}

// Tab-switch-away only: same DOM teardown, but keeps the tab's entry in
// FIELD_MODAL_OPEN so loadForTab can reopen it on return.
function hideFieldModalForTabSwitch() {
  hideFieldModalDom();
}

function reopenFieldModalIfPending(tabId) {
  const field = FIELD_MODAL_OPEN.get(tabId);
  if (!field) return;
  if (field === "job") expandJobDescription();
  else if (field === "cover") expandCoverLetter();
  else if (field === "resume") expandResume();
}

// Only closes the modal if it's currently showing THIS field — a field
// going disabled/empty (e.g. a fresh Generate run clearing the old cover
// letter) shouldn't blow away a different field's modal the user has open.
function collapseFieldIfOpen(ta) {
  if (fieldModalOrigin?.ta === ta) closeFieldModal();
}

function expandJobDescription() {
  expandField(els.jobText, "Job Description", "job");
}
function expandCoverLetter() {
  expandField(els.coverText, "Cover Letter", "cover");
}
function collapseCoverLetter() {
  collapseFieldIfOpen(els.coverText);
}
function expandResume() {
  expandField(els.resumeText, "Resume", "resume");
}
function collapseResume() {
  collapseFieldIfOpen(els.resumeText);
}

// Ask-anything: same click-to-grow / back-to-collapse pattern as Job
// Description above, just growing UPWARD from the composer's own position
// instead of downward from the field's — the input sits near the bottom of
// the card, so expanding has to extend the TOP edge, not the bottom one.
// Anchored to the header's own bottom edge (always on-screen, unlike the
// card's own top edge, which can be scrolled out of view) rather than the
// card's top, so this is safe to trigger no matter how far the card is
// scrolled when the user focuses the input.
// Expands #qaOverlay (the thread + its head) into a position:fixed panel
// ABOVE the composer, matching the card's (.tab-panel, the "white board")
// own width — NOT the composer itself, which is a separate sibling and
// never gets touched: its size and position stay exactly where they always
// are, focused or not. Only 70% of the header-to-composer space, bottom
// flush against the composer (so the empty 30% opens up above, not as a gap
// against the composer) — the full span read as too tall.
let qaCollapseTimer = null;
let qaCollapseFinish = null;

// Which tabs currently have the Ask Anything overlay expanded — a
// switch-away visually collapses it (see hideQAForTabSwitch) without
// forgetting, so loadForTab can silently re-expand it on return; only an
// explicit collapse (back button, click-outside) removes a tab from this.
const QA_EXPANDED_FOR = new Set();

function expandQA() {
  const overlay = els.qaOverlay;
  const composer = els.qaComposer;
  const card = overlay?.closest(".tab-panel");
  if (!overlay || !composer || !card || overlay.classList.contains("qa-overlay--expanded")) return;
  // A reopen while the previous close's finish() is still pending (rapid
  // close-then-reopen) would otherwise wipe this fresh expand's inline
  // styles/class out from under it — either via the fallback timeout, or via
  // a transitionend the interrupted close never got to consume.
  clearTimeout(qaCollapseTimer);
  if (qaCollapseFinish) {
    overlay.removeEventListener("transitionend", qaCollapseFinish);
    qaCollapseFinish = null;
  }
  const composerRect = composer.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const header = document.querySelector(".app-header");
  const topAnchor = (header ? header.getBoundingClientRect().bottom : 0) + 8;
  const fullHeight = composerRect.top - topAnchor;
  overlay.style.top = composerRect.top - fullHeight * 0.7 + "px";
  overlay.style.bottom = window.innerHeight - composerRect.top + "px";
  overlay.style.left = cardRect.left + "px";
  overlay.style.width = cardRect.width + "px";
  overlay.classList.add("qa-overlay--expanded");
  els.qaBackBtn?.classList.remove("hidden");
  // Slide/fade in: .qa-overlay--expanded's own base state (see panel.css) is
  // the "closed" look (translateY + opacity 0); flipping to --open one paint
  // later is what the transition actually animates from. A single rAF can
  // still land before the browser's first paint of the new inline styles, so
  // this waits two.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => overlay.classList.add("qa-overlay--open"));
  });
  QA_EXPANDED_FOR.add(TAB_ID);
}

// Explicit dismissal (back button, click-outside) — animated, and forgets
// this tab so it stays collapsed on return.
function collapseQA() {
  QA_EXPANDED_FOR.delete(TAB_ID);
  animateCollapseQA();
}

function animateCollapseQA() {
  const overlay = els.qaOverlay;
  if (!overlay || !overlay.classList.contains("qa-overlay--expanded")) return;
  overlay.classList.remove("qa-overlay--open");
  els.qaBackBtn?.classList.add("hidden");
  // Wait for the slide-down transition to finish before actually tearing
  // down position:fixed — a timeout fallback in case transitionend never
  // fires (reduced motion, interrupted transition) so this never gets stuck
  // expanded.
  const finish = () => {
    overlay.style.top = "";
    overlay.style.bottom = "";
    overlay.style.left = "";
    overlay.style.width = "";
    overlay.classList.remove("qa-overlay--expanded");
    qaCollapseFinish = null;
  };
  qaCollapseFinish = finish;
  overlay.addEventListener("transitionend", finish, { once: true });
  qaCollapseTimer = setTimeout(finish, 250);
}

// Tab-switch-away only: an instant (non-animated) teardown — the panel
// content is about to be swapped for the new tab anyway, so there's nothing
// for a slide-down transition to be seen against. Keeps QA_EXPANDED_FOR so
// loadForTab can silently re-expand it if the user comes back to this tab.
function hideQAForTabSwitch() {
  const overlay = els.qaOverlay;
  if (!overlay) return;
  clearTimeout(qaCollapseTimer);
  if (qaCollapseFinish) {
    overlay.removeEventListener("transitionend", qaCollapseFinish);
    qaCollapseFinish = null;
  }
  overlay.classList.remove("qa-overlay--open", "qa-overlay--expanded");
  overlay.style.top = "";
  overlay.style.bottom = "";
  overlay.style.left = "";
  overlay.style.width = "";
  els.qaBackBtn?.classList.add("hidden");
}

function reopenQAIfPending(tabId) {
  if (QA_EXPANDED_FOR.has(tabId)) expandQA();
}

// ============================================================
// Tabsync — copy every open tab's URL to the clipboard, or paste a list
// back in to reopen them. Ported from the standalone "Tab Studio" extension
// (Tabsync/popup.js), trimmed to just these two actions — no theme toggle,
// no keyboard shortcut, no separate clean-up/clear buttons.
// ============================================================

/** Normalizes one URL: adds https:// to a bare domain, strips the hash and
 *  query string, drops a trailing slash, and drops a trailing "/apply" or
 *  "/application" segment so the same job posting linked two different ways
 *  (with or without that suffix) is treated as one URL. Returns null for
 *  anything that isn't a usable http(s) URL. */
function tabsyncNormalizeUrl(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  const tryParse = (s) => {
    try {
      const u = new URL(s);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      u.hash = "";
      u.search = "";
      let p = u.pathname || "";
      if (p.endsWith("/") && p !== "/") p = p.replace(/\/+$/, "");
      p = p.replace(/\/(application|apply)$/i, "");
      u.pathname = p || "/";
      return u.toString();
    } catch {
      return null;
    }
  };
  return tryParse(trimmed) || tryParse(`https://${trimmed}`);
}

/** Tabs that are never useful in a "job postings I have open" list — mail/
 *  calendar/docs and sites this was tuned against — dropped from Copy Open
 *  Tabs (not from pasted/typed input; that always opens exactly what's
 *  pasted). */
function tabsyncIsExcludedUrl(url) {
  const n = tabsyncNormalizeUrl(url);
  if (!n) return true;
  try {
    const hostname = new URL(n).hostname.toLowerCase();
    if (hostname.endsWith("linkedin.com")) return true;
    if (["mail.google.com", "calendar.google.com", "docs.google.com"].includes(hostname)) return true;
    if (hostname.endsWith("remoterocketship.com")) return true;
    return false;
  } catch {
    return true;
  }
}

/** Splits pasted text on newlines OR commas (the placeholder promises both),
 *  trims, normalizes, and dedupes. */
function tabsyncParseLinks(text) {
  const parts = String(text || "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const valid = [];
  const invalid = [];
  const seen = new Set();
  for (const p of parts) {
    const n = tabsyncNormalizeUrl(p);
    if (!n) {
      invalid.push(p);
      continue;
    }
    if (seen.has(n)) continue;
    seen.add(n);
    valid.push(n);
  }
  return { valid, invalid, rawCount: parts.length };
}

// Runs after a paste into the Links textarea: rewrites the field down to
// just the valid, unique URLs (tabsyncParseLinks's own `valid` list — same
// normalize+dedupe it already does silently when opening tabs, now actually
// reflected in the textarea instead of leaving raw duplicates/invalid lines
// sitting there), with a toast saying how many got removed and why.
function dedupeTabsyncInput() {
  const el = els.tabsyncInput;
  if (!el) return;
  const { valid, invalid, rawCount } = tabsyncParseLinks(el.value);
  if (rawCount === 0 || valid.length === rawCount) return; // nothing to clean up
  el.value = valid.join("\n");
  updateTabsyncStats();
  const dupCount = rawCount - valid.length - invalid.length;
  const reasons = [];
  if (dupCount > 0) reasons.push(`${dupCount} duplicate${dupCount === 1 ? "" : "s"}`);
  if (invalid.length > 0) reasons.push(`${invalid.length} invalid`);
  panelToast(`${rawCount} URLs filtered to ${valid.length} (${reasons.join(", ")} removed)`);
}

// LinkedIn Jobs' own count now lives on the Open Tabs button itself (see
// updateOpenTabsBtnLabel) rather than here — this only still tracks Links.
function updateTabsyncStats() {
  if (els.tabsyncLinksStats) {
    const { valid, invalid, rawCount } = tabsyncParseLinks(els.tabsyncInput?.value);
    if (rawCount === 0) {
      els.tabsyncLinksStats.textContent = "0 links";
    } else {
      const base = `${valid.length} link${valid.length === 1 ? "" : "s"}`;
      els.tabsyncLinksStats.textContent = invalid.length > 0 ? `${base} • ${invalid.length} invalid` : base;
    }
  }
}

// The org's not-yet-applied LinkedIn Jobs board rows (GET
// /linkedin-positions/unapplied — same visibility/filter as the
// unapplied-count badge, but the actual rows). Re-fetched every time the
// LinkedIn Jobs sub-tab is opened (see switchTabsyncSubTab), not polled in
// the background — unlike the lightweight count, this is the full list and
// only needed while a viewer is actually looking at it.
// Every unapplied job the server returned — always the FULL org-wide set,
// never narrowed by the Location/Role filters below (those only decide what
// TABSYNC_LINKEDIN_JOBS, the filtered view, shows — see
// applyTabsyncLinkedinFilter). Re-fetched on open and on the
// "linkedin:unapplied-changed" socket push.
let TABSYNC_LINKEDIN_JOBS_ALL = [];
// The filtered-down view actually rendered/paginated/opened — everything
// downstream (renderTabsyncLinkedinList, tabsyncLinkedinPageItems,
// openLinkedinJobTabs, updateTabsyncStats) reads this one, same as before
// the filters existed.
let TABSYNC_LINKEDIN_JOBS = [];
// 1-based. Reset to 1 whenever the filtered view changes — see
// applyTabsyncLinkedinFilter.
let TABSYNC_LINKEDIN_PAGE = 1;
const TABSYNC_PAGE_SIZE = 10;

// Location dropdown options — built from whatever countries are actually
// present in the currently-loaded unapplied jobs (not a separate org-wide
// /linkedin-positions/filters call), so there's never a pickable option
// that would filter the list down to zero.
function tabsyncLinkedinCountryOptionsHtml(jobs) {
  const countries = Array.from(new Set(jobs.map((j) => j.country).filter(Boolean))).sort();
  return [
    '<option value="">All locations</option>',
    ...countries.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`),
  ].join("");
}

// Location: exact match. Role: case-insensitive substring — same two
// semantics the main app's own LinkedIn Jobs page filters use.
function applyTabsyncLinkedinFilter() {
  const country = els.tabsyncLinkedinCountryFilter?.value || "";
  const role = (els.tabsyncLinkedinRoleFilter?.value || "").trim().toLowerCase();
  TABSYNC_LINKEDIN_JOBS = TABSYNC_LINKEDIN_JOBS_ALL.filter((j) => {
    if (country && j.country !== country) return false;
    if (role && !(j.role || "").toLowerCase().includes(role)) return false;
    return true;
  });
  TABSYNC_LINKEDIN_PAGE = 1;
  renderTabsyncLinkedinList();
  if (TABSYNC_SUBTAB === "linkedin") updateTabsyncStats();
}

async function refreshTabsyncLinkedinJobs() {
  if (!els.tabsyncLinkedinList) return;
  els.tabsyncLinkedinList.innerHTML = '<p class="tab-panel-placeholder">Loading…</p>';
  els.tabsyncLinkedinPager?.classList.add("hidden");
  try {
    const r = await apiFetch("/linkedin-positions/unapplied");
    TABSYNC_LINKEDIN_JOBS_ALL = Array.isArray(r?.items) ? r.items : [];
  } catch {
    TABSYNC_LINKEDIN_JOBS_ALL = [];
    TABSYNC_LINKEDIN_JOBS = [];
    els.tabsyncLinkedinList.innerHTML = '<p class="tab-panel-placeholder">Couldn’t load — try again.</p>';
    if (TABSYNC_SUBTAB === "linkedin") updateTabsyncStats();
    updateOpenTabsBtnLabel();
    return;
  }
  if (els.tabsyncLinkedinCountryFilter) {
    const prev = els.tabsyncLinkedinCountryFilter.value;
    els.tabsyncLinkedinCountryFilter.innerHTML = tabsyncLinkedinCountryOptionsHtml(TABSYNC_LINKEDIN_JOBS_ALL);
    els.tabsyncLinkedinCountryFilter.value = prev;
  }
  applyTabsyncLinkedinFilter();
}

// Simplified inline SVG flags, ported from the main app's own Flag.jsx —
// regional-indicator emoji (🇺🇸) don't render on Windows (no flag glyphs in
// the system font), so a plain 🌎 for the default case is the only emoji
// safe to use here; everything named gets a real drawn flag instead, same
// look as the LinkedIn Jobs page itself.
function tabsyncCountryFlagHtml(country) {
  const box = 'width="18" height="13" class="tabsync-linkedin-row__flag" preserveAspectRatio="none" aria-hidden="true"';
  switch (country) {
    case "United States":
      return `<svg ${box} viewBox="0 0 20 14"><rect width="20" height="14" fill="#fff"/>${[0, 2, 4, 6, 8, 10, 12]
        .map((i) => `<rect y="${i * 1.077}" width="20" height="1.077" fill="#b22234"/>`)
        .join("")}<rect width="8.4" height="7.54" fill="#3c3b6e"/></svg>`;
    case "United Kingdom":
      return `<svg ${box} viewBox="0 0 20 14"><rect width="20" height="14" fill="#012169"/><path d="M0 0L20 14M20 0L0 14" stroke="#fff" stroke-width="2.8"/><path d="M0 0L20 14M20 0L0 14" stroke="#c8102e" stroke-width="1.3"/><path d="M10 0V14M0 7H20" stroke="#fff" stroke-width="3.4"/><path d="M10 0V14M0 7H20" stroke="#c8102e" stroke-width="2"/></svg>`;
    case "European Union": {
      const stars = Array.from({ length: 12 }, (_, i) => {
        const a = (i / 12) * 2 * Math.PI - Math.PI / 2;
        return { cx: 10 + 4.3 * Math.cos(a), cy: 7 + 4.3 * Math.sin(a) };
      });
      return `<svg ${box} viewBox="0 0 20 14"><rect width="20" height="14" fill="#003399"/>${stars
        .map((st) => `<circle cx="${st.cx}" cy="${st.cy}" r="0.8" fill="#ffcc00"/>`)
        .join("")}</svg>`;
    }
    case "Philippines":
      return `<svg ${box} viewBox="0 0 20 14"><rect width="20" height="7" fill="#0038a8"/><rect y="7" width="20" height="7" fill="#ce1126"/><path d="M0 0L9 7L0 14Z" fill="#fff"/><circle cx="2.8" cy="7" r="1.5" fill="#fcd116"/></svg>`;
    case "Australia":
      return `<svg ${box} viewBox="0 0 20 14"><rect width="20" height="14" fill="#00008b"/><path d="M0 0L10 7M10 0L0 7" stroke="#fff" stroke-width="1.4"/><path d="M5 0V7M0 3.5H10" stroke="#fff" stroke-width="1.8"/><path d="M5 0V7M0 3.5H10" stroke="#c8102e" stroke-width="1"/><circle cx="5" cy="10.6" r="1" fill="#fff"/><circle cx="15" cy="4" r="0.7" fill="#fff"/><circle cx="17.4" cy="7" r="0.7" fill="#fff"/><circle cx="15" cy="10" r="0.7" fill="#fff"/><circle cx="12.8" cy="7" r="0.6" fill="#fff"/></svg>`;
    case "United Arab Emirates":
      return `<svg ${box} viewBox="0 0 20 14"><rect width="20" height="14" fill="#fff"/><rect width="20" height="4.667" fill="#009739"/><rect y="9.333" width="20" height="4.667" fill="#000"/><rect width="5" height="14" fill="#ce1126"/></svg>`;
    case "France":
      return `<svg ${box} viewBox="0 0 20 14"><rect width="20" height="14" fill="#fff"/><rect width="6.667" height="14" fill="#002395"/><rect x="13.333" width="6.667" height="14" fill="#ed2939"/></svg>`;
    case "Germany":
      return `<svg ${box} viewBox="0 0 20 14"><rect width="20" height="4.667" fill="#000"/><rect y="4.667" width="20" height="4.667" fill="#dd0000"/><rect y="9.333" width="20" height="4.667" fill="#ffce00"/></svg>`;
    case "Netherlands":
      return `<svg ${box} viewBox="0 0 20 14"><rect width="20" height="4.667" fill="#21468b"/><rect y="4.667" width="20" height="4.667" fill="#fff"/><rect y="9.333" width="20" height="4.667" fill="#ae1c28"/></svg>`;
    case "Poland":
      return `<svg ${box} viewBox="0 0 20 14"><rect width="20" height="7" fill="#fff"/><rect y="7" width="20" height="7" fill="#dc143c"/></svg>`;
    case "Italy":
      return `<svg ${box} viewBox="0 0 20 14"><rect width="20" height="14" fill="#fff"/><rect width="6.667" height="14" fill="#009246"/><rect x="13.333" width="6.667" height="14" fill="#ce2b37"/></svg>`;
    case "India":
      return `<svg ${box} viewBox="0 0 20 14"><rect width="20" height="4.667" fill="#ff9933"/><rect y="4.667" width="20" height="4.667" fill="#fff"/><rect y="9.333" width="20" height="4.667" fill="#138808"/><circle cx="10" cy="7" r="1.6" fill="none" stroke="#000080" stroke-width="0.3"/><circle cx="10" cy="7" r="0.35" fill="#000080"/></svg>`;
    case "Canada":
      return `<svg ${box} viewBox="0 0 20 14"><rect width="20" height="14" fill="#fff"/><rect width="5" height="14" fill="#d80621"/><rect x="15" width="5" height="14" fill="#d80621"/><path d="M10 3.2l0.7 1.5 1.6-0.4-0.6 1.3 1.2 0.9-1.4 0.4 0.2 1.6-1.2-0.8-0.3 0.9-0.3-0.9-1.2 0.8 0.2-1.6-1.4-0.4 1.2-0.9-0.6-1.3 1.6 0.4z" fill="#d80621"/></svg>`;
    default:
      return country ? '<span class="tabsync-linkedin-row__flag-emoji" aria-hidden="true">🌎</span>' : "";
  }
}

// "2 days ago" / "3 weeks ago" / "1 month ago" — relative to now, coarsest
// unit that's at least 1. Falls back to "" (hidden) for a missing/invalid date.
function tabsyncTimeAgo(iso) {
  const then = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(then)) return "";
  const diffMs = Date.now() - then;
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} day${day === 1 ? "" : "s"} ago`;
  const week = Math.floor(day / 7);
  if (week < 5) return `${week} week${week === 1 ? "" : "s"} ago`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month} month${month === 1 ? "" : "s"} ago`;
  const year = Math.floor(day / 365);
  return `${year} year${year === 1 ? "" : "s"} ago`;
}

// A long LinkedIn URL reads as noise past its own domain+path start — same
// 46-char truncation the main app's own LinkedIn Jobs table uses (the full
// URL is still the row's own href/title, nothing's actually hidden).
const TABSYNC_LINK_TRUNCATE = 46;
function tabsyncTruncateUrl(url) {
  const s = String(url || "");
  return s.length > TABSYNC_LINK_TRUNCATE ? `${s.slice(0, TABSYNC_LINK_TRUNCATE)}…` : s;
}

// Country flag, role, link, and relative date — the same four fields the
// main app's own LinkedIn Jobs table shows (Country/Role/Link/Date columns).
// Laid out as a bordered table row: the flag sits left, centered against the
// whole row; role sits top-right of it with the date pinned to the row's own
// top-right corner; the link runs full-width on its own line underneath.
function tabsyncLinkedinRowHtml(job) {
  const role = job.role || job.company || "Untitled role";
  const flag = tabsyncCountryFlagHtml(job.country);
  const when = tabsyncTimeAgo(job.createdAt);
  return `<a class="tabsync-linkedin-row" href="${escapeHtml(job.url)}" target="_blank" rel="noreferrer" title="${escapeHtml(job.url)}">
    <span class="tabsync-linkedin-row__flagcol">${flag}</span>
    <span class="tabsync-linkedin-row__role">${escapeHtml(role)}</span>
    <span class="tabsync-linkedin-row__date">${escapeHtml(when)}</span>
    <span class="tabsync-linkedin-row__link">${escapeHtml(tabsyncTruncateUrl(job.url))}</span>
  </a>`;
}

// The current page's slice — shared by the list render and Open Tabs, so
// "open the current page" always matches exactly what's on screen.
function tabsyncLinkedinPageItems() {
  const start = (TABSYNC_LINKEDIN_PAGE - 1) * TABSYNC_PAGE_SIZE;
  return TABSYNC_LINKEDIN_JOBS.slice(start, start + TABSYNC_PAGE_SIZE);
}

// Open Tabs' own label — "Open Tabs" on the Links sub-tab, "Open N Jobs" on
// LinkedIn Jobs, N being exactly what a click would open right now (the
// current page's rows, same computation openLinkedinJobTabs itself uses).
// Replaced the old separate "Jobs from LinkedIn" title + count header,
// which sat above a list the count could always be read off directly.
function updateOpenTabsBtnLabel() {
  const span = els.openTabsBtn?.querySelector(".btn-text");
  if (!span) return;
  if (TABSYNC_SUBTAB === "linkedin") {
    const n = tabsyncLinkedinPageItems().filter((j) => j.url).length;
    span.textContent = `Open ${n} Job${n === 1 ? "" : "s"}`;
  } else {
    span.textContent = "Open Tabs";
  }
}

function renderTabsyncLinkedinList() {
  if (!els.tabsyncLinkedinList) return;
  const total = TABSYNC_LINKEDIN_JOBS.length;
  if (total === 0) {
    els.tabsyncLinkedinList.innerHTML =
      '<p class="tab-panel-placeholder">No unapplied LinkedIn jobs — you’re all caught up.</p>';
    els.tabsyncLinkedinPager?.classList.add("hidden");
    updateOpenTabsBtnLabel();
    return;
  }
  const pageCount = Math.max(1, Math.ceil(total / TABSYNC_PAGE_SIZE));
  TABSYNC_LINKEDIN_PAGE = Math.min(Math.max(TABSYNC_LINKEDIN_PAGE, 1), pageCount);
  els.tabsyncLinkedinList.innerHTML = tabsyncLinkedinPageItems().map(tabsyncLinkedinRowHtml).join("");
  els.tabsyncLinkedinPager?.classList.toggle("hidden", pageCount <= 1);
  if (els.tabsyncPagerLabel) els.tabsyncPagerLabel.textContent = `Page ${TABSYNC_LINKEDIN_PAGE} of ${pageCount}`;
  if (els.tabsyncPagerPrev) els.tabsyncPagerPrev.disabled = TABSYNC_LINKEDIN_PAGE <= 1;
  if (els.tabsyncPagerNext) els.tabsyncPagerNext.disabled = TABSYNC_LINKEDIN_PAGE >= pageCount;
  updateOpenTabsBtnLabel();
}

function tabsyncLinkedinChangePage(delta) {
  TABSYNC_LINKEDIN_PAGE += delta;
  renderTabsyncLinkedinList();
}

// Open Tabs opens whichever sub-tab's list is currently showing — the
// LinkedIn Jobs rows on the CURRENT page only (not the whole board — that
// could be hundreds), or the pasted/parsed Links.
function openTabsyncTabs() {
  if (TABSYNC_SUBTAB === "linkedin") openLinkedinJobTabs();
  else openPastedTabs();
}

// Root cause of "the Mark-as-applied confirm below closes as soon as the
// tabs open": chrome.tabs.create defaults to active: true, so each of the N
// new tabs grabs focus in turn as it's created — and loadForTab (above)
// deliberately closes every tab-scoped modal, THIS confirm included, the
// moment the active tab changes, on the assumption the user navigated away
// on purpose. Here the tab switch is just a side effect of the same action,
// not a real navigation-away, so keeping the panel's own current tab active
// the whole time (active: false on every created tab, plus an explicit
// incrementing `index` so they still land in order right after it, instead
// of wherever Chrome's own default placement puts them) avoids the close
// firing at all — the confirm modal opened below just stays open and usable.
async function openLinkedinJobTabs() {
  const jobs = tabsyncLinkedinPageItems().filter((j) => j.url);
  if (jobs.length === 0) {
    panelToast("No unapplied LinkedIn jobs to open.", "error");
    return;
  }
  let baseIndex = null;
  try {
    baseIndex = (await chrome.tabs.get(TAB_ID)).index + 1;
  } catch {
    baseIndex = null;
  }
  jobs.forEach((job, i) => {
    const opts = { url: job.url, active: false };
    if (baseIndex != null) opts.index = baseIndex + i;
    chrome.tabs.create(opts);
  });
  panelToast(`Opened ${jobs.length} tab${jobs.length === 1 ? "" : "s"}.`);
  // Ask afterward, not before — opening never waits on the answer.
  openTabsyncAppliedConfirm(jobs);
}

// "Mark these as applied?" — shown after Open Tabs opens the current page's
// LinkedIn Jobs. Yes marks every one of THOSE jobs applied (PATCH
// /linkedin-positions/applied-bulk — the same per-viewer appliedBy flag the
// main app's own LinkedIn Jobs table reads, so they show as Applied there
// too) and drops them out of this list, since it's filtered to unapplied
// jobs only. No just closes the dialog — the tabs stay open either way.
let TABSYNC_APPLIED_CONFIRM_JOBS = [];

// Keyed by the tab that was on screen when Open Tabs ran — the active:false
// trick above keeps that tab active through the bulk-open itself, but the
// user can still switch away manually afterward, so this still needs to
// survive a switch-and-back the same as the other tab-scoped modals.
const TABSYNC_CONFIRM_OPEN = new Map();

function renderTabsyncAppliedConfirm(tabId) {
  const jobs = TABSYNC_CONFIRM_OPEN.get(tabId);
  if (!jobs || !els.tabsyncAppliedConfirmBackdrop) return;
  TABSYNC_APPLIED_CONFIRM_JOBS = jobs;
  if (els.tabsyncAppliedConfirmMsg) {
    els.tabsyncAppliedConfirmMsg.textContent =
      `Mark ${jobs.length === 1 ? "this job" : `these ${jobs.length} jobs`} as applied?`;
  }
  els.tabsyncAppliedConfirmBackdrop.classList.remove("hidden");
}

function openTabsyncAppliedConfirm(jobs) {
  if (!els.tabsyncAppliedConfirmBackdrop) return;
  TABSYNC_CONFIRM_OPEN.set(TAB_ID, jobs);
  renderTabsyncAppliedConfirm(TAB_ID);
}

// Explicit user dismissal (No, Yes, or backdrop click) — this tab no longer
// wants it reopened.
function closeTabsyncAppliedConfirm() {
  els.tabsyncAppliedConfirmBackdrop?.classList.add("hidden");
  TABSYNC_APPLIED_CONFIRM_JOBS = [];
  TABSYNC_CONFIRM_OPEN.delete(TAB_ID);
}

// Tab-switch-away only: hide without forgetting — loadForTab repaints it via
// renderTabsyncAppliedConfirm if the user comes back to this tab.
function hideTabsyncAppliedConfirm() {
  els.tabsyncAppliedConfirmBackdrop?.classList.add("hidden");
}

async function confirmTabsyncApplied() {
  const jobs = TABSYNC_APPLIED_CONFIRM_JOBS;
  closeTabsyncAppliedConfirm();
  const ids = jobs.map((j) => j.id).filter(Boolean);
  if (ids.length === 0) return;
  try {
    await apiFetch("/linkedin-positions/applied-bulk", {
      method: "PATCH",
      body: JSON.stringify({ ids, applied: true }),
    });
    const idSet = new Set(ids);
    TABSYNC_LINKEDIN_JOBS_ALL = TABSYNC_LINKEDIN_JOBS_ALL.filter((j) => !idSet.has(j.id));
    TABSYNC_LINKEDIN_JOBS = TABSYNC_LINKEDIN_JOBS.filter((j) => !idSet.has(j.id));
    renderTabsyncLinkedinList();
    if (TABSYNC_SUBTAB === "linkedin") updateTabsyncStats();
    refreshTabsyncUnappliedBadge();
    panelToast(`Marked ${ids.length} job${ids.length === 1 ? "" : "s"} as applied.`);
  } catch {
    panelToast("Couldn't mark as applied — try again.", "error");
  }
}

// Links-tab-only now (see sidepanel.html's #tabsyncManualPanel) — always
// copies every OPEN browser tab's URL, never this page's own pasted text.
async function copyOpenTabsToClipboard() {
  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch (e) {
    panelToast("Couldn't read open tabs.", "error");
    return;
  }
  const webUrls = tabs
    .map((t) => t.url)
    .filter((u) => typeof u === "string" && (u.startsWith("http://") || u.startsWith("https://")));
  const normalized = webUrls.map((u) => tabsyncNormalizeUrl(u)).filter(Boolean);
  const unique = [...new Set(normalized)];
  const filtered = unique.filter((u) => !tabsyncIsExcludedUrl(u));
  if (filtered.length === 0) {
    panelToast("No open web tabs to copy.", "error");
    return;
  }
  try {
    await navigator.clipboard.writeText(filtered.join("\n"));
    panelToast(`Copied ${filtered.length} URL${filtered.length === 1 ? "" : "s"}.`);
  } catch {
    panelToast("Copy failed.", "error");
  }
}

async function openPastedTabs() {
  const { valid, invalid } = tabsyncParseLinks(els.tabsyncInput?.value);
  if (valid.length === 0) {
    panelToast(invalid.length > 0 ? "No valid URLs to open." : "Paste some links first.", "error");
    return;
  }
  // Same active:false/explicit-index fix as openLinkedinJobTabs above — keeps
  // this panel's own tab active throughout instead of thrashing through
  // every newly-opened one.
  let baseIndex = null;
  try {
    baseIndex = (await chrome.tabs.get(TAB_ID)).index + 1;
  } catch {
    baseIndex = null;
  }
  valid.forEach((url, i) => {
    const opts = { url, active: false };
    if (baseIndex != null) opts.index = baseIndex + i;
    chrome.tabs.create(opts);
  });
  panelToast(
    `Opened ${valid.length} tab${valid.length === 1 ? "" : "s"}${invalid.length > 0 ? ` (${invalid.length} invalid skipped)` : ""}.`,
    invalid.length > 0 ? "warning" : "success",
  );
}

// ---- Extension self-update check ---------------------------------------
const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const UPDATE_DISMISS_KEY = "ab_update_dismissed";

/** Numeric semver-ish compare: 1 if a>b, -1 if a<b, 0 if equal. */
function compareVersions(a, b) {
  const pa = String(a || "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Ask the server for the latest published version and show the update banner
 *  when it's newer than what's installed (and not already dismissed for that
 *  version). Best-effort — offline / server down / not configured = no banner. */
async function checkForUpdate() {
  if (!els.updateBanner) return;
  let data;
  try {
    const res = await fetch(`${API_BASE}/extension/version`, { cache: "no-store" });
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return; // offline / server down
  }
  const latest = data?.version;
  if (!latest || compareVersions(latest, EXTENSION_VERSION) <= 0) return;

  // Per-version dismissal so we don't nag every open, but re-show when an even
  // newer version ships.
  try {
    const stored = await chrome.storage.local.get(UPDATE_DISMISS_KEY);
    if (stored?.[UPDATE_DISMISS_KEY] === latest) return;
  } catch {
    /* storage unavailable — show anyway */
  }

  els.updateBannerText.textContent = `Update available — v${latest} (you have v${EXTENSION_VERSION})`;
  els.updateBtn.dataset.version = latest;
  els.updateBtn.dataset.url = data?.url || "";
  if (els.updateBannerNotes) {
    if (data?.notes) {
      els.updateBannerNotes.textContent = data.notes;
      els.updateBannerNotes.classList.remove("hidden");
    } else {
      els.updateBannerNotes.classList.add("hidden");
    }
  }
  els.updateBanner.classList.remove("hidden");
}

async function init() {
  // Right of the logo, e.g. "v1.0.0" — reuses the same EXTENSION_VERSION
  // constant checkForUpdate() below already reads off the manifest, so
  // there's only ever one source for what version this build actually is.
  const brandVersionEl = document.getElementById("brandVersion");
  if (brandVersionEl) brandVersionEl.textContent = `v${EXTENSION_VERSION}`;
  checkForUpdate(); // best-effort; shows the banner if a newer version exists
  // Kick off the runtime-logo swap early — this runs in parallel with
  // the rest of init(), never awaited. If it fails (server down,
  // offline), the bundled icons/logo.png in the <img> tags remains
  // visible and nothing else in the panel is affected.
  applyBrandingLogos().catch(() => {});
  initFilenameSettings();
  initResumeTemplateSetting(); // best-effort; re-fetched again once signed in, see refreshCapabilities
  restoreDownloadFolder(); // best-effort; sets the folder hint
  const win = await chrome.windows.getCurrent();
  CURRENT_WINDOW_ID = win.id;
  const tabId = await getActiveInWindow(CURRENT_WINDOW_ID);
  await sendToBG({ type: "SET_OPEN", tabId, isOpen: true });
  await loadForTab(tabId);
  // Apply any cached role-fit rules immediately (before the network round-trip)
  // so the very first detection this session already respects them.
  await applyCachedFitRules();
  const token = await getToken();
  if (token) {
    // Defensive re-check for a session stored before this role gate existed,
    // or one belonging to an account whose role changed since it signed in
    // (login-time role is a snapshot, not live) — the login-time check in
    // the loginBtn handler is the primary gate, this catches the rest.
    const role = await getRole();
    const roleTags = await getRoleTags();
    if (!isRoleAllowed({ role, roleTags })) {
      await clearAuthStorage();
      PROFILE_OPTIONS = [];
      setLoginModalError(ROLE_BLOCKED_MESSAGE);
    } else {
      scheduleSessionExpiry(token);
      refreshCapabilities();
      refreshFitRules(); // best-effort; updates the cache + this panel
      refreshTabsyncUnappliedBadge();
      connectRealtime(); // best-effort; live TabSync refresh
      try {
        await loadProfilesFromServer();
        populateProfiles(els.profileSelect, await defaultSelectedProfileId(), chooseProfile);
        await ensureDefaultProfileSelection();
      } catch (e) {
        setStatus(tabId, "Could not load profiles: " + e.message, "error");
      }
    }
  }
  await updateLoginGate();
  renderShortcuts();
  // Same 30s cadence as the main app's own poll for this count (App.jsx).
  setInterval(refreshTabsyncUnappliedBadge, 30000);
}

// A hotkey fired while this panel was closed — background.js opened the
// panel and stashed the action in session storage since a live sendMessage
// sent before this script finishes loading would be lost. Ignore anything
// older than a few seconds (a previous session's leftover, or the panel
// took unusually long to open) rather than firing an action the user no
// longer intends.
async function checkPendingHotkey() {
  try {
    const { pendingHotkey } = await chrome.storage.session.get("pendingHotkey");
    if (!pendingHotkey) return;
    await chrome.storage.session.remove("pendingHotkey");
    if (Date.now() - (pendingHotkey.ts || 0) > 5000) return;
    if (pendingHotkey.type === "HOTKEY_AUTOFILL") els.autofillBtn?.click();
    else if (pendingHotkey.type === "HOTKEY_GENERATE") els.generateBtn?.click();
  } catch {
    /* chrome.storage.session unavailable */
  }
}

// Live shortcut bindings for the Generate/Auto-fill buttons' own keycap
// chips (rendered as <kbd> pills, not text) — kept in sync by
// renderShortcuts() below, e.g. "Ctrl+Shift+G", or "" if unbound.
let HOTKEY_GENERATE = "";
let HOTKEY_AUTOFILL = "";

// Renders `shortcut` ("Ctrl+Shift+G") as one <kbd> pill per key into `el`
// (see .btn-hotkey/.shortcut-row__keys in panel.css). Empty/unbound clears
// it to no chips — callers that want a text fallback (e.g. "Not set") add
// that themselves afterward.
function renderKeyChip(el, shortcut) {
  if (!el) return;
  el.innerHTML = "";
  (shortcut || "").split("+").filter(Boolean).forEach((k) => {
    const kbd = document.createElement("kbd");
    kbd.textContent = k;
    el.appendChild(kbd);
  });
}

// Whichever GEN_STAGES label is "current" for the in-flight generation,
// computed from elapsed time rather than tracked in a separate mutable
// variable — so it's correct immediately on both a fresh Generate click
// AND a tab-switch resume (STATE.generatingStartedAt persists per tab),
// with no reliance on whichever setTimeout happened to fire last for
// whichever tab was visible then. GEN_STAGES is sorted by `.at` ascending.
function currentGenStageLabel() {
  const start = STATE?.generatingStartedAt;
  if (!start) return GEN_STAGES[0].label;
  const elapsed = Date.now() - start;
  let label = GEN_STAGES[0].label;
  for (const stage of GEN_STAGES) {
    if (stage.at > elapsed) break;
    label = stage.label;
  }
  return label;
}

// The Generate button's label already depends on its own in-flight status
// (idle / generating / error) — this is the one place that decides it, so
// it can't drift out of sync between call sites. While generating, this is
// the real evolving stage text (see currentGenStageLabel) instead of a
// static "Generating…" placeholder.
function generateBtnLabel(genStatus) {
  if (genStatus === "generating") return currentGenStageLabel();
  return genStatus === "error" ? "Retry generation" : "Generate Resume";
}

// Auto-fill's label never changes with status (unlike Generate above), so
// this is the only place that ever sets it. The hotkey chip is only shown
// next to Generate while idle/error — mid-generation the button is
// disabled anyway, so a hotkey hint there would just be a no-op.
function applyHotkeyButtonLabels() {
  refreshAutofillButtonTitle();
  renderKeyChip(els.autofillHotkey, HOTKEY_AUTOFILL);
  // Same chip, same hotkey — Apply tab's commit button is the same
  // conceptual action as the Job tab's own Auto-fill button, just styled
  // differently before (see its own markup comment in sidepanel.html).
  renderKeyChip(els.autofillReviewCommitHotkey, HOTKEY_AUTOFILL);
  if (els.generateBtn) setButtonText(els.generateBtn, generateBtnLabel(STATE?.generatingStatus));
  renderKeyChip(els.generateHotkey, STATE?.generatingStatus === "generating" ? "" : HOTKEY_GENERATE);
}

// Live "how many forms does this page have" count on the Auto-fill button's
// own title. Used to run its own lightweight AUTOFILL_DETECT scan (no AI,
// just counting raw fields/questions) — separate from the Apply tab's own
// AUTOFILL_REVIEW-based count (contact fields + questions + resume/cover-
// letter slots, minus whatever's already filled on the page), so the two
// buttons showed DIFFERENT numbers for the same page (confirmed real
// complaint: Job tab said "11", Apply tab said "13" for the same job).
//
// A same-session fix tried sharing loadAutofillReview's own
// AUTOFILL_REVIEW_ROWS directly (calling it here too) — initially
// REVERTED, because that call used to unconditionally re-scan and rebuild
// AUTOFILL_REVIEW_ROWS from scratch every time anything called it,
// including this function running right after the tab loads — which could
// race the Apply tab's own legit scan, or blow away what it had just
// loaded. The actual fix was upstream: loadAutofillReview now only
// re-scans when nothing's loaded yet (or the caller explicitly forces a
// refresh — see its own AUTOFILL_REVIEW_LOADED_KEY comment), so calling it
// here is safe again — a second call for the same tab+job just reuses
// whatever's already there instead of re-scanning. Falls back to a plain
// "Auto-fill Forms" label whenever the count isn't actually known (no
// active tab yet, no profile selected, a restricted chrome:// page,
// content script not present/injected) rather than showing a stale or
// wrong number.
async function refreshAutofillButtonTitle() {
  if (!els.autofillBtn) return;
  if (!TAB_ID) {
    setButtonText(els.autofillBtn, "Auto-fill Forms");
    return;
  }
  try {
    await loadAutofillReview();
    const count = AUTOFILL_REVIEW_ROWS.filter((r) => r.filledOnPage !== true).length;
    setButtonText(
      els.autofillBtn,
      count > 0 ? `Auto-fill ${count} Field${count === 1 ? "" : "s"}` : "Auto-fill Forms",
    );
  } catch {
    setButtonText(els.autofillBtn, "Auto-fill Forms");
  }
}

/** Populate the Account tab's shortcut rows from chrome.commands.getAll(), and
 *  the Generate/Auto-fill buttons' own keycap chips — both read the same
 *  chrome.commands.getAll() call so they can never disagree with each other. */
async function renderShortcuts() {
  const rows = { "run-generate": els.shortcutGenerate, "run-autofill": els.shortcutAutofill };
  try {
    const commands = await chrome.commands.getAll();
    for (const cmd of commands) {
      if (cmd.name === "run-generate") HOTKEY_GENERATE = cmd.shortcut || "";
      else if (cmd.name === "run-autofill") HOTKEY_AUTOFILL = cmd.shortcut || "";
      const el = rows[cmd.name];
      if (!el) continue;
      renderKeyChip(el, cmd.shortcut);
      if (!cmd.shortcut) el.textContent = "Not set";
    }
    applyHotkeyButtonLabels();
  } catch {
    /* chrome.commands unavailable */
  }
}

function selectedProfileId() {
  return els.profileSelect.dataset.value || STATE?.selectedProfileId || "";
}

document.addEventListener("DOMContentLoaded", async () => {
  // Login screen's "© <year> BCD. All rights reserved." — filled in here so
  // it never goes stale, same as the main web app's footer (Footer.jsx).
  if (els.loginCopyrightYear) els.loginCopyrightYear.textContent = String(new Date().getFullYear());

  await init();

  els.loginBtn.addEventListener("click", async () => {
    const tabId = TAB_ID;
    const email = els.loginEmail.value.trim();
    const password = els.loginPassword.value;
    if (!email || !password) {
      setLoginModalError("Email and password are required.");
      return;
    }
    setLoginModalError("");
    setButtonText(els.loginBtn, "Signing in…");
    els.loginBtn.disabled = true;
    // { toast: false }: sign-in happens behind the login modal, which
    // already covers the whole panel — a page toast on top of that is
    // redundant, and pops up on the actual webpage where it reads as an
    // unrelated notification rather than sign-in feedback.
    setStatus(tabId, "Signing in…", "loading", { toast: false });
    try {
      // Drop any previous backend token before login so parallel init
      // requests cannot 401 and clear the new session mid-sign-in.
      await clearAuthStorage();
      const data = await apiFetch("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      if (!data.token) throw new Error("No token returned");
      // Gate BEFORE storing anything — a caller/manager/dev/etc. has a
      // perfectly valid BCD login (the server already issued a real token),
      // but this extension never keeps it. Throwing here routes into the
      // catch below, which shows the message and leaves the login screen up
      // exactly like a failed sign-in would.
      const role = data.user?.role || "";
      const roleTags = Array.isArray(data.user?.roleTags) ? data.user.roleTags : [];
      if (!isRoleAllowed(data.user)) {
        throw new Error(ROLE_BLOCKED_MESSAGE);
      }
      if (!isExtensionEnabledFor(data.user)) {
        throw new Error(EXTENSION_DISABLED_MESSAGE);
      }
      await setAuthStorage({
        token: data.token,
        email: data.user?.email || email,
        name: data.user?.name || "",
        avatar: data.user?.avatar || "",
        role,
        roleTags,
      });
      els.loginPassword.value = "";
      // Pass the fresh token explicitly so post-login fetches don't race a
      // storage clear (e.g. a mis-scheduled session timer).
      refreshCapabilities();
      refreshFitRules(); // pull this account's role-fit rules into the cache
      refreshTabsyncUnappliedBadge();
      connectRealtime(); // best-effort; live TabSync refresh
      await loadProfilesFromServer(data.token);
      populateProfiles(els.profileSelect, await defaultSelectedProfileId(), chooseProfile);
      await ensureDefaultProfileSelection();
      await refreshAuthUI();
      if (tabId != null) await loadForTab(tabId);
      // { toast: false } — see "Signing in…" above; same reasoning.
      setStatus(tabId, "Signed in.", "success", { toast: false });
    } catch (e) {
      setLoginModalError(e.message || "Sign-in failed");
      // { toast: false } — the login modal's own setLoginModalError above
      // already shows this right there in the panel.
      setStatus(tabId, "Sign-in failed.", "error", { toast: false });
    } finally {
      setButtonText(els.loginBtn, "Sign in");
      els.loginBtn.disabled = false;
    }
  });

  async function doSignOut() {
    // Best-effort server-side logout so a different device can sign in.
    try {
      await apiFetch("/auth/logout", { method: "POST" });
    } catch {
      /* ignore — local logout still proceeds */
    }
    disconnectRealtime();
    await clearAuthStorage();
    PROFILE_OPTIONS = [];
    populateProfiles(els.profileSelect, "", chooseProfile);
    setTabsyncBadge(0);
    await refreshAuthUI();
    await loadForTab(TAB_ID);
    setStatus(TAB_ID, "Signed out.", "idle");
  }

  // Account / Profile / Apply section switcher, right under the header. Apply
  // wraps everything that already lived in the panel (Detect/Generate, Job
  // details, etc).
  els.mainTabs?.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-tabs-btn");
    if (!btn || !els.mainTabs.contains(btn)) return;
    switchToTab(btn.dataset.tab);
  });

  els.settingsSubTabs?.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-tabs-btn");
    if (!btn || !els.settingsSubTabs.contains(btn)) return;
    switchSettingsSubTab(btn.dataset.subtab);
  });

  els.tabsyncSubTabs?.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-tabs-btn");
    if (!btn || !els.tabsyncSubTabs.contains(btn)) return;
    switchTabsyncSubTab(btn.dataset.subtab);
  });
  els.tabsyncPagerPrev?.addEventListener("click", () => tabsyncLinkedinChangePage(-1));
  els.tabsyncPagerNext?.addEventListener("click", () => tabsyncLinkedinChangePage(1));
  els.tabsyncLinkedinCountryFilter?.addEventListener("change", applyTabsyncLinkedinFilter);
  els.tabsyncLinkedinRoleFilter?.addEventListener("input", applyTabsyncLinkedinFilter);
  els.tabsyncAppliedConfirmNoBtn?.addEventListener("click", closeTabsyncAppliedConfirm);
  els.tabsyncAppliedConfirmYesBtn?.addEventListener("click", () => void confirmTabsyncApplied());
  els.tabsyncAppliedConfirmBackdrop?.addEventListener("click", (e) => {
    if (e.target === els.tabsyncAppliedConfirmBackdrop) closeTabsyncAppliedConfirm();
  });

  els.profileTabPanel?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-copy]");
    if (!btn) return;
    const text = btn.dataset.copy;
    const label = btn.dataset.copyLabel || "Value";
    try {
      await navigator.clipboard.writeText(text);
      showCopiedCheck(btn);
      panelToast(`${label} copied.`);
    } catch (err) {
      setStatus(TAB_ID, "Copy failed: " + (err?.message || err), "error");
    }
  });

  initResumeModeToggle();
  initUserMenu(doSignOut);
  // Logo opens the web dashboard (bcd.llc) in a new tab. It's a plain div
  // with role="button"/tabindex in the HTML (not a real <button>, to keep
  // the existing .brand/.brand-mark layout untouched), so Enter/Space need
  // their own handler — a real button gets that for free from the browser.
  const brandLogoBtn = document.getElementById("brandOpenDashboard");
  brandLogoBtn?.addEventListener("click", () => {
    chrome.tabs.create({ url: DASHBOARD_URL });
  });
  brandLogoBtn?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      chrome.tabs.create({ url: DASHBOARD_URL });
    }
  });

  // Floating scroll controls (jump to top / bottom). The whole document scrolls
  // (the panel has no inner scroll container), so we drive window scroll. Each
  // button shows only when there's room to scroll that way; the container is a
  // bottom-anchored flex column, so when one button hides the other keeps its
  // place and the stack grows upward from the same corner.
  const scrollNav = document.getElementById("scrollNav");
  if (scrollNav && (els.scrollTopBtn || els.scrollBottomBtn)) {
    const scroller = document.scrollingElement || document.documentElement;
    const composer = document.querySelector(".qa-composer");
    // A button needs `overflow > OVERFLOW_MIN` AND to be more than EDGE from
    // that edge, so the band where anything shows is (overflow - 2*EDGE). Keep
    // EDGE well under OVERFLOW_MIN/2 or the controls silently never appear —
    // 240/120 left a zero-width band and hid them once the form got compact.
    const OVERFLOW_MIN = 120; // don't offer jumps until there's real scroll
    const EDGE = 40; // "near enough to the top/bottom" dead-zone
    const updateScrollBtns = () => {
      const overflow = scroller.scrollHeight - scroller.clientHeight;
      const fromTop = scroller.scrollTop;
      const fromBottom = overflow - fromTop;
      const scrollable = overflow > OVERFLOW_MIN;
      els.scrollTopBtn?.classList.toggle("hidden", !(scrollable && fromTop > EDGE));
      els.scrollBottomBtn?.classList.toggle("hidden", !(scrollable && fromBottom > EDGE));
      // Sit above the sticky Q&A composer when it's visible, so the controls
      // don't cover the question input / Ask button.
      const composerVisible = composer && composer.offsetParent !== null;
      scrollNav.style.bottom = composerVisible ? composer.offsetHeight + 20 + "px" : "14px";
    };
    els.scrollTopBtn?.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    els.scrollBottomBtn?.addEventListener("click", () => {
      window.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    });
    window.addEventListener("scroll", updateScrollBtns, { passive: true });
    window.addEventListener("resize", updateScrollBtns, { passive: true });
    // Content grows/shrinks a lot (generate, answers, Q&A) — re-evaluate on
    // any DOM mutation so the controls appear as soon as the page overflows.
    new MutationObserver(updateScrollBtns).observe(document.body, { childList: true, subtree: true });
    // The composer shows/hides via a CLASS toggle on #qaSection (an attribute
    // change that childList misses), so watch that too — otherwise the offset
    // isn't recomputed when the composer appears and the controls end up on top
    // of the Ask button. rAF so the composer has laid out before we read it.
    const qaSectionEl = document.getElementById("qaSection");
    if (qaSectionEl) {
      new MutationObserver(() => requestAnimationFrame(updateScrollBtns)).observe(qaSectionEl, {
        attributes: true,
        attributeFilter: ["class"],
      });
    }
    updateScrollBtns();
  }

  // Apply tab's "Form Questions" list (loadAutofillReview etc., defined
  // near switchToTab above) + its own free-form chat. Wired here (not
  // where those functions are defined) only because Attach needs
  // runAutofill, which is closure-scoped to this DOMContentLoaded handler
  // — the rest could've lived anywhere, grouped here for one place to find
  // every click handler.
  els.autofillReviewRefreshBtn?.addEventListener("click", () => loadAutofillReview(true));
  // Defensive — a jobsites/*.webp file that fails to actually
  // load (renamed, missing) shouldn't leave a broken-image icon sitting in
  // the modal's own head; fall back to the generic glyph same as an
  // unrecognised hostname would.
  els.autofillReviewLogo?.addEventListener("error", () => {
    els.autofillReviewLogo.classList.add("hidden");
    els.autofillReviewLogoFallback?.classList.remove("hidden");
  });
  els.autofillReviewList?.addEventListener("click", (e) => {
    const rowEl = e.target.closest(".autofill-qrow");
    if (!rowEl) return;
    const rowId = rowEl.dataset.rowId;
    const row = AUTOFILL_REVIEW_ROWS.find((r) => r.id === rowId);
    if (!row) return;
    if (e.target.closest(".autofill-qrow__edit")) {
      toggleAutofillReviewRowEdit(rowId, rowEl);
    } else if (e.target.closest(".autofill-qrow__refresh")) {
      if (row.kind === "contact") resetAutofillReviewContactRow(rowId);
      else regenerateAutofillReviewRow(rowId);
    } else if (e.target.closest(".autofill-qrow__attach")) {
      // Attach reuses the Job tab's own Basic Auto-fill run wholesale —
      // resume resolution (cached vs. generate-on-demand) is a substantial
      // existing flow (see runAutofill's own comment on pdfBase64), not
      // worth re-implementing here just to relocate the button.
      runAutofill("basic").then(() => loadAutofillReview(true));
    } else if (e.target.closest(".autofill-section__toggle")) {
      row.collapsed = !row.collapsed;
      renderAutofillReviewList();
    }
  });
  // Clicking away from an editing row's textarea saves it, same as
  // hitting the checkmark — focusout (not blur) because it bubbles, so
  // one delegated listener on the list covers every row.
  els.autofillReviewList?.addEventListener("focusout", (e) => {
    if (!e.target.classList?.contains("autofill-qrow__input")) return;
    const rowEl = e.target.closest(".autofill-qrow");
    const rowId = rowEl?.dataset.rowId;
    const row = rowId && AUTOFILL_REVIEW_ROWS.find((r) => r.id === rowId);
    if (row?.editing) toggleAutofillReviewRowEdit(rowId, rowEl);
  });
  els.autofillReviewCommitBtn?.addEventListener("click", () => commitAutofillReview());
  els.autofillReviewStopBtn?.addEventListener("click", () => stopCommitAutofillReview());

  els.filenameResumeInput?.addEventListener("change", (e) => setFilenameTemplate("resume", e.target.value));
  els.filenameCoverInput?.addEventListener("change", (e) => setFilenameTemplate("cover", e.target.value));
  els.filenameJdInput?.addEventListener("change", (e) => setFilenameTemplate("jd", e.target.value));

  // Click the {{bullet_count}} token name to copy it — so it's easy to paste
  // into the org's prompt exactly, no typo risk. Text stays put (unlike
  // showCopiedCheck's icon-swap, wrong for a token you want to keep reading);
  // a brief .copied flash + toast is the feedback instead.
  els.bulletCountToken?.addEventListener("click", async () => {
    const token = els.bulletCountToken.textContent.trim();
    try {
      await navigator.clipboard.writeText(token);
      els.bulletCountToken.classList.add("copied");
      panelToast("Token copied.");
      setTimeout(() => els.bulletCountToken.classList.remove("copied"), 1200);
    } catch (err) {
      setStatus(TAB_ID, "Copy failed: " + (err?.message || err), "error");
    }
  });
  els.bulletCountToken?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      els.bulletCountToken.click();
    }
  });

  // Tabsync tab.
  els.copyOpenTabsBtn?.addEventListener("click", () => void copyOpenTabsToClipboard());
  els.openTabsBtn?.addEventListener("click", openTabsyncTabs);
  els.tabsyncInput?.addEventListener("input", updateTabsyncStats);
  // Deferred to the next tick — the 'paste' event fires BEFORE the browser
  // has actually inserted the clipboard's text into the textarea's value,
  // so reading el.value synchronously here would see the pre-paste content.
  els.tabsyncInput?.addEventListener("paste", () => setTimeout(dedupeTabsyncInput, 0));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (document.body.classList.contains("login-locked")) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
  });

  els.loginPassword?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") els.loginBtn.click();
  });
  els.loginEmail?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") els.loginPassword?.focus();
  });

  // Don't grab focus on mousedown so the cursor stays in the password input.
  els.loginPasswordToggle?.addEventListener("mousedown", (e) =>
    e.preventDefault(),
  );
  els.loginPasswordToggle?.addEventListener("click", () => {
    if (!els.loginPassword || !els.loginPasswordToggle) return;
    const showing = els.loginPasswordToggle.classList.toggle("shown");
    els.loginPassword.type = showing ? "text" : "password";
    els.loginPasswordToggle.setAttribute(
      "aria-label",
      showing ? "Hide password" : "Show password",
    );
  });

  // Custom select wiring — same listeners for both Apply's own profile
  // picker and Profile tab's (see wireCustomSelect below); each closure
  // only ever touches its own `root`, so the two dropdowns never interfere
  // with each other even though both sets of document-level listeners are
  // always attached.
  function wireCustomSelect(root) {
    if (!root) return;
    const trigger = root.querySelector(".select-trigger");
    trigger?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSelect(root);
    });
    trigger?.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (!isSelectOpen(root)) openSelect(root);
        else moveActive(root, 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (!isSelectOpen(root)) openSelect(root);
        else moveActive(root, -1);
      }
    });
    document.addEventListener("click", (e) => {
      if (!isSelectOpen(root)) return;
      if (root.contains(e.target)) return;
      closeSelect(root);
    });
    document.addEventListener("keydown", (e) => {
      if (!isSelectOpen(root)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeSelect(root);
        trigger?.focus();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        moveActive(root, 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        moveActive(root, -1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const panel = root.querySelector(".select-panel");
        const active = panel?.querySelector(".select-option.active");
        if (active) active.click();
      }
    });
  }
  wireCustomSelect(els.profileSelect);
  wireCustomSelect(els.profileTabSelect);

  // Typing into any of the three detected fields marks the content as
  // user-owned (autoDetectedUrl: null) so auto-detect never refreshes over it.
  els.jobText.addEventListener("input", async (e) => {
    await savePatch(TAB_ID, { jobText: e.target.value, autoDetectedUrl: null });
    refreshRenameRow(); // reveal Update when this differs from the saved app
  });
  els.jobText.addEventListener("click", () => expandJobDescription());

  els.coverText?.addEventListener("input", async (e) => {
    if (!STATE?.info) return;
    const nextInfo = { ...STATE.info, cover_letter: e.target.value };
    await savePatch(TAB_ID, { info: nextInfo });
  });
  els.coverText?.addEventListener("click", () => expandCoverLetter());
  els.resumeText?.addEventListener("click", () => expandResume());
  els.viewCoverBtn?.addEventListener("click", () => expandCoverLetter());
  els.viewResumeBtn?.addEventListener("click", () => expandResume());

  // Shared field modal (Job Description / Cover Letter / Resume): the back
  // button and clicking the dimmed backdrop itself (not the card) both
  // close it.
  els.fieldModalBackBtn?.addEventListener("click", () => closeFieldModal());
  els.fieldModalBackdrop?.addEventListener("click", (e) => {
    if (e.target === els.fieldModalBackdrop) closeFieldModal();
  });

  // Job-fit warning modal — deliberately NOT wired to backdrop-click or a
  // back/X button like the field modal above. Continue is the only way out.
  els.fitWarningContinueBtn?.addEventListener("click", () => dismissFitWarningModal());
  els.dupWarningContinueBtn?.addEventListener("click", () => continueDupWarningModal());

  els.qaInput?.addEventListener("focus", () => expandQA());
  els.qaBackBtn?.addEventListener("click", () => collapseQA());
  // Clicking anywhere outside the expanded overlay AND its composer (the
  // composer is a separate sibling that stays on-screen and un-touched
  // while expanded — see expandQA's own comment above) closes it, same as
  // clicking the back arrow.
  document.addEventListener("pointerdown", (e) => {
    const overlay = els.qaOverlay;
    if (!overlay || !overlay.classList.contains("qa-overlay--expanded")) return;
    if (overlay.contains(e.target) || els.qaComposer?.contains(e.target)) return;
    collapseQA();
  });

  els.companyName?.addEventListener("input", async (e) => {
    // The user is correcting it — the low-confidence flag no longer applies.
    e.target.classList.remove("ab-low-confidence");
    e.target.removeAttribute("title");
    await savePatch(TAB_ID, { companyName: e.target.value, autoDetectedUrl: null });
    refreshRenameRow(); // reveal Update when this differs from the saved app
  });

  els.roleTitle?.addEventListener("input", async (e) => {
    e.target.classList.remove("ab-low-confidence");
    e.target.removeAttribute("title");
    await savePatch(TAB_ID, { roleTitle: e.target.value, autoDetectedUrl: null });
    refreshRenameRow(); // reveal Update when this differs from the saved app
  });

  // Company / role / JD changed since the last generation means this is a
  // NEW application, not a typo fix — clicking Update pushes the corrected
  // company/role to the saved application (PATCH /me/applications/:id) and
  // then drops the stale generation (Resume/Cover Letter, Auto-fill,
  // Q&A — see clearGeneratedWork) so the panel doesn't keep showing work
  // that was made for the PREVIOUS job. An explicit button rather than a
  // background sync, so the user decides when this happens.
  els.updateAppBtn?.addEventListener("click", async () => {
    const gid = STATE?.generationId;
    if (!gid) return;
    const company = els.companyName?.value?.trim() || "";
    const role = els.roleTitle?.value?.trim() || "";
    const jobText = els.jobText?.value || "";
    if (!company && !role && !jobText) return;
    els.updateAppBtn.disabled = true;
    // Icon-only button — spin the glyph instead of swapping in a text label.
    els.updateAppBtn.classList.add("busy");
    try {
      await apiFetch(`/me/applications/${gid}`, {
        method: "PATCH",
        body: JSON.stringify({ company, role }),
      });
      // Record what the saved application now holds so the row hides again
      // until the next edit. Persisted, so it survives a tab switch.
      await savePatch(TAB_ID, { appCompany: company, appRole: role, appJobText: jobText });
      await clearGeneratedWork();
      panelToast("Application details updated.");
    } catch (err) {
      // A 4xx is the server REJECTING the change (e.g. an API build that
      // predates company/role rename support strips the fields), which is a
      // different fix from a dropped connection.
      const rejected = err?.status >= 400 && err?.status < 500;
      panelToast(
        rejected
          ? "Couldn't update — the server rejected the change (update the API?)."
          : "Couldn't update the application — check your connection.",
        "error",
      );
      console.warn("[rename] failed:", err?.status || "", err?.message || err);
    } finally {
      els.updateAppBtn.classList.remove("busy");
      els.updateAppBtn.disabled = false;
      refreshRenameRow();
    }
  });

  els.detectJobBtn?.addEventListener("click", async () => {
    await detectJobFromActiveTab();
  });

  // Reflects AUTO_APPLY_RUNNING onto the button: label swaps to a live
  // "N / total" progress count (or "Stopping…" the moment Stop is clicked
  // but hasn't taken effect yet), and the other single-tab action buttons
  // are disabled for the duration — Auto Apply IS the "click Generate"
  // action here; letting the user also click it by hand on whatever tab
  // happens to be on screen mid-run would just race the loop's own click.
  // Deliberately just Start ↔ Stop — no per-tab progress/skip-reason text on
  // the button itself (that used to flash past too fast to read anyway, and
  // got replaced by the tab actually changing under it). Every real per-tab
  // result now goes to a STICKY panelToast instead (see runAutoApply /
  // skipTab / watchAutoApplyResult below) — pinned in place until the user
  // dismisses it, so a whole run's worth of "why was this skipped" /
  // "generated & auto-filled" reporting survives tab-switching and stays
  // reviewable after the run finishes, not just for whichever tab happens
  // to be on screen at the moment.
  function setAutoApplyUi(running) {
    if (els.autoApplyBtn) {
      els.autoApplyBtn.classList.toggle("running", running);
      const label = els.autoApplyBtn.querySelector(".btn-text");
      if (label) label.textContent = running ? "Stop" : "Auto Apply";
      els.autoApplyBtn.setAttribute(
        "aria-label",
        running
          ? "Stop Auto Apply"
          : "Auto Apply: run Generate (and Auto-fill) across every open tab, one at a time",
      );
    }
    if (els.detectJobBtn) els.detectJobBtn.disabled = running;
    if (els.autofillBtn) els.autofillBtn.disabled = running;
    if (els.autofillAdvancedBtn) els.autofillAdvancedBtn.disabled = running;
  }

  els.autoApplyBtn?.addEventListener("click", () => {
    if (AUTO_APPLY_RUNNING) {
      AUTO_APPLY_STOP_REQUESTED = true;
      setAutoApplyUi(true);
    } else {
      runAutoApply();
    }
  });

  /**
   * Auto Apply — the "open 50 tabs, Ctrl+Tab + Ctrl+Q, repeat" workflow,
   * automated. Walks every http(s) tab in this window in tab order,
   * activating each one, detecting its job posting, and clicking Generate
   * (which itself auto-chains into Basic Auto-fill for accounts with that
   * capability — see runAutofill's own ctx-based fix) — then moves on
   * after a short pace, WITHOUT waiting for that tab's generation to
   * finish. Generation/auto-fill keep running in the background on their
   * own tab, same as if a person just kept tabbing through faster than any
   * one generation completes; this only automates the "switch tab, press
   * the hotkey" part.
   *
   * A tab is silently skipped (never shown any modal — nothing would be
   * there to click it during an unattended run) when:
   *   - it isn't an http(s) tab, or Detect finds no job description;
   *   - no profile is selected for it and no starred fallback applies;
   *   - the client-side fit check reads "likely skip" (assessJobFit) —
   *     deliberately NOT "check", which is just a caution, not an expected
   *     skip;
   *   - the "already applied" duplicate check finds a match.
   */
  async function runAutoApply() {
    // Used to be Auto-mode-only (see updateManualChatGptStatusBox's own
    // comment) — Manual mode now opens its own fresh ChatGPT tab per job
    // (openFreshBananaChatGptTab), so running this across every open tab
    // works the same in both modes.
    if (AUTO_APPLY_RUNNING) return;
    AUTO_APPLY_RUNNING = true;
    AUTO_APPLY_STOP_REQUESTED = false;
    setAutoApplyUi(true);
    let started = 0;
    let skipped = 0;
    let total = 0;
    try {
      const windowId = CURRENT_WINDOW_ID ?? (await chrome.windows.getCurrent()).id;
      const tabs = (await chrome.tabs.query({ windowId }))
        .filter((t) => t.id != null && /^https?:/i.test(t.url || ""))
        .sort((a, b) => a.index - b.index);
      total = tabs.length;
      // Shared by every skip branch below: a STICKY toast (see panelToast's
      // sticky option) naming the tab and WHY, not just a count — stays on
      // screen after the run moves past that tab, until dismissed by hand,
      // so "why was this one skipped" survives the run instead of only
      // being visible for the one moment that tab was on screen. Still
      // paces the same AUTO_APPLY_PACE_MS a real Generate does.
      const skipTab = async (tab, detail) => {
        skipped++;
        autoApplyNotice("result", tab.id, "Skipped", detail, "warning");
        await new Promise((r) => setTimeout(r, AUTO_APPLY_PACE_MS));
      };
      for (let i = 0; i < tabs.length; i++) {
        if (AUTO_APPLY_STOP_REQUESTED) break;
        const tab = tabs[i];

        try {
          await chrome.tabs.update(tab.id, { active: true });
        } catch {
          skipped++; // tab closed out from under the run — nothing to look at, move on
          continue;
        }
        // Defensive: clear the shared form + cached detect result BEFORE
        // loadForTab runs, so the PREVIOUS tab's company/role/JD can never
        // still be sitting in the DOM at the moment detectJobFromActiveTab's
        // synchronous "already filled" guard checks it (see the
        // chrome.tabs.onActivated listener's own comment on the race this
        // used to hit — that's the actual fix; this is just a second,
        // cheap layer of the same protection).
        if (els.companyName) els.companyName.value = "";
        if (els.roleTitle) els.roleTitle.value = "";
        if (els.jobText) els.jobText.value = "";
        renderJobMeta(null);
        LAST_DETECT_RESULT = null;
        await loadForTab(tab.id);
        if (AUTO_APPLY_STOP_REQUESTED) break;
        await detectJobFromActiveTab({ silent: true });
        if (AUTO_APPLY_STOP_REQUESTED) break;

        const company = els.companyName?.value?.trim() || "";
        const role = els.roleTitle?.value?.trim() || "";
        const jobText = els.jobText?.value?.trim() || "";
        if (!company && !role && !jobText) {
          await skipTab(tab, "No JD detected");
          continue;
        }

        const profileId = selectedProfileId();
        if (!profileId) {
          await skipTab(tab, "No profile selected");
          continue;
        }
        if (els.generateBtn.disabled) {
          await skipTab(tab, "Already generating");
          continue;
        }

        // Fit check — same inputs Generate's own click handler feeds
        // assessJobFit (see its comment there): the full cached Detect
        // result (pageText/jobLocationType/provenance) with title/
        // description overridden by whatever's on screen right now.
        let fitLevel = null;
        try {
          await fetchProfileLinks(profileId);
          if (window.ProactiveJobFit?.assessJobFit) {
            const cached = LAST_DETECT_RESULT || {};
            const fit = window.ProactiveJobFit.assessJobFit(
              { ...cached, title: role || cached.title || "", description: jobText || cached.description || "" },
              { country: PROFILE_LOCATION },
            );
            fitLevel = fit?.level || null;
          }
        } catch {
          /* advisory — a failed fit check never blocks the run */
        }
        if (fitLevel === "skip") {
          await skipTab(tab, "Likely skip (fit check)");
          continue;
        }

        // "Already applied" — the same lookup Generate's own click handler
        // uses, just without the modal: there's nothing here to click it
        // during an unattended run, so a match means skip, not wait.
        let jdUrl = "";
        try {
          const t = await chrome.tabs.get(tab.id);
          if (t && /^https?:/i.test(t.url || "")) jdUrl = t.url;
        } catch {
          /* tab gone — non-fatal, checkRecentDuplicate below just gets "" */
        }
        const match = await fetchRecentDuplicateMatch({ url: jdUrl, company, role, profileId });
        if (match) {
          // Same "Today"/"N hours/days ago" wording the dup-warning modal
          // itself uses — lowercased here since it's embedded mid-sentence
          // instead of starting one.
          const ago = formatAppliedAgo(match.appliedAt);
          await skipTab(tab, `Already applied ${ago === "Today" ? "today" : ago}`);
          continue;
        }

        if (AUTO_APPLY_STOP_REQUESTED) break;
        els.generateBtn.click();
        started++;
        // Not awaited — reports the REAL outcome (generated, generated &
        // auto-filled, or failed) once this tab's background run actually
        // finishes, as its own sticky toast, without blocking the loop
        // from moving on to the next tab in the meantime.
        watchAutoApplyResult(tab.id, company, role);

        await new Promise((r) => setTimeout(r, AUTO_APPLY_PACE_MS));
      }
    } catch (e) {
      console.warn("[auto-apply] run failed:", e?.message || e);
    } finally {
      const stopped = AUTO_APPLY_STOP_REQUESTED;
      AUTO_APPLY_RUNNING = false;
      AUTO_APPLY_STOP_REQUESTED = false;
      setAutoApplyUi(false);
      // The "summary" slot, not "result" — this coexists with (rather than
      // replaces) that same tab's own result notice, and — being tab-
      // scoped like every other Auto Apply notice — only ever shows on the
      // LAST tab the run actually touched (wherever TAB_ID ended up),
      // never on every tab regardless of which one is on screen.
      autoApplyNotice(
        "summary",
        TAB_ID,
        `Auto Apply: ${started} started, ${skipped} skipped of ${total}${stopped ? " — stopped early" : ""}.`,
        "",
        "success",
      );
    }
  }

  // Reports the REAL result of one tab's Generate (+ auto-chained Basic
  // Auto-fill, for accounts with that capability) once it actually
  // finishes — runAutoApply fires this WITHOUT awaiting it, so the loop's
  // own tab-switching pace is never blocked on a generation that can take
  // several seconds. Polls this tab's own persisted state (fetchState
  // works for a background tab same as a visible one) rather than the
  // shared live DOM/globals, which by the time this resolves almost
  // certainly belong to a LATER tab in the run.
  async function watchAutoApplyResult(tabId, company, role) {
    const label = [company, role].filter(Boolean).join(" — ") || `tab ${tabId}`;
    const deadline = Date.now() + 60000; // generous — LLM + PDF render can take a while
    let state = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        state = await fetchState(tabId);
      } catch {
        state = null;
        break;
      }
      // Wait for Generate to leave "generating", THEN — if it succeeded —
      // also wait for RUNNING_TABS to clear for this tab, so a report of
      // "& auto-filled" is never sent before that second step has even
      // started (it only kicks off once Generate's own savePatch resolves).
      if (state?.generatingStatus && state.generatingStatus !== "generating" && !RUNNING_TABS.has(tabId)) break;
    }
    if (state?.generatingStatus === "generated") {
      const filled = AUTOFILL_DONE_TABS.has(tabId);
      autoApplyNotice("result", tabId, filled ? "Generated & Auto-filled" : "Generated", label, "success");
    } else if (state?.generatingStatus === "error") {
      autoApplyNotice("result", tabId, "Generate failed", label, "error");
    } else {
      autoApplyNotice("result", tabId, "Generate didn't finish in time", label, "warning");
    }
  }

  // Manual mode's Generate path: build the same prompt+profile+JD text Auto
  // mode would've sent straight to OpenAI, run it on a FRESH ChatGPT tab
  // opened just for this run (openFreshBananaChatGptTab), then hand
  // ChatGPT's own reply back to the server to parse and finish exactly the
  // way Auto mode's own OpenAI response would have. Returns the same
  // { resultInfo, resultFiles, generationId } shape
  // apiFetchRetry("/full-generate-and-download") resolves with, so nothing
  // downstream of this call (savePatch, tryMarkApplied, the auto-fill
  // chain) needs a branch of its own — see the click handler just below.
  //
  // Every in-flight run gets its own entry in these two maps (job tabId <->
  // ChatGPT tabId), not a shared scalar — several jobs can genuinely be
  // generating at once now (each on its own disposable ChatGPT tab), and a
  // shared "the" tab id would mean Stop could only ever cancel whichever
  // one started last (see GENERATION_ABORT_BY_TAB's own comment, same
  // reasoning). MANUAL_RUN_GPT_TAB_BY_JOB_TAB is read by the Stop button
  // (needs: given the tab on screen, which ChatGPT tab to cancel).
  // MANUAL_JOB_TAB_BY_GPT_TAB is read by the BANANA_STREAM_CHUNK listener
  // below (needs: given the ChatGPT tab a chunk arrived FROM — chrome.
  // runtime.sendMessage broadcasts carry no tab identity of their own, see
  // that listener's own comment — which job tab's button it belongs to).
  const MANUAL_RUN_GPT_TAB_BY_JOB_TAB = new Map();
  const MANUAL_JOB_TAB_BY_GPT_TAB = new Map();
  async function runManualGenerate({ tabId, pid, formCompany, formRole, formJobText, jdUrl, signal, onRetry }) {
    const compose = await apiFetchRetry(
      "/manual-generate/compose",
      {
        method: "POST",
        signal,
        body: JSON.stringify({
          profileId: pid,
          job_description: formJobText,
          company: formCompany,
          role: formRole,
          bulletMin: currentBulletRange().min,
          bulletMax: currentBulletRange().max,
        }),
      },
      { retries: 4, onRetry },
    );
    const promptText = compose?.promptText || "";
    if (!promptText.trim()) throw new Error("Could not build the prompt to send to ChatGPT.");

    let tab;
    try {
      tab = await openFreshBananaChatGptTab();
    } catch (e) {
      throw new Error("Couldn't open a ChatGPT tab: " + (e?.message || e));
    }

    let runRes;
    MANUAL_RUN_GPT_TAB_BY_JOB_TAB.set(tabId, tab.id);
    MANUAL_JOB_TAB_BY_GPT_TAB.set(tab.id, tabId);
    if (tabId === TAB_ID) {
      setButtonText(els.generateBtn, "Sending to ChatGPT…");
    }
    try {
      runRes = await runOnBananaChatGptTab(tab, promptText);
    } finally {
      MANUAL_RUN_GPT_TAB_BY_JOB_TAB.delete(tabId);
      MANUAL_JOB_TAB_BY_GPT_TAB.delete(tab.id);
    }
    if (!runRes?.ok) {
      // Leave the tab open on failure/cancel, on purpose — the user can
      // see what actually happened on the page itself (rate-limited,
      // logged out, a reply that never finished) instead of it vanishing
      // the instant something goes wrong. They can close it themselves.
      const err = new Error(runRes?.error || "ChatGPT didn't respond.");
      if (runRes?.cancelled) err.aborted = true;
      throw err;
    }
    // Disposable — this tab existed only for this one successful run.
    // Best-effort: the user may have already closed it themselves. Removing
    // the sole tab of its own window (see openFreshBananaChatGptTab) closes
    // that window too — standard Chrome behavior, nothing extra to do here.
    chrome.tabs.remove(tab.id).catch(() => {});
    // openFreshBananaChatGptTab already hands focus back right after
    // creating the window (its own brief, deliberate flash — see its own
    // comment) — this is a second, defensive pass in case focus moved
    // somewhere else during the run itself. Best-effort — the job tab may
    // have been closed mid-run, or this may be a background Auto-Apply run
    // whose own tab-cycling will move focus again shortly anyway.
    try {
      const jobTab = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tabId, { active: true });
      if (jobTab.windowId != null) await chrome.windows.update(jobTab.windowId, { focused: true });
    } catch { /* ignore */ }
    if (tabId === TAB_ID) setButtonText(els.generateBtn, "Building your resume…");

    return apiFetchRetry(
      "/manual-generate/finish",
      {
        method: "POST",
        signal,
        body: JSON.stringify({
          profileId: pid,
          job_description: formJobText,
          company: formCompany,
          role: formRole,
          jd_url: jdUrl,
          resumeTemplate: currentResumeTemplateId(),
          aiResponseText: runRes.text || "",
        }),
      },
      { retries: 4, onRetry },
    );
  }

  // Manual mode's live mirror on the Generate button — see the
  // BANANA_STREAM_CHUNK broadcast in chatgpt-bridge.js's waitForAssistantReply.
  // chrome.runtime.sendMessage broadcasts carry no sender-tab identity of
  // their own in the message body, so `sender` (second listener arg,
  // previously ignored here) is what tells two concurrent runs' chunks
  // apart — MANUAL_JOB_TAB_BY_GPT_TAB maps the ChatGPT tab that actually
  // sent this chunk back to the job tab it belongs to; ignored whenever
  // that's not found (no manual run currently owns that ChatGPT tab) or
  // doesn't match the tab on screen, so a stray/late chunk from an
  // already-finished or different job's run can't paint over an unrelated
  // tab's button.
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.type !== "BANANA_STREAM_CHUNK") return;
    const jobTabId = sender?.tab?.id != null ? MANUAL_JOB_TAB_BY_GPT_TAB.get(sender.tab.id) : null;
    if (jobTabId == null || jobTabId !== TAB_ID) return;
    if (msg.done) return; // "Building your resume…" (set right after runOnBananaChatGptTab resolves) wins instead
    // The tail, not the head — the head stays static while only the end
    // keeps growing, so showing the newest text is what actually reads as
    // "abruptly changing" rather than looking stuck.
    const snippet = String(msg.text || "").trim().replace(/\s+/g, " ").slice(-140);
    setButtonText(els.generateBtn, snippet || "ChatGPT is answering…");
  });

  els.generateBtn.addEventListener("click", async () => {
    const tabId = TAB_ID;
    const pid = selectedProfileId();
    if (!pid) {
      setStatus(tabId, "Select a profile first.", "error");
      return;
    }
    if (!els.jobText.value.trim()) {
      setStatus(tabId, "Paste a job description first.", "error");
      return;
    }
    if (RESUME_MODE === "manual" && !isValidManualChatGptUrl(MANUAL_CHATGPT_URL)) {
      panelToast("Set a ChatGPT link first", "error");
      return;
    }
    // Snapshot the form NOW, synchronously, before any await. `els` is the
    // single side-panel DOM shared across every tab — switching tabs mid-
    // generation repopulates it with the OTHER tab's company/role. Reading els
    // after the long generate await (as tryMarkApplied did) therefore stamped
    // this generation with a different tab's job, which is how "clicked
    // Generate on Astronomer" showed up as "GHX" in the dashboard (and how
    // generating on several tabs produced duplicate rows for one company).
    // Capture once here and reuse for the request body AND mark-applied.
    const formCompany = els.companyName?.value?.trim() || "";
    const formRole = els.roleTitle?.value?.trim() || "";
    const formJobText = els.jobText.value || "";

    // Capture the page URL now too (moved up from just before the generate
    // request below) — checkRecentDuplicate needs it BEFORE any of the
    // "generating…" state changes further down, so a real duplicate gates
    // Generate while the button/progress bar still look untouched, instead
    // of flashing into "generating" and then pausing on a modal.
    let jdUrl = "";
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && /^https?:/i.test(tab.url || "")) jdUrl = tab.url;
    } catch {
      /* tab unavailable — skip */
    }
    await checkRecentDuplicate({ tabId, url: jdUrl, company: formCompany, role: formRole, profileId: pid });

    // Re-run the client-side fit assessment on the JD the user is about to
    // submit — recorded as what was true at generate-time on the server row.
    // Feed assessJobFit the EXACT same inputs the Detect-time fit check used:
    // spread the full cached Detect result (untruncated pageText +
    // jobLocationType) and only override title/description with the current
    // form values. Previously this rebuilt a reduced object with pageText
    // truncated to 4096 chars — so a remote signal living past that cut
    // (e.g. the "Location Type: Remote" header) was lost and this disagreed
    // with the Detect-time check. No confirm/block here any more — a poor
    // fit is already surfaced as its own modal right when Detect runs (see
    // openFitWarningModal), so Generate itself no longer re-asks.
    let fitPayload = null;
    let pageContextPayload = null;
    try {
      if (window.ProactiveJobFit?.assessJobFit) {
        const cached = LAST_DETECT_RESULT || {};
        const fit = window.ProactiveJobFit.assessJobFit(
          {
            ...cached,
            title: els.roleTitle?.value || cached.title || "",
            description: els.jobText?.value || cached.description || "",
          },
          { country: PROFILE_LOCATION },
        );
        if (fit?.level) {
          fitPayload = { level: fit.level, reasons: fit.reasons || [] };
        }
        // The server payload stays capped to keep the request small — only the
        // client-side gate above needs the full haystack.
        const trimmedPageText = String(cached.pageText || "").slice(0, 4096);
        const jobLocationType = String(cached.jobLocationType || "");
        if (trimmedPageText || jobLocationType) {
          pageContextPayload = { pageText: trimmedPageText, jobLocationType };
        }
      }
    } catch {
      /* fit is advisory — never block generation on a snag here */
    }

    // { toast: false }: the progress bar (started just below) is about to take
    // over surfacing this in-panel — no need for a page toast on top of it.
    setStatus(tabId, "Generating resume and cover letter…", "loading", { toast: false });
    if (tabId === TAB_ID) {
      els.generateBtn.disabled = true;
      // No "Generating…" placeholder — startGenerationProgress (just below)
      // sets the button's label to the real, evolving stage text instead.
      renderKeyChip(els.generateHotkey, "");
    }
    // Re-generating (info/files already set from a previous run) must not
    // leave the Resume/Cover Letter checklist showing "done" with stale
    // data while the new run is still in flight — clear them now, the same
    // reset a newly-detected job already gets (see the DETECT handler's own
    // comment on this exact sequence), so the checklist/buttons go back to
    // blank immediately and only re-populate once THIS run actually finishes.
    await savePatch(tabId, {
      generatingStatus: "generating",
      generatingStartedAt: Date.now(),
      genError: null,
      info: null,
      files: [],
      submitted: false,
    });
    AUTOFILL_DONE_TABS.delete(tabId);
    RESUME_UPLOADED_TABS.delete(tabId);
    if (tabId === TAB_ID) {
      refreshResumeCoverActions();
      syncMarkAppliedRow();
      // The Auto-fill button's own gradient fill (left over from a PREVIOUS
      // run on this tab) has to go back to plain white too, not just the
      // checklist row above — same reset stopAutofillProgress already does
      // for an aborted/failed Auto-fill run.
      stopAutofillProgress();
    }
    startGenerationProgress(tabId);
    // Fresh abort controller for THIS tab's run so the Stop button can
    // cancel it without touching any other tab's concurrent run.
    const thisGenerationAbort = new AbortController();
    GENERATION_ABORT_BY_TAB.set(tabId, thisGenerationAbort);
    // jdUrl itself was already captured above, before checkRecentDuplicate.

    try {
      // Send the user-typed Company / Role so the server can record them on
      // the generation row — even when the JD extractor can't infer them.
      // Auto mode's own request/params are untouched below; Manual mode
      // reuses the same onRetry status line while it runs its compose →
      // ChatGPT → finish round trip instead (runManualGenerate above).
      const onRetry = (attempt, max) => {
        setStatus(tabId, `Connection lost — retrying (${attempt}/${max})…`, "loading");
      };
      const resp =
        RESUME_MODE === "manual"
          ? await runManualGenerate({
              tabId,
              pid,
              formCompany,
              formRole,
              formJobText,
              jdUrl,
              signal: thisGenerationAbort.signal,
              onRetry,
            })
          : await apiFetchRetry(
              "/full-generate-and-download",
              {
                method: "POST",
                signal: thisGenerationAbort.signal,
                body: JSON.stringify({
                  profileId: pid,
                  job_description: formJobText,
                  company: formCompany,
                  role: formRole,
                  jd_url: jdUrl,
                  resumeTemplate: currentResumeTemplateId(),
                  bulletMin: currentBulletRange().min,
                  bulletMax: currentBulletRange().max,
                  ...(fitPayload ? { fit: fitPayload } : {}),
                  ...(pageContextPayload ? { page_context: pageContextPayload } : {}),
                  ...currentKeySelection(),
                }),
              },
              { retries: 4, onRetry },
            );

      const info = resp?.resultInfo || null;
      const files = resp?.resultFiles || [];
      // Surface the tone the server picked for this generation.
      updateToneDisplay(info?.job_data?.recommended_tone || null);

      await savePatch(tabId, {
        generatingStatus: "generated",
        info,
        files,
        generationId: resp?.generationId || null,
        appCompany: formCompany || info?.job_data?.company_name || "",
        appRole: formRole || info?.job_data?.job_title || "",
        appJobText: formJobText,
        qa: STATE?.qa || [],
      });
      renderQA(tabId);

      // Track the application in the dashboard right on Generate — restores
      // the pre-removal behaviour where clicking Download CV promoted the row
      // from draft to "applied". The user's flow is now Generate → Auto-fill,
      // so generating is the commit point. Best-effort + self-healing via the
      // retry queue; passes the latest company / role / JD URL from the form.
      if (resp?.generationId) {
        await tryMarkApplied(resp.generationId, {
          company: formCompany,
          role: formRole,
          jdUrl,
        });
      }

      if (tabId === TAB_ID) {
        els.qaSection.classList.remove("hidden");
        els.askBtn.disabled = false;
        if (els.qaInput) els.qaInput.disabled = false;
        // Resume/Cover Letter's View/Copy/Download buttons — STATE.info was
        // just updated above (savePatch), but nothing else re-derives the
        // UI from it until the next tab switch/reopen without this.
        refreshResumeCoverActions();
        syncMarkAppliedRow();
      }

      stopGenerationProgress({ success: true });
      setStatus(tabId, "Generated successfully.", "success", { toast: false });
      notifyResumeGenerated({
        company: formCompany || info?.job_data?.company_name || "",
        role: formRole || info?.job_data?.job_title || "",
        profileName: PROFILES_BY_ID.get(pid)?.name || "",
      });
    } catch (e) {
      stopGenerationProgress();
      // User hit Stop — not a failure. Clear back to the ready state (inputs
      // intact) so the button returns to "Generate", no red error. Handle both
      // our tagged abort and a raw AbortError (e.g. cancelled mid-body-read).
      if (e?.aborted || e?.name === "AbortError") {
        setStatus(tabId, "Generation stopped.", "idle");
        await savePatch(tabId, {
          generatingStatus: null,
          genError: null,
          generatingStartedAt: null,
        });
      } else {
        // Don't reset to the blank default — that's what made users re-enter
        // and regenerate from scratch. Park in an "error" state that keeps the
        // company / role / JD intact and exposes a one-click Retry. Transient
        // drops were already auto-retried inside apiFetchRetry; reaching here
        // means it's still failing (server down / offline / hard error).
        const transient = isTransientError(e);
        const msg = transient
          ? "Connection problem — your inputs are saved. Click Retry when you're back online."
          : "Generate failed: " + humaniseProviderError(e.message);
        setStatus(tabId, msg, "error");
        await savePatch(tabId, {
          generatingStatus: "error",
          genError: msg,
          generatingStartedAt: null,
        });
      }
    } finally {
      // Only clear THIS run's entry — a guard against the rare case where
      // the user re-clicked Generate on the same tab before this run's
      // finally ran, whose own fresh entry must survive this cleanup.
      if (GENERATION_ABORT_BY_TAB.get(tabId) === thisGenerationAbort) {
        GENERATION_ABORT_BY_TAB.delete(tabId);
      }
      if (tabId === TAB_ID) {
        const t = await getToken();
        const generating = STATE?.generatingStatus === "generating";
        els.generateBtn.disabled = !t || generating || !generateGateOk();
        setButtonText(els.generateBtn, generateBtnLabel(STATE?.generatingStatus));
        renderKeyChip(els.generateHotkey, generating ? "" : HOTKEY_GENERATE);
      }
    }
  });

  els.stopGenerateBtn?.addEventListener("click", async () => {
    const tabId = TAB_ID;
    // Cancel the in-flight request for THIS tab specifically — other tabs'
    // concurrent runs (if any) are untouched.
    const thisAbort = GENERATION_ABORT_BY_TAB.get(tabId);
    if (thisAbort) {
      try { thisAbort.abort(); } catch { /* already settled */ }
      GENERATION_ABORT_BY_TAB.delete(tabId);
    }
    // Manual mode: also tell the ChatGPT tab to stop waiting on its own
    // in-flight run, same as gpt-extension's own cancelRunningStep — best
    // effort, NOT awaited. This used to block the UI reset below on this
    // message round-trip resolving, which is exactly backwards: a slow or
    // never-answering tab (closed, navigated, busy) made Stop look
    // completely dead — click it, nothing visibly happens. The abort above
    // already unblocks THIS panel regardless of whether the ChatGPT tab is
    // even still there to hear the cancel, so the reset below must never
    // wait on it.
    const thisManualGptTab = MANUAL_RUN_GPT_TAB_BY_JOB_TAB.get(tabId);
    if (thisManualGptTab != null) {
      chrome.tabs.sendMessage(thisManualGptTab, { type: "BANANA_CANCEL_RUN" }).catch(() => {
        /* no tab, or nothing to cancel */
      });
    }
    // Reset the UI immediately rather than waiting on the request's own catch:
    // the request may be mid-retry-backoff, or there may be NO live request at
    // all in this panel (a "generating" state resumed from persisted state on
    // panel reopen). Either way, Stop must visibly respond.
    stopGenerationProgress();
    setStatus(tabId, "Generation stopped.", "idle");
    await savePatch(tabId, {
      generatingStatus: null,
      genError: null,
      generatingStartedAt: null,
    });
    if (tabId === TAB_ID) {
      const t = await getToken();
      els.generateBtn.disabled = !t || !generateGateOk();
      setButtonText(els.generateBtn, "Generate Resume");
      renderKeyChip(els.generateHotkey, HOTKEY_GENERATE);
    }
  });

  // -----------------------------------------------------------------
  // Auto-fill
  // -----------------------------------------------------------------
  // One click flow:
  //   1. Pull the live profile data (contact block) from /me/profiles/:id.
  //   2. Pull the most recently generated PDF for this tab — either from
  //      the current tab state (if the user JUST generated) or from the
  //      saved Generation row (if they generated earlier).
  //   3. chrome.runtime.sendMessage({ type: "AUTOFILL_FILL", tabId, ... })
  //      — the background SW forwards to the content script in the
  //      active tab; the content script detects fields, fills them,
  //      and attaches the PDF to the resume input.
  //   4. Display the result summary in the small status box under
  //      the button: "Filled 6 of 7 fields on Greenhouse · resume
  //      attached".
  /**
   * Shared auto-fill runner. Two modes:
   *
   *   mode = "basic"
   *     - Loads the selected profile.
   *     - Uses an existing saved CV (the tab's last generated PDF, or
   *       the most-recent saved application's PDF).
   *     - Fills contact + presets + attaches the saved CV.
   *     - SKIPS the /answer-questions LLM round-trip — free-text
   *       textareas are left blank. No LLM cost.
   *
   *   mode = "advanced"
   *     - Loads the selected profile.
   *     - Calls /full-generate-and-download to produce a FRESH CV
   *       tailored to the current JD.
   *     - Fills contact + presets + attaches the freshly generated CV.
   *     - Calls /answer-questions to LLM-answer free-text screening
   *       textareas and types each answer into the matching field.
   *     - Requires autofill_advanced + cv_generate + answer_questions
   *       capabilities — server enforces them on each call.
   *
   * Both modes display progress in the shared status box.
   */
  // The autofill content-script chain, in dependency order. MUST stay in
  // sync with manifest.json's second content_scripts entry. Files-injected
  // before a fill so SPA pages that didn't get the declarative injection
  // still have window.ProactiveAutofill.
  const AUTOFILL_FILES = [
    "autofill/_bootstrap.js",
    "autofill/core/dom.js",
    "autofill/core/react-input.js",
    "autofill/core/values.js",
    "autofill/detectors/contact.js",
    "autofill/detectors/dropdowns.js",
    "autofill/detectors/checkbox-groups.js",
    "autofill/detectors/phone-country.js",
    "autofill/detectors/questions.js",
    "autofill/detectors/files.js",
    "autofill/detectors/consent.js",
    "autofill/detectors/rating.js",
    "autofill/pipeline/registry.js",
    "autofill/handlers/adapters/greenhouse.js",
    "autofill/handlers/adapters/lever.js",
    "autofill/handlers/adapters/workday.js",
    "autofill/handlers/presets/screening.js",
    "autofill/pipeline/basic.js",
    "autofill/pipeline/advanced.js",
    "autofill/ui/banner.js",
    "autofill.js",
  ];

  async function ensureAutofillInjected(tabId) {
    if (!tabId || !chrome?.scripting?.executeScript) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: AUTOFILL_FILES,
      });
    } catch (e) {
      // Restricted page / no host access — the declaratively-injected
      // content script (if any) still answers; this is best-effort.
      console.warn("[autofill] pre-inject failed:", e?.message || e);
    }
  }

  // `ctx` lets a caller target a SPECIFIC tab/profile/company/role/state
  // snapshot instead of "whichever tab is on screen right now" — every read
  // in this function (TAB_ID, els.*, STATE, selectedProfileId()) otherwise
  // tracks the VISIBLE tab, which is exactly wrong for the post-Generate
  // auto-chain: Generate can take several seconds, and if the user has
  // already switched to a different tab by the time it finishes, "whichever
  // tab is visible" is no longer the tab that just generated. That mismatch
  // used to make the auto-chain skip itself outright (tabId !== TAB_ID) —
  // silently, so Auto-fill looked "flaky": it ran when you stayed put,
  // vanished the moment you tabbed away mid-generation. Passing an explicit
  // ctx here (see the Generate handler's own call site) makes the run
  // target the right tab either way. A manual button click passes no ctx,
  // so every field below falls back to the exact same live reads as before.
  async function runAutofill(mode, ctx = {}) {
    const advanced = mode === "advanced";
    const requiredCap = advanced ? "autofill_advanced" : "autofill";
    // The tab this run is for. TAB_ID is a LIVE global that re-points at
    // whatever tab the side panel is showing — reading it AFTER the awaits
    // below (profile fetch, CV generation, cover-letter export — seconds)
    // would send the fill to whichever tab the user had since switched to.
    // Everything tab-directed below uses this snapshot (or ctx.tabId)
    // instead of the live global.
    const clickTabId = ctx.tabId ?? TAB_ID;
    // Panel chatter belongs to the originating tab too — once the user
    // switches away (or was already elsewhere when a background run
    // started), this run must not paint over another tab's panel.
    const status = (m, t) => { if (clickTabId === TAB_ID) setAutofillStatus(m, t); };
    if (!can(requiredCap)) {
      status(
        `${advanced ? "Advanced Auto-fill" : "Auto-fill"} is disabled for your account. Contact your administrator.`,
        "error",
      );
      return;
    }
    const profileId = ctx.profileId ?? selectedProfileId();
    if (!profileId) {
      status("Pick a profile first.", "error");
      return;
    }
    // Per-profile gate. Dashboard admins can flip
    // profile.autofillEnabled = false to make a profile generate-only
    // even when the owning user has the autofill capability granted.
    // Bypasses an immediate /me/profiles round-trip by reading the
    // cached PROFILE_OPTIONS flag — the canonical check still happens
    // server-side at the /full-generate-and-download / /answer-questions
    // capability gate (those are the network-side enforcements).
    if (!activeProfileAutofillEnabled(profileId)) {
      status(
        "Auto-fill is disabled for this profile. Switch to another profile or enable it in the dashboard.",
        "error",
      );
      return;
    }
    // Snapshot the form NOW, before any await, UNLESS ctx already supplies
    // it (the auto-chain has its own click-time snapshot from the Generate
    // handler, which is what belongs to the tab that actually generated —
    // a live els/STATE read here would grab whichever tab is on screen
    // instead). els is the single side-panel DOM shared across every tab,
    // so reading it after an await risked stamping this application with a
    // different tab's job (same root cause as the Generate-button
    // relabelling bug this pattern was introduced to fix).
    const clickCompany = ctx.company ?? (els.companyName?.value?.trim() || STATE?.companyName || "");
    const clickRole = ctx.role ?? (els.roleTitle?.value?.trim() || STATE?.roleTitle || "");
    // Refuse a SECOND run on the SAME tab, but never block other tabs:
    // the button is one shared DOM node, so the old global `disabled`
    // locked Auto-fill everywhere while any single tab was filling.
    if (RUNNING_TABS.has(clickTabId)) return;
    RUNNING_TABS.add(clickTabId);
    syncAutofillButtons();
    // This run's own view of the tab's state: ctx.state when the caller
    // already has it (the auto-chain, straight from Generate's own
    // savePatch result), else STATE ONLY when this run's tab is the one
    // currently on screen — never another tab's STATE, which would pull a
    // different job's JD / generated info into THIS run.
    let runState = ctx.state ?? (clickTabId === TAB_ID ? STATE : null);
    const clickGenerationId = runState?.generationId || null;
    // Set true only once the try block runs to its natural end — an early
    // `return` (missing JD, disabled profile, etc.) or a caught error both
    // leave this false, so the finally block below knows whether to give
    // the progress bar its "done" flourish or just drop it.
    let ranOk = false;
    // Set from the AUTOFILL_FILL reply below — read in the finally block to
    // update the "Resume Uploaded" check-row, which tracks specifically
    // whether the resume file got attached, separately from whether the
    // rest of the form got filled.
    let resumeUploadedThisRun = false;
    // Returned to the caller (see the Autofill button's own click handler)
    // so it can reconcile the Form Questions modal's review list against
    // what this run actually wrote — see applyAutofillResultToReview's own
    // comment. Stays null unless the
    // AUTOFILL_FILL round trip below actually came back ok.
    let fillSummaryForReview = null;
    try {
      status("Loading profile…", "loading");
      // See autofillProfileFromBcd's own comment — converts BCD's flat
      // profile shape into the nested `{ data: {...} }` shape the autofill
      // pipeline (below) and /full-generate-and-download both expect.
      const prof = { profile: autofillProfileFromBcd(PROFILES_BY_ID.get(profileId)) };
      if (!prof?.profile) throw new Error("Couldn't load profile data.");

      // ----- Resolve the resume PDF to attach -----
      let pdfBase64 = "";
      let pdfFilename = "resume.pdf";

      if (advanced) {
        // Advanced flow always generates a fresh CV from the current JD.
        // Mirrors the Generate button's call shape so the result row
        // also lands in /me/applications and the tab state stays
        // coherent.
        const jdText = (runState?.jobText || els.jobText?.value || "").trim();
        if (!jdText) {
          status(
            "Advanced Auto-fill needs a JD. Paste one above (or Detect from the page) and re-run.",
            "error",
          );
          return;
        }
        status("Generating a tailored CV…", "loading");
        const company = clickCompany;
        const role = clickRole;
        let jdUrl = "";
        try {
          const tab = await chrome.tabs.get(clickTabId);
          if (tab && /^https?:/i.test(tab.url || "")) jdUrl = tab.url;
        } catch {/* tab unavailable — non-fatal */}
        const genResp = await apiFetch("/full-generate-and-download", {
          method: "POST",
          body: JSON.stringify({
            profileId,
            job_description: jdText,
            company,
            role,
            jd_url: jdUrl,
            resumeTemplate: currentResumeTemplateId(),
            bulletMin: currentBulletRange().min,
            bulletMax: currentBulletRange().max,
            ...currentKeySelection(),
          }),
        });
        const tabFile = findResumeFile(genResp?.resultFiles);
        if (tabFile?.file) {
          pdfBase64 = tabFile.file;
          // The server's own file name is always the generic "resume.pdf"/
          // "resume.docx" (see buildFilenameFromTemplate's own comment) —
          // that's what a target site's own upload widget showed
          // ("RESUME.PDF") regardless of the Settings > Other > File Names
          // template configured here. Run it through the SAME template the
          // Download button already does, so an auto-filled resume is named
          // the same way a downloaded one would be.
          pdfFilename = buildFilenameFromTemplate(
            FILENAME_RESUME,
            { ...currentProfileFilenameVars(), company, role },
            extOf(tabFile.name, "pdf"),
            "resume",
          );
        }
        // Persist the fresh generation so the rest of the panel sees it
        // (Download CV / Save buttons re-enable, the QA section can use
        // the new info, the tab gets the resultInfo cached).
        const savedState = await savePatch(clickTabId, {
          generatingStatus: "generated",
          info: genResp?.resultInfo || null,
          files: genResp?.resultFiles || [],
          generationId: genResp?.generationId || null,
          appCompany: company || genResp?.resultInfo?.job_data?.company_name || "",
          appRole: role || genResp?.resultInfo?.job_data?.job_title || "",
          appJobText: jdText,
        });
        // Keep THIS run's view of the tab current — the global STATE is
        // only updated when the tab happens to be on screen.
        if (savedState) runState = savedState;
        // savePatch updates runState but doesn't re-render — without this
        // explicit call the Download CV / Cover Letter / Follow-up
        // (QA) controls stay disabled until the user switches tabs
        // and back, which is what triggers loadForTab → applyStateToUI.
        // …but only when that tab is still the one on screen. If the user
        // switched away mid-run, re-rendering here would paint THIS tab's
        // generation over the tab they're now looking at; coming back to
        // it re-binds via loadForTab anyway.
        if (clickTabId === TAB_ID) await applyStateToUI(clickTabId, runState);

        // Promote the generation row to "applied" so the dashboard's
        // calendar shows it as a real application, not a draft. Best-effort;
        // self-heals via the retry queue on transient failures.
        try {
          if (genResp?.generationId) {
            // Use the company/role captured at click time — NOT a live els read,
            // which would be a different tab's job after a mid-generation tab
            // switch. Fall back to what the server extracted from the JD when the
            // form was blank. jdUrl was captured (above) against this tab too.
            const info = genResp?.resultInfo || {};
            await tryMarkApplied(genResp.generationId, {
              company: company || info.job_data?.company_name || "",
              role: role || info.job_data?.job_title || "",
              jdUrl,
            });
          }
        } catch (markErr) {
          console.warn("[autofill/advanced] mark-applied skipped:", markErr);
        }
      } else {
        // Basic flow — prefer the just-generated buffer the tab already
        // has so the auto-fill uses whatever CV the user last
        // downloaded. Falls back to fetching the most recent saved
        // application's resume. Same company/role fallback chain
        // downloadGeneratedCv's own filename build uses.
        // clickCompany/clickRole (captured pre-await at click time), NOT a
        // live els/STATE read — both track the VISIBLE tab, which may no
        // longer be this run's tab by the time this runs (same hazard the
        // click-time snapshot above exists to avoid).
        const company = runState?.appCompany || clickCompany;
        const role = runState?.appRole || clickRole;
        const tabFile = findResumeFile(runState?.files);
        if (tabFile?.file) {
          pdfBase64 = tabFile.file;
          // Same reasoning as the advanced branch above — the raw file name
          // off the tab's own state is the server's generic default, not
          // the customized template.
          pdfFilename = buildFilenameFromTemplate(
            FILENAME_RESUME,
            { ...currentProfileFilenameVars(), company, role },
            extOf(tabFile.name, "pdf"),
            "resume",
          );
        } else if (runState?.generationId) {
          try {
            const r = await apiFetch(`/me/applications/${runState.generationId}`);
            if (r?.application?.pdfBase64) {
              pdfBase64 = r.application.pdfBase64;
              const ext = r.application.resumeFileType === "doc" ? "docx" : "pdf";
              pdfFilename = buildFilenameFromTemplate(
                FILENAME_RESUME,
                { ...currentProfileFilenameVars(), company, role },
                ext,
                r.application.resume?.contact?.full_name || "resume",
              );
            }
          } catch {/* non-fatal — fields still fill, user attaches CV manually */}
        }
      }

      // Cover letter material — assembled for BOTH Basic and Advanced.
      // Both surfaces are supported:
      //   - <input type=file> labelled "cover letter" → coverLetterPdfBase64
      //   - <textarea> labelled "cover letter" → coverLetterText
      // The content script picks whichever is present on the form.
      let coverLetterText = "";
      let coverLetterPdfBase64 = "";
      let coverLetterFilename = "cover_letter.pdf";
      const info = runState?.info || {};
      // Strip the **bold** / __italic__ markdown markers the PDF
      // builder leaves in the raw cover_letter — a textarea on the
      // application form renders them verbatim and the user sees
      // "**FastAPI**" in their submitted cover letter. The PDF path
      // is unaffected because buildCoverPdf reads the raw string
      // server-side; only the textarea-paste path needs cleanup.
      // Mirrors the Copy button's behaviour (stripCoverMarkdown) so
      // copy-vs-autofill produce identical plain prose.
      coverLetterText = stripCoverMarkdown(String(info.cover_letter || "").trim());
      // First try to pull the cover-letter PDF directly from
      // runState.files — /full-generate-and-download returns BOTH
      // resume.pdf and cover_letter.pdf there, so the Basic flow
      // (which doesn't regenerate) gets a free attach. We look for
      // files whose filename hints "cover".
      const cachedCover = (runState?.files || []).find(
        (f) => f && /cover/i.test(f.filename || "") && /\.pdf$/i.test(f.filename || "") && f.url?.startsWith("data:"),
      );
      if (cachedCover?.url) {
        coverLetterPdfBase64 = cachedCover.url.replace(/^data:[^,]+,/, "");
        coverLetterFilename = cachedCover.filename || coverLetterFilename;
      }
      if (!coverLetterPdfBase64 && coverLetterText) {
        // No cached cover PDF — render one server-side now, in BOTH
        // Basic and Advanced. Greenhouse's "Cover Letter → Attach"
        // slot needs an actual PDF file, and the Basic flow used to
        // skip this render (gated on `advanced`), so on a Greenhouse
        // page whose last generation didn't cache a cover PDF the
        // cover letter never got attached at all. We only hit
        // /export/cover when we actually have cover text — this is a
        // pure text→PDF export of the ALREADY-generated cover letter,
        // not a re-generation, so it's cheap and doesn't change the
        // Basic flow's "don't regenerate content" contract.
        try {
          const exp = await apiFetch("/export/cover?type=pdf", {
            method: "POST",
            body: JSON.stringify({
              cover_letter: info.cover_letter || coverLetterText,
              resume: info.resume,
              job_data: info.job_data,
            }),
          });
          const f = exp?.file;
          if (f && f.base64) {
            coverLetterPdfBase64 = String(f.base64).replace(/^data:[^,]+,/, "");
            if (f.name) coverLetterFilename = f.name;
          }
        } catch {
          // Non-fatal — the paste-text path may still work.
        }
      }

      // ----- Run the fill on the page -----
      // Guarantee the autofill content-script chain is present first. On
      // SPA application pages (Rippling, Ashby, …) a route change or a
      // late-rendered apply form can leave the tab without window
      // .ProactiveAutofill, which surfaced as "Auto-fill couldn't
      // initialise … (missing ns(window.ProactiveAutofill))". Files-inject
      // the chain (mirror of Detect); the IIFE guards make it idempotent.
      await ensureAutofillInjected(clickTabId);
      status("Filling the form…", "loading");
      const reply = await chrome.runtime.sendMessage({
        type: "AUTOFILL_FILL",
        tabId: clickTabId,
        profile: prof.profile,
        pdfBase64,
        pdfFilename,
        jobText: runState?.jobText || "",
        coverLetterPdfBase64,
        coverLetterFilename,
        coverLetterText,
      });
      if (!reply?.ok) {
        status(reply?.error || "Auto-fill failed.", "error");
        return;
      }
      resumeUploadedThisRun = !!reply.resumeAttached;
      fillSummaryForReview = {
        filled: reply.filled || [],
        presetFilled: reply.presetFilled || [],
        questionsFilledOk: [],
      };
      const n = reply.filled?.length || 0;
      const total = n + (reply.skipped?.length || 0);
      const presets = reply.presetFilled?.length || 0;
      // Still used further below in the screening-answers status messages
      // (allBad/qFilled/qFailed branches) — only the plain "Filled N
      // fields..." success/error summary that used to read this got removed.
      const resume = reply.resumeAttached ? " · resume attached" : "";
      const adapter = reply.adapter ? ` on ${reply.adapter}` : "";
      const detectedQs = Array.isArray(reply.questions) ? reply.questions.length : 0;
      const detectedDds = Array.isArray(reply.dropdowns) ? reply.dropdowns.length : 0;
      const anythingFilled = n > 0 || presets > 0 || reply.resumeAttached;
      const anythingToDo = anythingFilled || detectedQs > 0 || detectedDds > 0;
      // No form on the page is a distinct outcome from "tried but
      // failed" or "everything was already filled" — disambiguate
      // before showing the confusing "Open the application form
      // first" message.
      if (!anythingToDo && total === 0) {
        // Ask the page how many empty fields remain. If there ARE
        // empty fields we just can't recognise, the form is real
        // but the detector doesn't cover it. If there are NONE, the
        // form is already fully filled — most often because the
        // user clicked Auto-fill twice.
        let emptyOnPage = null;
        try {
          const c = await chrome.runtime.sendMessage({
            type: "AUTOFILL_COUNT_EMPTY",
            tabId: clickTabId,
          });
          // Only trust the number when the reply itself is OK. A
          // missing/failed content script returns { ok: false } here,
          // and falling back to `0` would falsely render that as
          // "Form is already fully filled" — leaving the user staring
          // at empty fields wondering what went wrong. `null` keeps
          // the message neutral instead.
          if (c?.ok && typeof c.total === "number") {
            emptyOnPage = c.total;
          }
        } catch {/* count is best-effort */}
        if (emptyOnPage === 0) {
          // Nothing to report — most often the user clicked Auto-fill twice.
          // No status message here on purpose (was "Form is already fully
          // filled — nothing left to do.").
        } else if (emptyOnPage && emptyOnPage > 0) {
          status(
            `Auto-fill couldn't recognise the fields on this page (${emptyOnPage} empty). The form may use a non-standard layout — fill manually or report the page.`,
            "idle",
          );
        } else {
          status(
            "No fillable form fields were detected on this page. Open the application form first, then try again.",
            "idle",
          );
        }
        return;
      }
      // If we only have LLM-bound work (no immediate fills), say so
      // explicitly so the user understands the next phase is screening
      // answers, not contact fills. When something WAS filled, no separate
      // "done" message — the Auto-fill button's own progress fill (see
      // stopAutofillProgress) already reads as the completion signal.
      if (!anythingFilled && (detectedQs > 0 || detectedDds > 0)) {
        status(
          `Detected ${detectedQs + detectedDds} screening question${(detectedQs + detectedDds) === 1 ? "" : "s"}${adapter} — generating answers…`,
          "loading",
        );
      }

      // Basic Auto-fill is now the primary "I'm submitting this application"
      // action (Download CV was removed), so promote the row to "applied" so
      // the dashboard tracks it. Advanced already marked it after its own
      // generation, hence the !advanced gate. Best-effort + self-healing.
      if (!advanced && anythingFilled && clickGenerationId) {
        try {
          let jdUrl = "";
          try {
            const t = await chrome.tabs.get(clickTabId);
            if (t && /^https?:/i.test(t.url || "")) jdUrl = t.url;
          } catch {/* tab gone — non-fatal */}
          // Company / role / generation id captured at click time (above) — a
          // live els / runState read here would attach a different tab's job if
          // the user switched tabs during the fill.
          await tryMarkApplied(clickGenerationId, {
            company: clickCompany,
            role: clickRole,
            jdUrl,
          });
        } catch {/* mark-applied is best-effort */}
      }

      // ----- LLM-backed screening answers ----------
      // Two surfaces in one round-trip:
      //   - Free-text textareas  → reply.questions  ([{ id, label }])
      //   - Unfilled dropdowns   → reply.dropdowns  ([{ id, label, options }])
      //
      // Free-text questions are answered in BOTH Basic and Advanced
      // modes — the user expects "click Basic, see follow-up answers
      // pasted into the form" (matches the Ask flow's behaviour but
      // automated for every unfilled textarea at once). Dropdowns
      // stay Advanced-only: a wrong dropdown is harder to spot and
      // unwind than a wrong textarea, so we keep them behind the
      // explicit Advanced opt-in.
      const questions = Array.isArray(reply.questions) ? reply.questions : [];
      const dropdowns = Array.isArray(reply.dropdowns) ? reply.dropdowns : [];
      const jd = (runState?.jobText || "").trim();
      const wantsLlmText = questions.length > 0 && jd;
      const wantsLlmDropdowns = advanced && dropdowns.length > 0 && jd;
      const wantsLlm = wantsLlmText || wantsLlmDropdowns;
      const askCount =
        (wantsLlmText ? questions.length : 0) +
        (wantsLlmDropdowns ? dropdowns.length : 0);
      if (wantsLlm) {
        status(
          `Generating ${askCount} screening answer${askCount === 1 ? "" : "s"}…`,
          "loading",
        );
        try {
          // Build a unified question batch. Free-text questions are
          // sent as plain strings (back-compat with the older server
          // schema). Only constrained-choice dropdowns are sent as
          // { label, options } objects so the LLM picks verbatim. In
          // Basic mode dropdowns aren't included, so the batch is
          // text-only and the dropdown-fill round-trip is skipped.
          const batch = [
            ...(wantsLlmText ? questions.map((q) => q.label) : []),
            ...(wantsLlmDropdowns ? dropdowns.map((d) => ({ label: d.label, options: d.options })) : []),
          ];
          const ar = await apiFetch("/answer-questions", {
            method: "POST",
            body: JSON.stringify({
              profileId,
              questions: batch,
              job_data: runState?.info?.job_data || {
                company_name: runState?.companyName || "",
                job_title: runState?.roleTitle || "",
                job_description: jd,
              },
              resume: runState?.info?.resume || null,
              ...currentKeySelection(),
            }),
          });
          const serverAnswers = Array.isArray(ar?.answers) ? ar.answers : [];
          // Index back into serverAnswers using the same conditional
          // shape as the batch builder — text-only batches (Basic mode)
          // would otherwise misalign indices if we blindly indexed past
          // questions.length into the (non-existent) dropdown segment.
          const qa = wantsLlmText
            ? questions.map((q, i) => ({
                id: q.id,
                label: q.label,
                answer: serverAnswers[i]?.answer || "",
              }))
            : [];
          const dropdownsOffset = wantsLlmText ? questions.length : 0;
          const da = wantsLlmDropdowns
            ? dropdowns.map((d, i) => ({
                id: d.id,
                label: d.label,
                answer: serverAnswers[dropdownsOffset + i]?.answer || "",
              }))
            : [];
          // Fill both surfaces.
          const [qReply, dReply] = await Promise.all([
            qa.length
              ? chrome.runtime.sendMessage({
                  type: "AUTOFILL_FILL_QUESTIONS",
                  tabId: clickTabId,
                  answers: qa,
                })
              : Promise.resolve({ filled: 0, failed: 0 }),
            da.length
              ? chrome.runtime.sendMessage({
                  type: "AUTOFILL_FILL_DROPDOWNS",
                  tabId: clickTabId,
                  answers: da,
                })
              : Promise.resolve({ filled: 0, failed: 0 }),
          ]);
          let qFilled = (qReply?.filled || 0) + (dReply?.filled || 0);
          let qFailed = (qReply?.failed || 0) + (dReply?.failed || 0);
          // Track the answers actually used so we can log them to the
          // Follow-up history below. Retry (if it fires) overwrites this
          // with the better second-pass answers.
          let usedQa = qa;
          // Sanity-check the LLM output. When every textarea answer
          // comes back empty or matches a refusal phrase ("Based on the
          // provided profile, I cannot confirm this." / "cannot
          // answer"), the batch is a wash. Historically we blamed a
          // stale server prompt — but the server already carries the
          // retry-on-refusal path (proactive-server/routes/
          // answerQuestions.js), so an all-bad batch now almost always
          // means the upstream LLM had a transient wobble (rate limit,
          // provider hiccup, cold-start). Give it ONE more shot from
          // the client before surfacing an error.
          const refusalRe = /\b(?:based on the provided profile|cannot confirm|cannot answer)\b/i;
          const isBad = (a) => !String(a || "").trim() || refusalRe.test(String(a));
          const freeAnswers = qa.map((a) => String(a.answer || "").trim());
          const allBad =
            freeAnswers.length > 0 &&
            freeAnswers.every((a) => isBad(a));

          let retryHelped = false;
          if (allBad && wantsLlmText) {
            try {
              // Short breather so a rate-limit / cold-start wobble has
              // a chance to clear before we hit /answer-questions
              // again.
              await new Promise((r) => setTimeout(r, 800));
              const retryAr = await apiFetch("/answer-questions", {
                method: "POST",
                body: JSON.stringify({
                  profileId,
                  questions: batch,
                  job_data: runState?.info?.job_data || {
                    company_name: runState?.companyName || "",
                    job_title: runState?.roleTitle || "",
                    job_description: jd,
                  },
                  resume: runState?.info?.resume || null,
                  ...currentKeySelection(),
                }),
              });
              const retryAnswers = Array.isArray(retryAr?.answers) ? retryAr.answers : [];
              const retryQa = wantsLlmText
                ? questions.map((q, i) => ({
                    id: q.id,
                    label: q.label,
                    answer: retryAnswers[i]?.answer || "",
                  }))
                : [];
              const retryAllBad =
                retryQa.length > 0 && retryQa.every((a) => isBad(a.answer));
              if (!retryAllBad && retryQa.length) {
                const retryQReply = await chrome.runtime.sendMessage({
                  type: "AUTOFILL_FILL_QUESTIONS",
                  tabId: clickTabId,
                  answers: retryQa,
                });
                qFilled += Number(retryQReply?.filled) || 0;
                qFailed += Number(retryQReply?.failed) || 0;
                retryHelped = (retryQReply?.filled || 0) > 0;
                usedQa = retryQa;
              }
            } catch { /* retry is best-effort; fall through to error surface */ }
          }

          // Record the auto-answered screening Q&A into the Follow-up
          // questions history so the user can review / copy / re-use
          // them (matches the manual "Ask" flow's persistence). Only
          // the good (non-blank, non-refusal) answers are kept, mapped
          // to the { question, answer } shape renderQA expects, and
          // de-duplicated against what's already in history so a
          // re-run of Auto-fill doesn't pile up copies.
          try {
            const priorQa = Array.isArray(runState?.qa) ? runState.qa : [];
            const seenQ = new Set(priorQa.map((it) => String(it.question || "").trim().toLowerCase()));
            const newHistory = usedQa
              .filter((a) => a && a.label && a.answer && !isBad(a.answer))
              .map((a) => ({ question: a.label, answer: a.answer }))
              .filter((it) => {
                const key = it.question.trim().toLowerCase();
                if (seenQ.has(key)) return false;
                seenQ.add(key);
                return true;
              });
            if (newHistory.length) {
              await savePatch(clickTabId, { qa: priorQa.concat(newHistory) });
              if (clickTabId === TAB_ID) renderQA(clickTabId);
            }
          } catch { /* history logging is best-effort */ }

          // See fillSummaryForReview's own comment — only a whole-batch
          // zero-failure result is trustworthy enough to mark these rows
          // filled in the Auto-fill tab's review list.
          if (fillSummaryForReview && wantsLlmText && qFailed === 0 && qFilled > 0) {
            fillSummaryForReview.questionsFilledOk = questions.map((q) => q.label);
          }

          if (allBad && !retryHelped) {
            status(
              `Filled ${n} field${n === 1 ? "" : "s"}${resume}, but every screening answer came back blank or refused (twice). This is almost always an upstream LLM wobble (rate limit / cold-start / provider hiccup) — wait a few seconds and re-run. If it repeats, check the server has an /answer-questions capable OPENAI_API_KEY set.`,
              "error",
            );
          } else {
            status(
              `Filled ${n} field${n === 1 ? "" : "s"}${resume}${qFilled ? ` · ${qFilled} answer${qFilled === 1 ? "" : "s"}` : ""}${qFailed ? ` (${qFailed} answer${qFailed === 1 ? "" : "s"} failed)` : ""}${retryHelped ? " · recovered on retry" : ""} on ${reply.adapter || "Generic"}.`,
              "success",
            );
          }
        } catch (qErr) {
          status(
            `Filled ${n} field${n === 1 ? "" : "s"}${resume}. Couldn't generate answers: ${qErr?.message || qErr}`,
            "error",
          );
        }
      } else if (questions.length > 0 && !jd) {
        // Free-text questions were found but there's no JD to feed
        // the LLM — same blocker in both Basic and Advanced. Tell
        // the user to paste a JD and re-run.
        status(
          `Filled ${n} field${n === 1 ? "" : "s"}${resume}. ${questions.length} screening question${questions.length === 1 ? "" : "s"} need a JD — paste one and re-run.`,
          "idle",
        );
      } else if (!advanced && dropdowns.length > 0) {
        // Basic mode deliberately skips unfilled dropdowns — a wrong
        // dropdown is harder to spot and unwind than a wrong textarea,
        // so dropdowns stay behind the Advanced opt-in.
        status(
          `Filled ${n} field${n === 1 ? "" : "s"}${resume}. Skipped ${dropdowns.length} screening dropdown${dropdowns.length === 1 ? "" : "s"} — pick those manually.`,
          "idle",
        );
      }

      // Final summary: a plain "Filled X/Y fields" fraction appended as its
      // own clean sentence. Used to append "· N empty field(s) left (M
      // required)" instead — a fragment starting with "·" glued directly
      // onto a sentence that already ended in a period, which read as a
      // stray, grammatically broken half-sentence rather than a real
      // summary (confirmed real complaint — "code like bugy sentence").
      // X/Y needs `detected` (every field the page's adapter found, filled
      // or not — see handleCountEmpty in autofill/dispatcher.js); the
      // older generic/non-ported-site fallback (autofill.js's own
      // countEmptyFields) doesn't compute that, so it keeps the older
      // empty-count phrasing rather than showing "X/undefined". Best-
      // effort either way; if the count fails we keep the status we
      // already set.
      try {
        const empty = await chrome.runtime.sendMessage({
          type: "AUTOFILL_COUNT_EMPTY",
          tabId: clickTabId,
        });
        const emptyCount = Number(empty?.total) || 0;
        const required = Number(empty?.required) || 0;
        const detected = Number(empty?.detected);
        const cur = getAutofillStatusText?.() || "";
        const base = cur + (cur.endsWith(".") ? "" : ".");
        // setAutofillStatus expects a level; preserve the existing tone
        // (success / idle / error) by reading what we last set.
        const level = els.autofillStatus?.dataset.level || "success";
        if (Number.isFinite(detected) && detected > 0) {
          const filled = Math.max(0, detected - emptyCount);
          const reqNote = required ? ` ${required} required field${required === 1 ? "" : "s"} still empty.` : "";
          status(`${base} Filled ${filled}/${detected} fields.${reqNote}`, level);
        } else if (emptyCount > 0 || required > 0) {
          status(`${base} ${emptyCount} empty field${emptyCount === 1 ? "" : "s"} left${required ? ` (${required} required)` : ""}.`, level);
        } else {
          status(`${base} All fields filled.`, level);
        }
      } catch {/* count is best-effort */}

      // Only for the tab currently on screen — this appends an interactive
      // button straight into the shared status box, so offering it for a
      // background run (the post-Generate auto-chain, or any run the user
      // has since tabbed away from) would plant a "Fill next step" link
      // that LOOKS like it belongs to whatever tab is visible right now but
      // silently targets a different one.
      if (reply.hasNextStep && clickTabId === TAB_ID) offerNextStepButton(clickTabId, profileId, mode);
      ranOk = true;
    } catch (err) {
      status(err?.message || String(err), "error");
    } finally {
      RUNNING_TABS.delete(clickTabId);
      if (ranOk) AUTOFILL_DONE_TABS.add(clickTabId);
      else AUTOFILL_DONE_TABS.delete(clickTabId);
      if (ranOk && resumeUploadedThisRun) RESUME_UPLOADED_TABS.add(clickTabId);
      else RESUME_UPLOADED_TABS.delete(clickTabId);
      // The outcome (whatever status() last set — "Filled N fields…",
      // "Form is already fully filled…", an error, …) now just stays in the
      // panel box instead of being converted into a page toast and cleared.
      if (clickTabId === TAB_ID) {
        stopAutofillProgress({ success: ranOk });
      }
      syncAutofillButtons();
    }
    // null unless the AUTOFILL_FILL round trip actually came back ok (every
    // early guard-clause return above returns undefined instead — nothing
    // ran, nothing to reconcile) — see applyAutofillResultToReview.
    return fillSummaryForReview;
  }

  // No more hands-free auto-run after Generate — Auto-fill is a manual
  // click only now (see Generate's own success handler, which used to chain
  // straight into this). Still reconciles the Form Questions modal/list
  // against whatever this run actually filled (applyAutofillResultToReview)
  // so if the user opens it afterward it reflects reality — a no-op if the
  // modal was never opened this session (AUTOFILL_REVIEW_ROWS is empty).
  els.autofillBtn?.addEventListener("click", async () => {
    const summary = await runAutofill("basic");
    if (summary) applyAutofillResultToReview(summary);
  });
  els.downloadCvBtn?.addEventListener("click", () => downloadGeneratedCv(TAB_ID));
  els.browseDownloadFolderBtn?.addEventListener("click", () => pickDownloadFolder());
  // No extension can rebind a chrome.commands shortcut from its own page —
  // this just deep-links to Chrome's own shortcuts screen, the only place
  // the combo can actually be changed.
  els.editShortcutsBtn?.addEventListener("click", () => {
    try {
      chrome.commands.openShortcutSettings();
    } catch {
      chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
    }
  });

  // Update banner: the Update button opens the download / install page (a
  // self-hosted extension can't reinstall itself). Dismiss remembers the
  // version so it won't nag again until an even newer one ships.
  els.updateBtn?.addEventListener("click", () => {
    const url = els.updateBtn.dataset.url;
    chrome.tabs.create({ url: url || DASHBOARD_URL });
  });
  els.updateDismissBtn?.addEventListener("click", async () => {
    els.updateBanner?.classList.add("hidden");
    const v = els.updateBtn?.dataset.version;
    if (v) {
      try {
        await chrome.storage.local.set({ [UPDATE_DISMISS_KEY]: v });
      } catch {
        /* ignore */
      }
    }
  });
  els.autofillAdvancedBtn?.addEventListener("click", () => runAutofill("advanced"));

  /** After the first form fills, drop a small "Fill next step" link in
   *  the status box. Clicking it tells the content script to click the
   *  Next button, wait for the page to settle, and then we restart the
   *  whole fill flow on the new fields. `tabId` is captured in this
   *  closure (the tab this button was created for) rather than read live
   *  off TAB_ID at click time — switching tabs overwrites the shared
   *  status box's textContent anyway (see applyStateToUI), which wipes
   *  this button out, so by the time it's actually clickable the visible
   *  tab is guaranteed to still be the one it was made for. */
  function offerNextStepButton(tabId, profileId, mode) {
    if (!els.autofillStatus) return;
    const link = document.createElement("button");
    link.type = "button";
    link.className = "ghost autofill-next-step";
    link.style.marginLeft = "8px";
    link.textContent = "Fill next step →";
    link.addEventListener("click", async () => {
      link.disabled = true;
      setAutofillStatus("Clicking Next and waiting for the next step…", "loading");
      try {
        const ns = await chrome.runtime.sendMessage({
          type: "AUTOFILL_NEXT_STEP",
          tabId,
        });
        if (!ns?.ok) {
          setAutofillStatus(ns?.error || "Couldn't advance to next step.", "error");
          return;
        }
        // Re-run the same mode the user used for step 1, so multi-page
        // forms that need LLM-answered textareas on later pages keep
        // working under Advanced and stay free under Basic.
        runAutofill(mode || "basic", { tabId });
      } catch (e) {
        setAutofillStatus(e?.message || String(e), "error");
      }
    });
    els.autofillStatus.appendChild(link);
  }

  els.copyCoverBtn?.addEventListener("click", async () => {
    const raw = STATE?.info?.cover_letter || "";
    if (!raw) {
      setStatus(TAB_ID, "No cover letter available.", "error");
      return;
    }
    const text = stripCoverMarkdown(raw);
    try {
      await navigator.clipboard.writeText(text);
      // Icon-only, --solid black/white (see View/Download next to it) — no
      // .copied green flash and no .btn-text span to swap either (that used
      // to blow the SVG away via setButtonText's textContent fallback).
      // panelToast alone is the feedback.
      panelToast("Cover letter copied.");
    } catch (e) {
      setStatus(TAB_ID, "Copy failed: " + (e?.message || e), "error");
    }
  });

  els.copyJdBtn?.addEventListener("click", async () => {
    const text = (STATE?.jobText || els.jobText?.value || "").trim();
    if (!text) {
      setStatus(TAB_ID, "No job description available.", "error");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      const btn = els.copyJdBtn;
      btn.classList.add("copied");
      panelToast("Job description copied.");
      setTimeout(() => btn.classList.remove("copied"), 2000);
    } catch (e) {
      setStatus(TAB_ID, "Copy failed: " + (e?.message || e), "error");
    }
  });

  els.downloadJdBtn?.addEventListener("click", async () => {
    const tabId = TAB_ID;
    const jd = (STATE?.jobText || els.jobText?.value || "").trim();
    if (!jd) {
      setStatus(tabId, "No job description to download.", "error");
      return;
    }
    isDownloadingJd = true;
    if (els.downloadJdBtn) els.downloadJdBtn.disabled = true;
    try {
      const company = els.companyName?.value || STATE?.companyName || "";
      const role = els.roleTitle?.value || STATE?.roleTitle || "";
      const resp = await apiFetch("/export/jd", {
        method: "POST",
        body: JSON.stringify({
          job_description: jd,
          company,
          role,
          jobUrl: STATE?.autoDetectedUrl || "",
        }),
      });
      const f = resp?.file;
      if (!f?.file) throw new Error("No file returned");
      const where = await saveOneFile({
        bytes: base64ToUint8Array(f.file),
        mime: f.type || "application/pdf",
        filename: buildFilenameFromTemplate(
          FILENAME_JD,
          { ...currentProfileFilenameVars(), company, role },
          extOf(f.name),
          "job-description"
        ),
        folderName: await resolveAppFolder(true),
      });
      panelToast(`Job description saved to ${where}.`);
    } catch (e) {
      setStatus(tabId, "JD PDF failed: " + (e?.message || e), "error");
    } finally {
      isDownloadingJd = false;
      if (els.downloadJdBtn) {
        els.downloadJdBtn.disabled = !(STATE?.jobText || "").trim();
      }
    }
  });

  els.downloadCoverPdfBtn?.addEventListener("click", async () => {
    const tabId = TAB_ID;
    const info = STATE?.info;
    if (!info?.cover_letter || !info?.resume) {
      setStatus(tabId, "Generate a cover letter first.", "error");
      return;
    }
    isDownloadingCover = true;
    if (els.downloadCoverPdfBtn) els.downloadCoverPdfBtn.disabled = true;
    try {
      // Server renders the cover letter to a PDF and returns
      // { file: { name, type, file: base64 } } — same shape as the resume.
      const resp = await apiFetch("/export/cover?type=pdf", {
        method: "POST",
        body: JSON.stringify({
          cover_letter: info.cover_letter,
          resume: info.resume,
          job_data: info.job_data,
        }),
      });
      const f = resp?.file;
      if (!f?.file) throw new Error("No file returned");
      // Same application folder as the CV (resolveAppFolder is cached per
      // generation, and role-aware), so the cover letter joins this role's
      // folder — overwriting any prior cover letter there.
      const where = await saveOneFile({
        bytes: base64ToUint8Array(f.file),
        mime: f.type || "application/pdf",
        filename: buildFilenameFromTemplate(
          FILENAME_COVER,
          {
            ...currentProfileFilenameVars(),
            company: els.companyName?.value || STATE?.companyName || "",
            role: els.roleTitle?.value || STATE?.roleTitle || "",
          },
          extOf(f.name),
          "cover-letter"
        ),
        folderName: await resolveAppFolder(true),
      });
      panelToast(`Cover letter saved to ${where}.`);
    } catch (e) {
      setStatus(tabId, "Cover PDF failed: " + (e?.message || e), "error");
    } finally {
      isDownloadingCover = false;
      if (els.downloadCoverPdfBtn) {
        els.downloadCoverPdfBtn.disabled = !STATE?.info?.cover_letter;
      }
    }
  });

  els.copyResumeBtn?.addEventListener("click", async () => {
    const text = formatResumeText(STATE?.info?.resume);
    if (!text) {
      setStatus(TAB_ID, "No resume available.", "error");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      // No .copied flash — --solid stays black/white, same as View/Download.
      panelToast("Resume copied.");
    } catch (e) {
      setStatus(TAB_ID, "Copy failed: " + (e?.message || e), "error");
    }
  });

  // Resume-only — unlike the Generate row's own Download button (which saves
  // all three), this saves just the resume PDF, nothing else.
  els.downloadResumeBtn?.addEventListener("click", () => downloadResumeOnly(TAB_ID));

  els.markAppliedBtn?.addEventListener("click", markAsApplied);

  // Apply tab's quick-copy row (#profileShortcuts, above the Profile
  // picker) — one click copies that field straight from PROFILE_LINKS,
  // same checkmark + toast feedback as the Profile tab's own cdFieldRow
  // copy buttons.
  const wireShortcutCopyBtn = (btn, key, label) => {
    btn?.addEventListener("click", async () => {
      const value = PROFILE_LINKS[key];
      if (!value) {
        setStatus(TAB_ID, `No ${label} available.`, "error");
        return;
      }
      try {
        await navigator.clipboard.writeText(value);
        showCopiedCheck(btn);
        panelToast(`${label} copied.`);
      } catch (e) {
        setStatus(TAB_ID, "Copy failed: " + (e?.message || e), "error");
      }
    });
  };
  wireShortcutCopyBtn(els.shortcutEmailBtn, "email", "Email");
  wireShortcutCopyBtn(els.shortcutPhoneBtn, "phone", "Phone number");
  wireShortcutCopyBtn(els.shortcutLinkedinBtn, "linkedin", "LinkedIn URL");
  wireShortcutCopyBtn(els.shortcutGithubBtn, "github", "GitHub URL");
  wireShortcutCopyBtn(els.shortcutAddressBtn, "address", "Address");
  wireShortcutCopyBtn(els.shortcutZipBtn, "zipcode", "ZIP / postal code");
  wireShortcutCopyBtn(els.shortcutCompanyBtn, "lastCompany", "Company name");

  // Auto-Ask on paste — when the user pastes a question into the
  // Follow-up Q textarea we trigger the Ask flow without them having
  // to reach for the button. The paste event fires BEFORE the pasted
  // text is inserted, so we schedule the click on the next tick
  // (setTimeout 0) once the textarea reflects the new value.
  //
  // Guards:
  //   - Skip if the Ask button is disabled (no profile / not generated /
  //     in-flight ask) — auto-firing then would confuse the status box.
  //   - Skip if the pasted content has no meaningful text (avoids
  //     stray clicks on empty clipboard).
  //   - We deliberately don'\''t debounce: the user'\''s intent on paste
  //     is "send this verbatim". If they want to edit, they can paste,
  //     edit, and submit normally.
  // Persist the draft per tab (the box is one shared DOM element), so switching
  // tabs restores each tab's own half-typed question instead of leaking one
  // tab's text into the others. Mirrors the jobText input handler.
  els.qaInput?.addEventListener("input", (e) => {
    if (!TAB_ID) return;
    savePatch(TAB_ID, { qaDraft: e.target.value });
  });

  els.qaInput?.addEventListener("paste", () => {
    setTimeout(() => {
      if (!els.askBtn || els.askBtn.disabled) return;
      if (els.qaInput?.readOnly) return;  // request in flight
      const text = (els.qaInput.value || "").trim();
      if (!text) return;
      els.askBtn.click();
    }, 0);
  });

  // Auto-Ask on Enter (without Shift) — pairs with paste so the user
  // can type a question and submit with the keyboard alone. Shift+Enter
  // keeps the newline so multi-question blocks still work.
  els.qaInput?.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" || ev.shiftKey || ev.ctrlKey || ev.metaKey) return;
    ev.preventDefault();
    if (!els.askBtn || els.askBtn.disabled) return;
    if (els.qaInput?.readOnly) return;  // request in flight
    const text = (els.qaInput.value || "").trim();
    if (!text) return;
    els.askBtn.click();
  });

  els.askBtn.addEventListener("click", async () => {
    if (STATE?.generatingStatus !== "generated") return;

    const tabId = TAB_ID;
    const q = (els.qaInput.value || "").trim();
    const qs = q
      .split(/\n\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (!qs.length) {
      setStatus(tabId, "Type at least one question.", "error");
      return;
    }

    const pid = selectedProfileId();
    if (!pid) {
      setStatus(tabId, "Select a profile first.", "error");
      return;
    }

    setStatus(tabId, "Asking…", "loading");
    if (tabId === TAB_ID) {
      els.askBtn.disabled = true;
      els.askBtn.classList.add("is-loading");
      // Lock the textarea while the request is in flight. Without
      // this the auto-Ask-on-paste / Enter handlers would fire a
      // second time if the user pasted again or tabbed into the
      // box mid-call, queueing duplicate /answer-questions calls.
      // Also gives a visual cue (the readOnly style) that the
      // input is busy, matching the "Asking…" pill on the button.
      if (els.qaInput) els.qaInput.readOnly = true;
    }
    try {
      const resp = await apiFetch("/answer-questions", {
        method: "POST",
        body: JSON.stringify({
          profileId: pid,
          resume: STATE?.info?.resume,
          job_data: STATE?.info?.job_data,
          questions: qs,
          ...currentKeySelection(),
        }),
      });

      const newItems = Array.isArray(resp.answers) ? resp.answers : [];
      const nextQA = (STATE?.qa || []).concat(newItems);

      // Clear the persisted draft too — the question moved into the thread, so
      // it must not reappear in the box when this tab is next loaded.
      await savePatch(tabId, { qa: nextQA, qaDraft: "" });
      renderQA(tabId);

      if (tabId === TAB_ID) {
        els.qaInput.value = "";
      }

      // Auto-fill matching textareas / inputs on the active tab. Both
      // Basic and Advanced Auto-fill capabilities used to require the
      // user to copy each answer into the form by hand. Now the
      // content script does a best-effort label-match and types the
      // answer in place. Best-effort — quietly does nothing on pages
      // without the content script (chrome://, file://, etc).
      let pageFilled = 0;
      if (tabId === TAB_ID) {
        try {
          const reply = await chrome.runtime.sendMessage({
            type: "AUTOFILL_APPLY_QA_ANSWERS",
            tabId,
            answers: newItems,
          });
          pageFilled = Number(reply?.filled) || 0;
        } catch {/* no content script on this page — non-fatal */}
      }
      panelToast(
        pageFilled > 0
          ? `Answer received. Filled ${pageFilled} matching field${pageFilled === 1 ? "" : "s"} on the page.`
          : "Answer received.",
      );
      // Clear the "Asking…" loading pill — the answer is in the thread and was
      // confirmed by the toast, so return the status line to its resting state.
      applyRestingStatus(tabId);
    } catch (e) {
      setStatus(tabId, "Ask failed: " + humaniseProviderError(e.message), "error");
    } finally {
      if (tabId === TAB_ID) {
        els.askBtn.disabled = false;
        els.askBtn.classList.remove("is-loading");
        if (els.qaInput) els.qaInput.readOnly = false;
      }
    }
  });

  chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
    if (windowId !== CURRENT_WINDOW_ID) return;
    // Auto Apply drives tab activation + loadForTab itself, sequentially and
    // fully awaited, one tab at a time (see runAutoApply) — letting this
    // listener ALSO call loadForTab for the same tabId concurrently raced
    // the two calls against loadForTab's own LOAD_SEQ guard: whichever call's
    // fetchState resolved last "won" and actually ran applyStateToUI; the
    // other returned early, before the DOM was ever updated. Since Auto
    // Apply's own explicit call could be the one that lost, it would then
    // read the PREVIOUS tab's still-showing company/role/JD as if they
    // belonged to the new tab — which reads as "already filled" to
    // detectJobFromActiveTab's silent-mode guard, so it skipped detecting
    // entirely, and the loop concluded (wrongly) that every tab had nothing
    // to apply to. Only Auto Apply's own call matters while it's running.
    if (AUTO_APPLY_RUNNING) return;
    // Manual mode's own ChatGPT window takes real focus for the run now
    // (see openFreshBananaChatGptTab) — expected to happen on basically
    // every run, not just if the user happens to click over to check on it
    // — and normally that activation would make the panel follow it via
    // loadForTab below, blanking out the job tab's own company/role/JD
    // (and, mid-generation, its progress state) the moment ChatGPT takes
    // focus. The whole point of this run is keeping THAT tab's content
    // visible throughout, so skip the follow specifically for the ChatGPT
    // tab; switching to any other real tab still works exactly as before.
    if (RESUME_MODE === "manual") {
      let activatedTab;
      try {
        activatedTab = await chrome.tabs.get(tabId);
      } catch {
        /* tab gone already — nothing to pin against */
      }
      if (activatedTab && BANANA_CHATGPT_TAB_URL_RE.test(activatedTab.url || "")) return;
    }
    await loadForTab(tabId);
  });

  // Auto-detect on navigation: the active tab finishing a load or changing URL
  // (incl. SPA history navigations Chrome reports) re-runs the executeScript
  // pull for that tab.
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId !== TAB_ID) return;
    if (changeInfo.status === "complete" || changeInfo.url) scheduleAutoDetect();
  });
  chrome.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    // EVERY window's side panel receives this event, not just the focused
    // one. Reacting to another window's focus would repaint this panel with
    // that window's active-tab state (and, if we reassigned
    // CURRENT_WINDOW_ID, permanently bind this panel to the wrong window).
    // A panel never moves between windows, so its id is fixed at startup.
    if (windowId !== CURRENT_WINDOW_ID) return;
    const tabs = await chrome.tabs.query({ active: true, windowId });
    const tabId = tabs && tabs[0] ? tabs[0].id : null;
    await loadForTab(tabId);
  });

  document.addEventListener("visibilitychange", async () => {
    if (!TAB_ID) return;
    if (document.visibilityState === "visible") {
      await sendToBG({ type: "SET_OPEN", tabId: TAB_ID, isOpen: true });
    } else {
      await sendToBG({ type: "SET_OPEN", tabId: TAB_ID, isOpen: false });
    }
  });

  // Only now — every button's click listener above is wired up, including
  // autofillBtn/downloadCvBtn's — is it safe to replay a hotkey action that
  // fired while this panel was still opening.
  await checkPendingHotkey();
});

