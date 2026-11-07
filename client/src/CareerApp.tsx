import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  ArrowDownToLine, ArrowRight, Bookmark, BriefcaseBusiness, Check, ChevronRight,
  CircleHelp, Clipboard, ExternalLink, FileText, Filter, FolderOpen, LockKeyhole,
  Menu, RefreshCw, Search, ShieldCheck, Trash2, UserRound, Users, X,
} from "lucide-react";
import {
  backgroundEditorSchema, backgroundEditorValues, backgroundSchema, careerStages, defaultCareerFilters, emptyBackground,
  filterCareerJobs, jobSnapshot, saveWorkflowSchema,
} from "../../shared/career-schema.js";
import type {
  CareerDocument, CareerFeed, CareerFilters, CareerJob, CareerJobSnapshot, CareerWorkflow, DocumentKind,
} from "../../shared/career-schema.js";
import { generateMaterial, plainMaterial } from "../../shared/application-materials.js";
import { PUBLIC_BRAND } from "../../shared/account-schema.js";
import { CareerProvider, useCareer } from "./career-store.js";
import { apiRequest } from "./lib/queryClient.js";
import { csvCell, downloadFile } from "./lib/export.js";
import "./career.css";
const AccountPage = lazy(() => import("./AccountPage.js"));
const LegacyRecruiterApp = lazy(() => import("./App.js"));

const formatDate = (value: string | null) => value ? new Date(value).toLocaleString(undefined, {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
}) : "Not checked";
const labels: Record<string, string> = {
  "/": "Find jobs", "/jobs": "Find jobs", "/pipeline": "My applications",
  "/studio": "Application studio", "/background": "My background",
  "/workspace-privacy": "Privacy", "/account": "Account",
};
const navigation = [
  { href: "/", key: "jobs", label: "Find jobs", icon: Search },
  { href: "/pipeline", key: "pipeline", label: "My applications", icon: BriefcaseBusiness },
  { href: "/studio", key: "studio", label: "Application studio", icon: FileText },
  { href: "/background", key: "background", label: "My background", icon: UserRound },
  { href: "/workspace-privacy", key: "privacy", label: "Privacy", icon: ShieldCheck },
];
const legacyPaths = ["/recruiters", "/shortlist", "/introductions", "/privacy", "/pricing"];

