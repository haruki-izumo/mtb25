/** Project workflow status keys, colors, and allowed transitions. */

export const PROJECT_STATUS_SEEDS = [
  { key: "SECURED", name: "Secured / Won", color: "#2563eb", sortOrder: 1, isFinal: false },
  { key: "KICKOFF", name: "Kick-off / Planning", color: "#7c3aed", sortOrder: 2, isFinal: false },
  { key: "IN_PROGRESS", name: "In Progress", color: "#0891b2", sortOrder: 3, isFinal: false },
  { key: "ON_HOLD", name: "On Hold", color: "#ca8a04", sortOrder: 4, isFinal: false },
  { key: "UNDER_REVIEW", name: "Under Review / QA", color: "#ea580c", sortOrder: 5, isFinal: false },
  { key: "COMPLETED", name: "Completed / Delivered", color: "#16a34a", sortOrder: 6, isFinal: false },
  { key: "INVOICED", name: "Invoiced", color: "#0d9488", sortOrder: 7, isFinal: false },
  { key: "CLOSED", name: "Closed", color: "#64748b", sortOrder: 8, isFinal: true },
  { key: "CANCELLED", name: "Cancelled", color: "#dc2626", sortOrder: 9, isFinal: true },
] as const;

export type ProjectStatusKey = (typeof PROJECT_STATUS_SEEDS)[number]["key"];

/** Allowed from → to keys (seeded into ProjectStatusTransition). */
export const PROJECT_STATUS_TRANSITIONS: Array<[ProjectStatusKey, ProjectStatusKey]> = [
  ["SECURED", "KICKOFF"],
  ["SECURED", "ON_HOLD"],
  ["SECURED", "CANCELLED"],
  ["KICKOFF", "IN_PROGRESS"],
  ["KICKOFF", "ON_HOLD"],
  ["KICKOFF", "CANCELLED"],
  ["IN_PROGRESS", "UNDER_REVIEW"],
  ["IN_PROGRESS", "ON_HOLD"],
  ["IN_PROGRESS", "CANCELLED"],
  ["ON_HOLD", "SECURED"],
  ["ON_HOLD", "KICKOFF"],
  ["ON_HOLD", "IN_PROGRESS"],
  ["ON_HOLD", "UNDER_REVIEW"],
  ["ON_HOLD", "CANCELLED"],
  ["UNDER_REVIEW", "IN_PROGRESS"],
  ["UNDER_REVIEW", "COMPLETED"],
  ["UNDER_REVIEW", "ON_HOLD"],
  ["UNDER_REVIEW", "CANCELLED"],
  ["COMPLETED", "INVOICED"],
  ["COMPLETED", "CLOSED"],
  ["INVOICED", "CLOSED"],
];

export const STATUSES_REQUIRING_COMMENT = new Set<ProjectStatusKey>([
  "ON_HOLD",
  "CANCELLED",
]);

export const PROJECT_PRIORITIES = [
  { value: "LOW", label: "Low", color: "#64748b" },
  { value: "MEDIUM", label: "Medium", color: "#2563eb" },
  { value: "HIGH", label: "High", color: "#ea580c" },
  { value: "CRITICAL", label: "Critical", color: "#dc2626" },
] as const;

export const PROJECT_CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD"] as const;

export const PROJECT_INDUSTRIES = [
  "Technology",
  "Finance",
  "Healthcare",
  "Retail",
  "Manufacturing",
  "Education",
  "Government",
  "Other",
] as const;

export const DEFAULT_PROJECT_TYPES = [
  "Implementation",
  "Consulting",
  "Support",
  "Development",
  "Audit",
] as const;

/** Common countries for searchable select (ISO 3166-1 alpha-2). */
export const PROJECT_COUNTRIES = [
  { code: "US", name: "United States" },
  { code: "CA", name: "Canada" },
  { code: "GB", name: "United Kingdom" },
  { code: "AU", name: "Australia" },
  { code: "DE", name: "Germany" },
  { code: "FR", name: "France" },
  { code: "IN", name: "India" },
  { code: "IE", name: "Ireland" },
  { code: "NL", name: "Netherlands" },
  { code: "SG", name: "Singapore" },
  { code: "JP", name: "Japan" },
  { code: "BR", name: "Brazil" },
  { code: "MX", name: "Mexico" },
  { code: "AE", name: "United Arab Emirates" },
  { code: "NZ", name: "New Zealand" },
] as const;
