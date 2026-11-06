/** Executable contract example, not the application's SQL/RLS implementation. */

export type Summary = {
  candidateId: string;
  headline: string;
  skills: string[];
  experienceBand: string;
  workPreference: string;
};
export type Decision = {
  allowed: boolean;
  reason: string;
  summary: Summary | null;
};
type RecordValue = Record<string, unknown>;

class InvalidContext extends Error {}
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function object(value: unknown): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidContext("expected object");
  }
  return value as RecordValue;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value) || value.trim() !== value) {
    throw new InvalidContext("invalid identifier");
  }
  return value;
}
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new InvalidContext("invalid integer");
  }
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new InvalidContext("invalid boolean");
  return value;
}
function choice(value: unknown, choices: readonly string[]): string {
  if (typeof value !== "string" || !choices.includes(value)) {
    throw new InvalidContext("unknown enum");
  }
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new InvalidContext("expected array");
  return value;
}
function records(value: unknown, uniqueIds = false): RecordValue[] {
  const result = array(value).map(object);
  if (uniqueIds) {
    const ids = result.map((record) => identifier(record.id));
    if (ids.length !== new Set(ids).size) throw new InvalidContext("ambiguous record IDs");
  }
  return result;
}
function window(record: RecordValue): void {
  const start = integer(record.valid_from_ms);
  for (const key of ["expires_at_ms", "revoked_at_ms"]) {
    if (!Object.hasOwn(record, key)) throw new InvalidContext("missing temporal field");
    if (record[key] !== null) integer(record[key]);
  }
  if (record.expires_at_ms !== null && Number(record.expires_at_ms) <= start) {
    throw new InvalidContext("invalid validity interval");
  }
}
function live(record: RecordValue, now: number): boolean {
  return record.status === "verified"
    && Number(record.valid_from_ms) <= now
    && (record.expires_at_ms === null || now < Number(record.expires_at_ms))
    && (record.revoked_at_ms === null || now < Number(record.revoked_at_ms));
}
function scope(value: unknown): RecordValue {
  const result = object(value);
  const kind = choice(result.kind, ["company", "recruiter", "opportunity", "recruiter_opportunity"]);
  const expected = ["kind"];
  if (kind === "recruiter" || kind === "recruiter_opportunity") {
    expected.push("recruiter_id");
    identifier(result.recruiter_id);
  }
  if (kind === "opportunity" || kind === "recruiter_opportunity") {
    expected.push("opportunity_id");
    identifier(result.opportunity_id);
  }
  if (Object.keys(result).length !== expected.length
      || Object.keys(result).some((key) => !expected.includes(key))) {
    throw new InvalidContext("scope has unexpected dimensions");
  }
  return result;
}
function matches(ruleScope: RecordValue, actor: string, opportunity: string): boolean {
  return (!Object.hasOwn(ruleScope, "recruiter_id") || ruleScope.recruiter_id === actor)
    && (!Object.hasOwn(ruleScope, "opportunity_id") || ruleScope.opportunity_id === opportunity);
}

function validate(data: RecordValue): void {
  integer(data.now_ms);
  const account = object(data.account);
  identifier(account.id);
  choice(account.role, ["recruiter", "candidate", "admin"]);
  choice(account.status, ["active", "suspended", "deleted"]);
  const candidate = object(data.candidate);
  identifier(candidate.id);
  const policy = object(candidate.policy);
  identifier(policy.candidate_id);
  boolean(policy.active);
  choice(policy.mode, ["selected", "verified"]);
  integer(policy.version, 1);
  array(candidate.current_employer_ids).forEach(identifier);
  for (const rule of records(candidate.rules)) {
    identifier(rule.candidate_id);
    identifier(rule.company_id);
    choice(rule.effect, ["allow", "block"]);
    scope(rule.scope);
  }
  const summary = object(candidate.summary);
  identifier(summary.candidateId);
  for (const key of ["headline", "experienceBand", "workPreference"]) {
    if (typeof summary[key] !== "string" || !summary[key]) {
      throw new InvalidContext("invalid summary text");
    }
  }
  if (array(summary.skills).some((skill) => typeof skill !== "string" || !skill)) {
    throw new InvalidContext("invalid skill");
  }
  const companies = records(data.companies, true);
  for (const company of companies) {
    choice(company.kind, ["employer", "agency"]);
    boolean(company.verified);
    boolean(company.active);
  }
  const memberships = records(data.memberships, true);
  for (const membership of memberships) {
    identifier(membership.account_id);
    identifier(membership.company_id);
    choice(membership.status, ["verified", "pending", "revoked", "suspended"]);
    window(membership);
  }
  const opportunity = object(data.opportunity);
  for (const key of ["id", "membership_id", "hiring_company_id"]) identifier(opportunity[key]);
  choice(opportunity.status, ["open", "closed", "draft"]);
  const mandates = records(data.mandates);
  for (const mandate of mandates) {
    identifier(mandate.agency_id);
    identifier(mandate.hiring_company_id);
    choice(mandate.status, ["verified", "pending", "revoked", "suspended"]);
    window(mandate);
  }
  const affiliations = records(data.affiliations);
  for (const edge of affiliations) {
    identifier(edge.company_id);
    identifier(edge.related_company_id);
    choice(edge.review_status, ["verified", "pending", "rejected"]);
  }
  const known = new Set(companies.map((company) => company.id));
  const references = [
    ...array(candidate.current_employer_ids),
    ...records(candidate.rules).map((rule) => rule.company_id),
    ...memberships.map((member) => member.company_id),
    opportunity.hiring_company_id,
    ...mandates.flatMap((mandate) => [mandate.agency_id, mandate.hiring_company_id]),
    ...affiliations.flatMap((edge) => [edge.company_id, edge.related_company_id])
  ];
  if (references.some((reference) => !known.has(reference))) {
    throw new InvalidContext("unresolved company reference");
  }
}

