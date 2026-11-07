import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { Link } from "wouter";
import { ExternalLink, LockKeyhole, Search } from "lucide-react";
import { useCareer } from "./career-store.js";
import { apiRequest } from "./lib/queryClient.js";
import { researchSearchSchema } from "../../shared/research-schema.js";
import type { ResearchResult } from "../../shared/research-schema.js";

type SearchFields = {
  keywords: string; location: string; maxResults: number; datePosted: string;
  workplace: string; experience: string; employment: string; acknowledgeCredits: boolean;
};
type Access = { enabled: boolean; source: "linkedin"; provider: "reefapi" };

export default function ResearchPage() {
  const store = useCareer();
  const access = useQuery<Access>({
    queryKey: ["/api/career/research/status", store.owner], enabled: store.canSave,
    gcTime: 0, staleTime: 0, retry: false, refetchOnWindowFocus: true,
    queryFn: async () => (await apiRequest("GET", "/api/career/research/status", undefined,
      { "X-Account-Id": store.owner })).json(),
  });
  const allowed = store.canSave && access.data?.enabled === true && !access.isError;
  const identity = useRef({ owner: store.owner, allowed });
  identity.current = { owner: store.owner, allowed };
  const epoch = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<ResearchResult | null>(null);
  const form = useForm<SearchFields>({
    defaultValues: { keywords: "", location: "", maxResults: 20, datePosted: "week",
      workplace: "", experience: "", employment: "", acknowledgeCredits: false },
  });
  useEffect(() => {
    if (!allowed) { setResult(null); setMessage(""); setBusy(false); }
    return () => {
      epoch.current++;
      controller.current?.abort();
      pending.current = false;
    };
  }, [store.owner, allowed]);

  const submit = form.handleSubmit(async fields => {
    if (!identity.current.allowed || pending.current) return;
    if (!fields.acknowledgeCredits) {
      setMessage("Confirm provider-credit use before starting a search.");
      return;
    }
    const parsed = researchSearchSchema.safeParse({
      keywords: fields.keywords, location: fields.location, maxResults: fields.maxResults, datePosted: fields.datePosted,
      ...(fields.workplace ? { workplace: fields.workplace } : {}),
      ...(fields.experience ? { experience: fields.experience } : {}),
      ...(fields.employment ? { employment: fields.employment } : {}),
    });
    if (!parsed.success) {
      setMessage("Enter a role and location, choose supported filters, and request 1–20 results.");
      return;
    }
    const owner = store.owner;
    const attempt = ++epoch.current;
    controller.current = new AbortController();
    pending.current = true;
    setBusy(true); setMessage(""); setResult(null);
    try {
      // Keep private research out of the shared query/mutation cache. A new
      // identity or permission state invalidates and aborts this UI request.
      const response = await apiRequest("POST", "/api/career/research/search", parsed.data,
        { "X-Account-Id": owner }, controller.current.signal);
      const data = await response.json() as ResearchResult;
      if (epoch.current === attempt && identity.current.owner === owner && identity.current.allowed) setResult(data);
    } catch (error) {
      if (epoch.current === attempt && identity.current.owner === owner && identity.current.allowed) {
        setMessage(error instanceof Error ? error.message : "The source could not be checked. No replacement jobs were invented.");
      }
    } finally {
      if (epoch.current === attempt) { pending.current = false; setBusy(false); }
    }
  });
  const status = !store.canSave ? "A verified, active candidate account is required. Guest work and recruiter accounts cannot run paid research."
    : access.isPending ? "Checking private research access…"
    : access.isError ? "Research access could not be verified. No search was sent."
    : !allowed ? "Research is not enabled for this account. The public employer feed remains available."
    : "LinkedIn discovery is enabled for this account. Each search may use provider credits.";

  return <>
    <section className="career-heading"><div><p className="career-kicker">PRIVATE JOB RESEARCH</p>
      <h1>Look beyond the configured boards.</h1>
      <p>Search LinkedIn through ReefAPI. Verify employer details and resume fit before relying on a result.</p></div>
      <Link className="button secondary" href="/" data-testid="research-employer-feed">Public employer feed</Link>
    </section>
    <section className="career-research-status" aria-label="Research access" data-testid="research-status">
      <LockKeyhole size={17} /><p>{status}</p>
      {!store.canSave && <Link className="text-button" href="/account" data-testid="research-account">Account setup</Link>}
      {access.isError && <button className="text-button" data-testid="research-retry-access" onClick={() => void access.refetch()}>Recheck access</button>}
    </section>
    <form className="career-research-form" onSubmit={submit} noValidate aria-busy={busy}>
      <fieldset disabled={!allowed || busy}><legend>Search criteria</legend>
        <div className="career-form-grid">
          <label>Role or skill<input data-testid="research-keywords" maxLength={160} placeholder="Your target role"
            aria-invalid={!!form.formState.errors.keywords} {...form.register("keywords", { required: true })} /></label>
          <label>Location<input data-testid="research-location" maxLength={160} placeholder="Country, state, or city"
            aria-invalid={!!form.formState.errors.location} {...form.register("location", { required: true })} /></label>
          <label>Posting window<select data-testid="research-date" {...form.register("datePosted")}>
            <option value="24h">Last 24 hours</option><option value="week">Last week</option><option value="month">Last month</option>
          </select></label>
          <label>Workplace<select data-testid="research-workplace" {...form.register("workplace")}>
            <option value="">Any workplace</option><option value="remote">Remote</option><option value="hybrid">Hybrid</option><option value="onsite">On-site</option>
          </select></label>
        </div>
        <details className="career-research-options"><summary data-testid="research-more-filters">Seniority, employment, and result limit</summary>
          <div className="career-form-grid">
            <label>Seniority<select data-testid="research-experience" {...form.register("experience")}>
              <option value="">Any seniority</option><option value="internship">Internship</option><option value="entry">Entry level</option>
              <option value="associate">Associate</option><option value="mid_senior">Mid / senior</option><option value="director">Director</option><option value="executive">Executive</option>
            </select></label>
            <label>Employment<select data-testid="research-employment" {...form.register("employment")}>
              <option value="">Any employment</option><option value="fulltime">Full-time</option><option value="parttime">Part-time</option>
              <option value="contract">Contract</option><option value="temporary">Temporary</option><option value="internship">Internship</option>
              <option value="volunteer">Volunteer</option><option value="other">Other</option>
            </select></label>
            <label>Maximum results<input type="number" min={1} max={20} data-testid="research-limit"
              {...form.register("maxResults", { valueAsNumber: true })} /></label>
          </div>
        </details>
        <label className="career-check"><input type="checkbox" data-testid="research-credit-consent" {...form.register("acknowledgeCredits")} />
          <span>This search may use provider credits. No resume or account identity is sent to the source.</span></label>
      </fieldset>
      <button className="button primary" type="submit" disabled={!allowed || busy} data-testid="research-submit">
        <Search size={15} />{busy ? "Checking LinkedIn…" : "Search LinkedIn"}</button>
      {(form.formState.errors.keywords || form.formState.errors.location) && <p role="alert" className="career-error" data-testid="research-required-error">Enter both a role and a location.</p>}
      {message && <p role="alert" className="career-error" data-testid="research-error">{message}</p>}
      <p className="career-muted">Search filters are not verification of remote residency eligibility, stated salary, travel, or qualifications. Nothing is applied to or sent to an employer.</p>
    </form>
    {busy && <section className="career-job-grid" role="status" aria-label="Checking LinkedIn source"><div className="career-job-skeleton" /><div className="career-job-skeleton" /></section>}
    {allowed && result && <section className="career-research-results" aria-label="Research results">
      <div className="career-result-heading"><h2 data-testid="research-result-count">{result.jobs.length} discovered {result.jobs.length === 1 ? "listing" : "listings"}</h2>
        <span>LinkedIn via ReefAPI · {new Date(result.checkedAt).toLocaleString()}</span></div>
      <p className="career-muted">Employer verification and resume matching have not run. Results stay in this view only and cannot yet be saved as tracked applications.</p>
      {result.droppedRecords > 0 && <p className="career-muted">{result.droppedRecords} invalid or duplicate source records were omitted.</p>}
      {!result.jobs.length ? <div className="career-empty"><Search size={28} /><h3>No source results to review.</h3><p>Try a wider posting window or different role keywords. No fictional listings were substituted.</p></div>
        : <div className="career-job-grid">{result.jobs.map(job => <article className="career-job-card" key={job.id} data-testid={`research-job-${job.id}`}>
          <div className="career-company-line"><span>{job.company}</span><span className="career-source-badge">Discovered, not verified</span></div>
          <h3>{job.title}</h3><p>{job.location ?? "Location not stated"}</p>
          <dl className="career-evidence"><div><dt>Workplace label</dt><dd>{job.workplaceLabel ?? "Not stated"}{job.workplaceBasis ? ` (${job.workplaceBasis})` : ""}</dd></div>
            <div><dt>Source salary text</dt><dd>{job.salaryText ?? "Not confirmed"}</dd></div>
            <div><dt>Resume / urgency</dt><dd>Not checked</dd></div></dl>
          <details><summary data-testid={`research-description-${job.id}`}>Source description</summary>
            <p className="career-excerpt">{job.descriptionText ?? "The source did not provide a description."}</p>
            {job.descriptionTruncated && <p className="career-muted">Description shortened. Read the complete source posting.</p>}
          </details>
          <a className="button secondary" href={job.url} target="_blank" rel="noopener noreferrer" data-testid={`research-posting-${job.id}`}>Open LinkedIn posting <ExternalLink size={14} /></a>
          <label className="career-research-url">Posting URL<input readOnly value={job.url} data-testid={`research-url-${job.id}`} onFocus={event => event.currentTarget.select()} /></label>
        </article>)}</div>}
    </section>}
  </>;
}