function Modal({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    node.showModal();
    const cancel = (event: Event) => { event.preventDefault(); close(); };
    node.addEventListener("cancel", cancel);
    return () => { node.removeEventListener("cancel", cancel); node.close(); previous?.focus(); };
  }, [close]);
  return <dialog ref={ref} className="career-modal" aria-label={title}
    onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <header><h2>{title}</h2><button className="icon-button" data-testid="career-close-modal"
      aria-label="Close details" onClick={close}><X size={18} /></button></header>{children}
  </dialog>;
}
function Empty({ title, children }: { title: string; children: ReactNode }) {
  return <div className="career-empty"><FolderOpen size={28} /><h2>{title}</h2>{children}</div>;
}
function SaveLabel() {
  const { canSave } = useCareer();
  return <>{canSave ? "Save privately" : "Keep in this tab"}</>;
}
function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const store = useCareer();
  const [menu, setMenu] = useState(false);
  useEffect(() => { setMenu(false); document.title = `${labels[location] ?? "Workspace"} | ${PUBLIC_BRAND}`; }, [location]);
  return <div className="career-shell">
    <a href="#career-main" className="skip-link" onClick={event => {
      event.preventDefault(); document.getElementById("career-main")?.focus();
    }}>Skip to content</a>
    {menu && <button className="career-backdrop" aria-label="Close navigation" data-testid="career-menu-backdrop" onClick={() => setMenu(false)} />}
    <aside className={`career-sidebar ${menu ? "open" : ""}`} aria-label="Career workspace navigation">
      <Link href="/" className="career-brand" data-testid="career-home">findwork<span>privately.</span></Link>
      <div className="career-workspace-label"><LockKeyhole size={15} /><span>Your career workspace<small>{store.canSave ? "Private account" : "Temporary tab"}</small></span></div>
      <nav aria-label="Career navigation">{navigation.map(item => <Link key={item.key} href={item.href}
        data-testid={`career-nav-${item.key}`} aria-current={location === item.href ? "page" : undefined}
        className={location === item.href || (item.href === "/" && location === "/jobs") ? "active" : ""}>
        <item.icon size={17} />{item.label}{item.key === "pipeline" && store.workspace.jobs.length > 0 && <span className="career-count">{store.workspace.jobs.length}</span>}
      </Link>)}</nav>
      <div className="career-sidebar-bottom">
        <p><ShieldCheck size={16} /> Your search is yours.</p>
        <span>No recruiter access to your workspace.</span>
        <Link href="/recruiters" data-testid="career-recruiter-preview"><Users size={16} />Recruiter preview<small>Sample profiles only</small></Link>
        <a href="https://www.perplexity.ai/" target="_blank" rel="noopener noreferrer" data-testid="career-attribution">Made with Perplexity <ExternalLink size={12} /></a>
      </div>
    </aside>
    <header className="career-topbar">
      <button className="icon-button career-menu-button" aria-label="Toggle navigation" aria-expanded={menu}
        data-testid="career-menu" onClick={() => setMenu(!menu)}><Menu size={19} /></button>
      <span className="career-breadcrumb">Workspace <ChevronRight size={13} /><strong>{labels[location] ?? "Workspace"}</strong></span>
      <span className="career-private-label"><LockKeyhole size={13} />Private by default</span>
      <Link href="/account" className="button secondary" data-testid="career-nav-account"><UserRound size={15} /><span>Account</span></Link>
    </header>
    <main className="career-main" id="career-main" tabIndex={-1}>
      <div className="career-persistence" data-testid="career-storage-status"><LockKeyhole size={14} />
        {store.canSave ? <span>Account saving available. Use Save privately to sync changes.</span>
          : <span>Temporary tab. Export before reloading or signing in. {store.session?.authEnabled ? "Sign in for private saving." : "Account email setup is pending."}</span>}
        <Link href="/account" data-testid="career-storage-account">Account <ArrowRight size={13} /></Link>
      </div>
      {(store.error || store.notice) && <div className={`career-feedback ${store.error ? "error" : ""}`}
        role={store.error ? "alert" : "status"} data-testid="career-feedback">
        {store.error ? <CircleHelp size={16} /> : <Check size={16} />}<span>{store.error || store.notice}</span>
        {store.error && store.canSave && <button className="text-button" data-testid="career-reload-account" onClick={store.reload}>Reload account</button>}
        <button className="icon-button" aria-label="Dismiss message" data-testid="career-dismiss-feedback" onClick={store.dismiss}><X size={15} /></button>
      </div>}
      {store.loading ? <div className="career-loading" role="status">Checking your workspace…</div>
        : store.verificationFailed ? <Empty title="Your account could not be verified."><p>Private workspace contents are hidden until verification succeeds.</p><button className="button primary" data-testid="career-retry-session" onClick={store.reload}>Try again</button></Empty>
        : store.workspaceLocked && location !== "/account" ? <Empty title="Your account cannot open this workspace."><p>Review your account status or sign out to use a temporary tab.</p><Link className="button primary" href="/account">Open account</Link></Empty>
        : children}
    </main>
  </div>;
}