function deny(reason: string): Decision {
  return { allowed: false, reason, summary: null };
}

export function evaluate(raw: unknown): Decision {
  let data: RecordValue;
  let request: RecordValue;
  let actor: string;
  try {
    data = object(raw);
    if (data.request === null || typeof data.request !== "object" || Array.isArray(data.request)) {
      return deny("INVALID_REQUEST");
    }
    request = object(data.request);
    if (Object.keys(request).sort().join(",") !== "candidate_id,opportunity_id") {
      return deny("INVALID_REQUEST");
    }
    try {
      identifier(request.candidate_id);
      identifier(request.opportunity_id);
    } catch (error) {
      if (!(error instanceof InvalidContext)) throw error;
      return deny("INVALID_REQUEST");
    }
    if (data.auth === null || data.auth === undefined) return deny("UNAUTHENTICATED");
    actor = identifier(object(data.auth).account_id);
    validate(data);
  } catch (error) {
    if (!(error instanceof InvalidContext)) throw error;
    return deny("INVALID_CONTEXT");
  }
  const account = object(data.account);
  const candidate = object(data.candidate);
  const policy = object(candidate.policy);
  const opportunity = object(data.opportunity);
  const rules = records(candidate.rules);
  const sourceSummary = object(candidate.summary);
  if (account.id !== actor || account.status !== "active" || account.role !== "recruiter") {
    return deny("ACCOUNT_DENIED");
  }
  if (request.candidate_id !== candidate.id || request.opportunity_id !== opportunity.id
      || policy.candidate_id !== candidate.id || sourceSummary.candidateId !== candidate.id
      || rules.some((rule) => rule.candidate_id !== candidate.id)) {
    return deny("CONTEXT_MISMATCH");
  }
  if (opportunity.status !== "open") return deny("OPPORTUNITY_DENIED");
  const memberships = records(data.memberships);
  const membership = memberships.find((member) => member.id === opportunity.membership_id);
  const now = integer(data.now_ms);
  if (!membership || membership.account_id !== actor || !live(membership, now)) {
    return deny("MEMBERSHIP_DENIED");
  }
  const companies = new Map(records(data.companies).map((company) => [company.id, company]));
  // validate() has already required every referenced company to exist.
  const recruiting = companies.get(membership.company_id)!;
  const hiring = companies.get(opportunity.hiring_company_id)!;
  if (![recruiting, hiring].every((company) => company.verified && company.active)) {
    return deny("COMPANY_DENIED");
  }
  if (recruiting.kind === "employer") {
    if (hiring.id !== recruiting.id) return deny("COMPANY_SCOPE_DENIED");
  } else if (hiring.kind !== "employer" || !records(data.mandates).some((mandate) =>
    mandate.agency_id === recruiting.id && mandate.hiring_company_id === hiring.id && live(mandate, now)
  )) {
    return deny("MANDATE_DENIED");
  }
  if (!policy.active) return deny("PAUSED");
  const involved = new Set<unknown>([recruiting.id, hiring.id]);
  for (const member of memberships) {
    if (member.account_id === actor && live(member, now)) involved.add(member.company_id);
  }
  const neighbors = new Map<unknown, Set<unknown>>();
  for (const edge of records(data.affiliations)) {
    if (edge.review_status === "verified") {
      for (const [left, right] of [
        [edge.company_id, edge.related_company_id],
        [edge.related_company_id, edge.company_id]
      ]) {
        const adjacent = neighbors.get(left) ?? new Set<unknown>();
        adjacent.add(right);
        neighbors.set(left, adjacent);
      }
    }
  }
  const queue = [...involved];
  for (let index = 0; index < queue.length; index++) {
    for (const neighbor of neighbors.get(queue[index]) ?? []) {
      if (!involved.has(neighbor)) {
        involved.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  if (array(candidate.current_employer_ids).some((id) => involved.has(id))) {
    return deny("EMPLOYER_BLOCKED");
  }
  const applicable = rules.filter((rule) => matches(object(rule.scope), actor, String(opportunity.id)));
  if (applicable.some((rule) => rule.effect === "block" && involved.has(rule.company_id))) {
    return deny("BLOCKED");
  }
  const allowed = new Set(applicable.filter((rule) => rule.effect === "allow").map((rule) => rule.company_id));
  if (policy.mode === "selected" && (!allowed.has(recruiting.id) || !allowed.has(hiring.id))) {
    return deny("NOT_SELECTED");
  }
  return {
    allowed: true,
    reason: "ALLOWED",
    summary: {
      candidateId: String(sourceSummary.candidateId),
      headline: String(sourceSummary.headline),
      skills: [...array(sourceSummary.skills)] as string[],
      experienceBand: String(sourceSummary.experienceBand),
      workPreference: String(sourceSummary.workPreference)
    }
  };
}