function Jobs() {
  const store = useCareer();
  const [location, navigate] = useLocation();
  const [filters, setFilters] = useState<CareerFilters>({ ...defaultCareerFilters });
  const [more, setMore] = useState(false);
  const [sources, setSources] = useState(false);
  const [selected, setSelected] = useState<CareerJobSnapshot | null>(null);
  const [limit, setLimit] = useState(30);
  const close = useRef(() => setSelected(null)).current;
  const feed = useQuery<CareerFeed>({
    queryKey: ["/api/jobs"], staleTime: 300000, retry: false,
    queryFn: async () => (await apiRequest("GET", "/api/jobs")).json(),
  });
  const pipeline = location === "/pipeline";
  const feedUnavailable = feed.isError || feed.data?.status === "unavailable";
  const rows = filterCareerJobs(feedUnavailable ? [] : feed.data?.jobs ?? [], filters, store.workspace.jobs);
  const active = Object.values(filters).filter(Boolean).length;
  const update = (key: keyof CareerFilters, value: string) => { setFilters(previous => ({ ...previous, [key]: value })); setLimit(30); };
  const options = (key: "industry" | "company" | "employment" | "level") =>
    [...new Set((feed.data?.jobs ?? []).map(job => job[key]))].sort();
  const fields = [
    ["level", "Title-level signal", options("level").map(value => [value, value])],
    ["employment", "Job type", options("employment").map(value => [value, value])],
    ["industry", "Employer sector", options("industry").map(value => [value, value])],
    ["country", "Stated country", [...new Set((feed.data?.jobs ?? []).flatMap(job => job.region))].sort().map(value => [value, value])],
    ["company", "Employer", options("company").map(value => [value, value])],
    ["travel", "Stated maximum travel", [["0", "No travel explicitly stated"], ["10", "10% or less"], ["25", "25% or less"]]],
    ["interviews", "Stated interview steps", [["2", "2 or fewer"], ["3", "3 or fewer"], ["4", "4 or fewer"]]],
    ["posted", "Published date", [["7", "Within 7 days"], ["30", "Within 30 days"]]],
    ["source", "Source check", [["employer_listed", "Successfully checked"], ["source_recheck_failed", "Recheck failed"]]],
    ["stage", "My application stage", [["Untracked", "Not tracked"], ...careerStages.map(stage => [stage, stage])]],
  ] as const;
  function exportWorkflow() {
    const columns = ["Role", "Employer", "Location", "Employer URL", "Stage", "Next action", "Notes", "Applied date", "Follow-up date", "Source checked"];
    const records = store.workspace.jobs.map(row => [row.job.role, row.job.company, row.job.location, row.job.url,
      row.stage, row.nextAction, row.notes, row.appliedDate, row.followUpDate, row.job.checkedAt]);
    downloadFile("find-work-privately-applications.csv", [columns, ...records].map(row => row.map(csvCell).join(",")).join("\r\n"));
  }
  const selectedDetails = feed.data?.jobs.find(job => job.id === selected?.id);
  const selectedWorkflow = store.workspace.jobs.find(job => job.job.id === selected?.id);
  const tracked = store.workspace.jobs.filter(row => (!filters.query
    || `${row.job.role} ${row.job.company} ${row.notes}`.toLowerCase().includes(filters.query.toLowerCase()))
    && (!filters.stage || row.stage === filters.stage));
  return <>
    <section className="career-heading"><div><p className="career-kicker">{pipeline ? "YOUR NEXT STEPS" : "REAL EMPLOYER LISTINGS"}</p>
      <h1>{pipeline ? "Keep your search moving." : "Find a role worth your next step."}</h1>
      <p>{pipeline ? "Jobs, notes, and follow-ups. Never visible to recruiters." : "Explore public employer postings. Keep your application work separate."}</p></div>
      {pipeline ? <button className="button secondary" data-testid="career-export-workflow" disabled={!store.workspace.jobs.length} onClick={exportWorkflow}><ArrowDownToLine size={15} />Export CSV</button>
        : <button className="button secondary" data-testid="career-refresh-jobs" disabled={feed.isFetching} onClick={() => void feed.refetch()}><RefreshCw size={15} className={feed.isFetching ? "career-spin" : ""} />Refresh jobs</button>}
    </section>
    {!pipeline && <div className="career-source-summary">
      <span data-testid="career-feed-status">{feed.isPending ? "Checking employer sources…" : feedUnavailable
        ? "Employer feeds unavailable. Saved applications are unchanged." : feed.data
        ? `${feed.data.jobs.length} listings · ${feed.data.sources.filter(source => source.status === "ok").length}/${feed.data.sources.length} sources confirmed · ${formatDate(feed.data.checkedAt)}`
        : "Employer feeds unavailable"}</span>
      <button className="text-button" data-testid="career-source-toggle" aria-expanded={sources} onClick={() => setSources(!sources)}>Source details <ChevronRight size={13} /></button>
    </div>}
    {sources && feed.data && <section className="career-source-ledger" data-testid="career-source-ledger" aria-label="Employer source checks">
      <p>{feed.data.coverage} No personal resume match is assessed by this feed.</p>
      {feed.data.sources.map(source => <div key={source.id}><strong>{source.company}</strong><span>{source.provider}</span><span>{source.status === "ok" ? "Checked" : source.status === "stale" ? "Recheck failed" : "Unavailable"}</span><span>{formatDate(source.checkedAt)}</span></div>)}
    </section>}
    <section className="career-filters" aria-label="Job filters">
      <label className="career-search"><Search size={17} /><span className="sr-only">Search jobs</span>
        <input data-testid="career-search" placeholder={pipeline ? "Search your applications" : "Role, employer, location, or keyword"}
          value={filters.query} onChange={event => update("query", event.target.value)} /></label>
      {!pipeline && <>
        <label>Workplace<select data-testid="career-filter-workplace" value={filters.workplace} onChange={event => update("workplace", event.target.value)}>
          <option value="">Any workplace</option>{["Remote", "Hybrid", "On-site", "Not specified"].map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Annual USD minimum<select data-testid="career-filter-pay" value={filters.minimumPay} onChange={event => update("minimumPay", event.target.value)}>
          <option value="">Any / unknown pay</option>{[70000, 90000, 110000, 150000].map(value => <option key={value} value={value}>${value.toLocaleString()}+</option>)}</select></label>
      </>}
      {pipeline ? <label>Application stage<select data-testid="career-pipeline-stage" value={filters.stage} onChange={event => update("stage", event.target.value)}><option value="">All stages</option>{careerStages.map(stage => <option key={stage}>{stage}</option>)}</select></label>
        : <button className="button secondary" data-testid="career-more-filters" aria-expanded={more} onClick={() => setMore(!more)}><Filter size={15} />{more ? "Fewer filters" : "More filters"}{active > 0 && ` (${active})`}</button>}
      <button className="text-button" data-testid="career-clear-filters" onClick={() => { setFilters({ ...defaultCareerFilters }); setLimit(30); }}>Clear filters</button>
    </section>
    {more && !pipeline && <section className="career-more-filters" aria-label="More job filters">
      {fields.map(([key, label, choices]) => <label key={key}>{label}<select data-testid={`career-filter-${key}`}
        value={filters[key]} onChange={event => update(key, event.target.value)}><option value="">Any / not specified</option>
        {choices.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>)}
      <p>Unknown values do not qualify for numeric limits. Remote does not mean eligible everywhere. Interview steps are not a timing guarantee.</p>
    </section>}
    {pipeline ? <>
      <div className="career-result-heading"><h2 data-testid="career-pipeline-count">{tracked.length} tracked applications</h2><Link href="/" className="text-button">Find more jobs <ArrowRight size={13} /></Link></div>
      {tracked.length ? <div className="career-pipeline">{tracked.map(row => <article key={row.job.id} className="career-pipeline-row" data-testid={`career-tracked-${row.job.id}`}>
        <div><span className="career-stage">{row.stage}</span><button className="career-role-button" data-testid={`career-edit-${row.job.id}`} onClick={() => setSelected(row.job)}>{row.job.role}</button>
          <p>{row.job.company} · {row.job.location}</p></div>
        <div><span>Next action</span><p>{row.nextAction || "Choose your next step"}</p></div>
        <div><span>Follow-up</span><p>{row.followUpDate || "Not set"}</p></div>
        <button className="button secondary" data-testid={`career-workflow-${row.job.id}`} onClick={() => setSelected(row.job)}>Edit workflow <ChevronRight size={14} /></button>
      </article>)}</div> : <Empty title="Your next opportunity goes here."><p>Save a real employer listing to start tracking it.</p><Link className="button primary" href="/" data-testid="career-empty-find-jobs">Find jobs <ArrowRight size={14} /></Link></Empty>}
    </> : <>
      <div className="career-result-heading"><h2 data-testid="career-job-count">{rows.length} matching listings</h2><span>No hiring-odds claims. Check the employer's full posting.</span></div>
      {feed.isPending ? <div className="career-job-grid" role="status" aria-label="Loading employer jobs">{[1, 2, 3, 4].map(value => <div key={value} className="career-job-skeleton" />)}</div>
        : feed.isError || feed.data?.status === "unavailable" ? <Empty title="The employer sources could not be checked."><p>No fictional jobs have been substituted. Try again or inspect source details.</p><button className="button primary" data-testid="career-retry-jobs" onClick={() => void feed.refetch()}>Try again</button></Empty>
        : !rows.length ? <Empty title="No jobs match these filters."><p>Try a broader search or clear a requirement.</p><button className="button primary" data-testid="career-reset-empty" onClick={() => setFilters({ ...defaultCareerFilters })}>Clear filters</button></Empty>
        : <div className="career-job-grid">{rows.slice(0, limit).map(job => {
          const saved = store.workspace.jobs.find(row => row.job.id === job.id);
          return <article key={job.id} className="career-job-card" data-testid={`career-job-${job.id}`}>
            <div className="career-company-line"><span>{job.company}</span><span className="career-source-badge">{job.source}</span></div>
            <h3><button className="career-role-button" data-testid={`career-view-${job.id}`} onClick={() => setSelected(job)}>{job.role}</button></h3>
            <p>{job.location}</p><div className="career-job-facts"><span>{job.workplace}</span><span>{job.employment}</span></div>
            <p className="career-pay">{job.payText || "Pay not stated"}</p>
            <div className="career-job-bottom"><span>{job.availability === "source_recheck_failed" ? "Source recheck failed" : "Employer listed"} · {formatDate(job.checkedAt)}</span>
              <button className={`icon-button ${saved ? "is-saved" : ""}`} aria-label={saved ? "Open saved application" : "Save job"}
                data-testid={`career-save-${job.id}`} disabled={store.busy} onClick={() => saved ? setSelected(job)
                  : void store.saveJob({ job: jobSnapshot(job), stage: "Saved", notes: "", nextAction: "", appliedDate: "", followUpDate: "", expectedVersion: 0 }).catch(() => {})}>
                {saved ? <Check size={17} /> : <Bookmark size={17} />}</button>
            </div>
          </article>;
        })}</div>}
      {rows.length > limit && <button className="button secondary career-show-more" data-testid="career-show-more" onClick={() => setLimit(limit + 30)}>Show more listings</button>}
    </>}
    {selected && <Modal title={selected.role} close={close}>
      <div className="career-job-detail"><p className="career-kicker">{selected.company}</p><h2>{selected.role}</h2><p>{selected.location}</p>
        <a className="button primary" href={selected.url} target="_blank" rel="noopener noreferrer" data-testid="career-employer-link">View employer posting <ExternalLink size={14} /></a>
        <label>Employer posting URL<input readOnly data-testid="career-employer-url" value={selected.url}
          onFocus={event => event.currentTarget.select()} /></label>
        <p className="career-muted">If the employer page is blocked, copy its URL and open it in your browser.</p>
        <p className="career-muted">Opens the employer. Nothing is submitted for you.</p>
        {selectedDetails ? <><dl className="career-evidence">
          {[["Workplace", `${selectedDetails.workplace} · ${selectedDetails.workplaceBasis}`], ["Pay", selectedDetails.payText || "Not stated"],
            ["Pay basis", selectedDetails.payBasis], ["Pay note", selectedDetails.salaryNote || "Confirm the applicable location and pay tier with the employer."], ["Title level", `${selectedDetails.level} · ${selectedDetails.levelBasis}`],
            ["Travel", selectedDetails.travelEvidence || "Not specified"], ["Interview", selectedDetails.interviewEvidence || "Not specified"],
            ["Source status", selectedDetails.availability === "employer_listed" ? "Employer listed at last successful check" : "Source recheck failed; recheck the employer"],
            ["Source check", formatDate(selectedDetails.checkedAt)]].map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}
        </dl><h3>Employer excerpt</h3><p className="career-excerpt">{selectedDetails.excerpt || "Read the full employer posting for details."}</p>
          <p className="career-muted">Excerpt only. No personal resume match has been assessed.</p>
          <button className="button secondary" data-testid="career-make-for-job" onClick={() => { store.setTarget(selectedDetails); close(); navigate("/studio"); }}>Make application materials <ArrowRight size={14} /></button></>
          : <p className="career-muted">Saved snapshot. This role is not in the current feed; recheck the employer before applying.</p>}
        <WorkflowForm key={`${selected.id}-${selectedWorkflow?.version ?? 0}`} job={selected}
          {...(selectedWorkflow ? { workflow: selectedWorkflow } : {})} />
      </div>
    </Modal>}
  </>;
}
const workflowFields = saveWorkflowSchema.omit({ job: true, expectedVersion: true });
function WorkflowForm({ job, workflow }: { job: CareerJobSnapshot; workflow?: CareerWorkflow }) {
  const store = useCareer();
  const form = useForm<z.infer<typeof workflowFields>>({
    resolver: zodResolver(workflowFields),
    defaultValues: { stage: workflow?.stage ?? "Saved", notes: workflow?.notes ?? "",
      nextAction: workflow?.nextAction ?? "", appliedDate: workflow?.appliedDate ?? "", followUpDate: workflow?.followUpDate ?? "" },
  });
  return <form className="career-workflow-form" onSubmit={form.handleSubmit(value =>
    store.saveJob({ ...value, job, expectedVersion: workflow?.version ?? 0 }).catch(() => {}))}>
    <h3>My private application workflow</h3>
    <div className="career-form-grid"><label>Stage<select data-testid="career-workflow-stage" {...form.register("stage")}>{careerStages.map(stage => <option key={stage}>{stage}</option>)}</select></label>
      <label>Next action<input maxLength={500} data-testid="career-workflow-action" {...form.register("nextAction")} /></label>
      <label>Applied date<input type="date" data-testid="career-workflow-applied" {...form.register("appliedDate")} /></label>
      <label>Follow-up date<input type="date" data-testid="career-workflow-followup" {...form.register("followUpDate")} /></label></div>
    <label>Notes<textarea maxLength={10000} data-testid="career-workflow-notes" {...form.register("notes")} /></label>
    {Object.keys(form.formState.errors).length > 0 && <p role="alert" className="career-error">Check your notes and dates.</p>}
    <button className="button primary" disabled={store.busy} data-testid="career-save-workflow"><SaveLabel /> <Check size={14} /></button>
  </form>;
}

function Background() {
  const store = useCareer();
  const current = store.workspace.background;
  const facts = current?.content ?? emptyBackground;
  const form = useForm<z.infer<typeof backgroundEditorSchema>>({
    resolver: zodResolver(backgroundEditorSchema),
    defaultValues: backgroundEditorValues(facts),
  });
  const [validation, setValidation] = useState("");
  const lines = (value: string, separator: string | RegExp) => value.split(separator).map(item => item.trim()).filter(Boolean);
  return <>
    <section className="career-heading"><div><p className="career-kicker">FACTS, NOT FABRICATIONS</p><h1>Build from your actual background.</h1>
      <p>These facts support your drafts. They do not create a recruiter profile.</p></div></section>
    <form className="career-background-form" onSubmit={form.handleSubmit(async value => {
      const { skillsText, experienceText, educationText, ...fields } = value;
      const parsed = backgroundSchema.safeParse({ ...fields, skills: [...new Set(lines(skillsText, ","))],
        experience: lines(experienceText, /\r?\n/), education: lines(educationText, /\r?\n/) });
      if (!parsed.success) { setValidation("Use up to 30 skills, 30 experience lines (800 characters each), and 12 education lines. Check your email and field lengths."); return; }
      setValidation(""); await store.saveBackground(parsed.data, current?.version ?? 0).catch(() => {});
    })}>
      <fieldset><legend>About you</legend><div className="career-form-grid">
        <label>Your name<input maxLength={100} data-testid="career-background-name" {...form.register("name")} /></label>
        <label>Professional headline<input maxLength={160} data-testid="career-background-headline" placeholder="Your actual professional focus" {...form.register("headline")} /></label>
        <label>Location<input maxLength={160} data-testid="career-background-location" {...form.register("location")} /></label>
        <label>Contact email (optional)<input type="email" maxLength={254} data-testid="career-background-email" {...form.register("email")} /></label>
      </div><label>Professional summary<textarea maxLength={3000} data-testid="career-background-summary" placeholder="A factual overview in your own words" {...form.register("summary")} /></label></fieldset>
      <fieldset><legend>Evidence for your applications</legend>
        <label>Skills, separated by commas<textarea maxLength={2500} data-testid="career-background-skills" {...form.register("skillsText")} /></label>
        <label>Experience facts, one per line<textarea className="career-experience-input" maxLength={25000} data-testid="career-background-experience"
          placeholder="Include the employer, your role, dates, and what you actually did. Add only results you can support." {...form.register("experienceText")} /></label>
        <label>Education and certifications, one per line<textarea maxLength={4000} data-testid="career-background-education"
          placeholder="Distinguish completed credentials from study or planned exams." {...form.register("educationText")} /></label>
      </fieldset>
      {(validation || Object.keys(form.formState.errors).length > 0) && <p className="career-error" role="alert">{validation || "Check your email and field lengths."}</p>}
      <div className="career-form-actions"><button className="button primary" disabled={store.busy} data-testid="career-save-background"><SaveLabel /> <Check size={14} /></button>
        <Link href="/studio" className="button secondary" data-testid="career-background-to-studio">Open application studio <ArrowRight size={14} /></Link></div>
      <p className="career-muted">No automatic import of your old tracker or resumes. Never put passwords, government IDs, or confidential client information here.</p>
    </form>
  </>;
}
function Studio() {
  const store = useCareer();
  const [kind, setKind] = useState<DocumentKind>("resume");
  const [role, setRole] = useState(store.target?.role ?? "");
  const [company, setCompany] = useState(store.target?.company ?? "");
  const [reviewed, setReviewed] = useState(false);
  const [draft, setDraft] = useState<CareerDocument | null>(null);
  const [message, setMessage] = useState("");
  const [remove, setRemove] = useState<string | null>(null);
  useEffect(() => { setRole(store.target?.role ?? ""); setCompany(store.target?.company ?? ""); setDraft(null); }, [store.target?.id]);
  const background = store.workspace.background?.content ?? emptyBackground;
  function generate() {
    setMessage("");
    if (!reviewed) { setMessage("Confirm that your background contains only facts you can support."); return; }
    try {
      const material = generateMaterial(kind, background, { role, company, excerpt: store.target?.excerpt ?? "" });
      setDraft({ id: crypto.randomUUID(), kind, title: material.title, body: material.body,
        targetRole: role.trim(), targetCompany: company.trim(), sourceJobId: store.target?.id ?? null, version: 0 });
    } catch (error) { setMessage(error instanceof Error ? error.message : "Check your background and target role."); }
  }
  function exportDraft(markdown: boolean) {
    if (!draft) return;
    const name = draft.targetRole.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60) || "application";
    downloadFile(`${draft.kind}-${name}.${markdown ? "md" : "txt"}`, markdown ? draft.body : plainMaterial(draft.body),
      markdown ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8");
  }
  return <>
    <section className="career-heading"><div><p className="career-kicker">YOUR FACTS. YOUR NEXT DRAFT.</p><h1>Make your application materials.</h1>
      <p>Factual drafts you can edit, review, and export. Nothing is sent to an employer.</p></div>
      <Link href="/background" className="button secondary" data-testid="career-studio-background">Edit background <ArrowRight size={14} /></Link></section>
    <div className="career-studio-layout"><section className="career-studio-controls">
      <h2>Start with your background</h2><p className="career-muted" data-testid="career-studio-fact-count">{background.experience.length} experience facts · {background.skills.length} self-reported skills</p>
      {!background.name && <p className="career-inline-help">Add your background before making a draft. <Link href="/background">Open My background</Link></p>}
      <label>Material<select data-testid="career-material-kind" value={kind} onChange={event => setKind(event.target.value as DocumentKind)}>
        <option value="resume">Resume draft</option><option value="cover_letter">Cover letter</option><option value="interview_prep">Interview preparation</option></select></label>
      <label>Target role<input maxLength={250} data-testid="career-material-role" value={role} onChange={event => setRole(event.target.value)} /></label>
      <label>Employer (optional)<input maxLength={160} data-testid="career-material-company" value={company} onChange={event => setCompany(event.target.value)} /></label>
      {store.target && <p className="career-target">Selected from {store.target.source}. <button className="text-button" data-testid="career-clear-target" onClick={() => store.setTarget(null)}>Clear target</button></p>}
      <label className="career-check"><input type="checkbox" data-testid="career-confirm-facts" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />
        <span>My background contains only facts I can support.</span></label>
      <button className="button primary" data-testid="career-generate-material" onClick={generate}>Create draft <ArrowRight size={14} /></button>
      <p className="career-muted">Runs locally from your entered facts. No paid AI request, invented credentials, or hiring-odds score. Review before use.</p>
      {message && <p role="alert" className="career-error" data-testid="career-studio-message">{message}</p>}
      <section className="career-document-list"><h2>Your drafts</h2>
        {!store.workspace.documents.length && <p className="career-muted">Keep a draft to return to it.</p>}
        {store.workspace.documents.map(document => <div key={document.id} data-testid={`career-document-${document.id}`}>
          <button className="career-role-button" data-testid={`career-open-document-${document.id}`} onClick={() => { setDraft(document); setKind(document.kind); setRole(document.targetRole); setCompany(document.targetCompany); setMessage(""); }}>{document.title}</button>
          {remove === document.id ? <div className="career-remove-confirm"><span>Remove this draft?</span><button className="text-button" data-testid="career-confirm-remove-document" onClick={() => void store.removeDocument(document).then(() => { setRemove(null); if (draft?.id === document.id) setDraft(null); }).catch(() => {})}>Remove</button><button className="text-button" data-testid="career-cancel-remove-document" onClick={() => setRemove(null)}>Cancel</button></div>
            : <button className="icon-button" aria-label={`Remove ${document.title}`} data-testid={`career-remove-document-${document.id}`} onClick={() => setRemove(document.id)}><Trash2 size={14} /></button>}
        </div>)}
      </section>
    </section><section className="career-draft-editor" aria-label="Application draft">
      {draft ? <>
        <label>Draft title<input maxLength={200} data-testid="career-draft-title" value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
        <label className="career-draft-body">Editable draft<textarea maxLength={50000} data-testid="career-draft-body" value={draft.body} onChange={event => setDraft({ ...draft, body: event.target.value })} /></label>
        <div className="career-form-actions"><button className="button primary" disabled={store.busy || !draft.body.trim() || !draft.title.trim()} data-testid="career-save-document"
          onClick={() => { const { version, ...content } = draft; void store.saveDocument({ ...content, expectedVersion: version }).then(() => setDraft({ ...draft, version: version + 1 })).catch(() => {}); }}><SaveLabel /> <Check size={14} /></button>
          <button className="button secondary" data-testid="career-download-text" onClick={() => exportDraft(false)}><ArrowDownToLine size={14} />Text</button>
          <button className="button secondary" data-testid="career-download-markdown" onClick={() => exportDraft(true)}>Markdown</button>
          <button className="button secondary" data-testid="career-copy-draft" onClick={() => void navigator.clipboard.writeText(plainMaterial(draft.body))
            .then(() => setMessage("Draft copied.")).catch(() => setMessage("Clipboard access is blocked. Use a download button instead."))}><Clipboard size={14} />Copy</button>
        </div>
        <p className="career-muted">Review names, dates, qualifications, and claims. Downloaded files stay on your device and are not deleted by account deletion.</p>
      </> : <Empty title="A useful draft starts with real facts."><p>Choose the material, enter a target role, and create your first draft.</p><FileText size={34} /></Empty>}
    </section></div>
  </>;
}
function Privacy() {
  const store = useCareer();
  return <>
    <section className="career-heading"><div><p className="career-kicker">CONTROL, BEFORE CONNECTIONS</p><h1>Your workspace is not a public profile.</h1><p>Looking for a job should not announce that you are looking.</p></div></section>
    <section className="career-privacy-panel"><ShieldCheck size={22} /><h2>No recruiter access is enabled.</h2>
      <p>Your background, drafts, applications, and notes are not part of the recruiter preview. Creating materials does not publish them.</p>
      <dl><div><dt>Current storage</dt><dd>{store.canSave ? "Explicit saving to your own verified candidate account." : "Temporary React memory in this tab. Reloading or changing accounts clears it."}</dd></div>
        <div><dt>Application materials</dt><dd>Built locally from the facts you enter. No employer message or paid AI request is sent.</dd></div>
        <div><dt>Recruiter preview</dt><dd>Synthetic sample profiles only. Real discovery, company verification, and identity release are not enabled.</dd></div>
        <div><dt>Your existing personal tracker</dt><dd>Not imported, moved, or published by this combined workspace.</dd></div>
        <div><dt>Payments</dt><dd>No checkout or paid subscription is enabled.</dd></div></dl>
      <Link href="/account" className="button primary" data-testid="career-privacy-account">Account and deletion controls <ArrowRight size={14} /></Link>
    </section>
  </>;
}
function CareerRoutes() {
  const [location] = useLocation();
  const store = useCareer();
  if (legacyPaths.includes(location)) return <Suspense fallback={<div role="status" className="career-loading">Opening recruiter preview…</div>}><LegacyRecruiterApp /></Suspense>;
  let content: ReactNode;
  if (["/", "/jobs", "/pipeline"].includes(location)) content = <Jobs key={store.owner} />;
  else if (location === "/studio") content = <Studio key={store.owner} />;
  else if (location === "/background") content = <Background key={`${store.owner}-${store.workspace.background?.version ?? 0}`} />;
  else if (location === "/workspace-privacy") content = <Privacy />;
  else if (location === "/account") content = <Suspense fallback={<div role="status" className="career-loading">Opening account…</div>}><AccountPage /></Suspense>;
  else content = <Empty title="That page is not here."><p>Return to your career workspace.</p><Link className="button primary" href="/">Find jobs</Link></Empty>;
  return <Shell>{content}</Shell>;
}
export default function CareerApp() {
  return <CareerProvider><CareerRoutes /></CareerProvider>;
}
