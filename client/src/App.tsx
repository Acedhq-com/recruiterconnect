import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowDownToLine, ArrowRight, Bookmark, Check, ChevronDown, ChevronRight, CircleHelp,
  Clock3, EyeOff, FileSearch, Filter, FolderHeart, Handshake, LockKeyhole, MapPin,
  Menu, Plus, Search, ShieldCheck, SlidersHorizontal, Sparkles, Trash2, Users, X,
} from "lucide-react";
import { candidates } from "../../shared/candidates.js";
import {
  arrangements, availabilityOptions, defaultFilters, employmentTypes, filterCandidates,
  industries, insertPilotLeadSchema,
} from "../../shared/schema.js";
import type { Candidate, Filters, InsertPilotLead, IntroRequest, SavedSearch } from "../../shared/schema.js";
import { apiRequest } from "./lib/queryClient.js";
import { downloadFile, shortlistCsv } from "./lib/export.js";
import { evaluate } from "../../typescript/src/reference.js";
import baseContext from "../../shared/base.json";
import { Sidebar, SidebarProvider } from "./components/ui/sidebar.js";
import AccountPage from "./AccountPage.js";
import { PUBLIC_BRAND } from "../../shared/account-schema.js";

type ModalState = { kind: "profile"; candidate: Candidate } | { kind: "intro"; candidate: Candidate }
  | { kind: "pilot"; plan: "candidate" | "founding" | "team" }
  | { kind: "save" } | { kind: "trust" } | null;

const money = (amount: number) => `$${Math.round(amount / 1000)}k`;
const nav = [
  { href: "/recruiters", label: "Discover talent", icon: Search },
  { href: "/shortlist", label: "Your shortlist", icon: Bookmark },
  { href: "/introductions", label: "Introductions", icon: Handshake },
  { href: "/privacy", label: "Candidate controls", icon: ShieldCheck },
  { href: "/account", label: "Your account", icon: Users },
];

export function Dialog({ title, onClose, children, wide = false }: {
  title: string; onClose: () => void; children: ReactNode; wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    const cancel = (event: Event) => { event.preventDefault(); onClose(); };
    element.addEventListener("cancel", cancel);
    return () => { element.removeEventListener("cancel", cancel); element.close(); previous?.focus(); };
  }, [onClose]);
  return <dialog ref={ref} className={`dialog ${wide ? "dialog-wide" : ""}`} aria-labelledby="dialog-title"
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <header className="dialog-header"><h2 id="dialog-title">{title}</h2>
      <button className="icon-button" aria-label="Close dialog" data-testid="button-close-dialog" onClick={onClose}><X size={20} /></button>
    </header><div className="dialog-body">{children}</div>
  </dialog>;
}

function App() {
  const [location] = useLocation();
  const [filters, setFilters] = useState<Filters>({ ...defaultFilters });
  const [savedIds, setSavedIds] = useState<string[]>([]);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);
  const [requests, setRequests] = useState<IntroRequest[]>([]);
  const [modal, setModal] = useState<ModalState>(null);
  const [sort, setSort] = useState("default");
  const [mobileMenu, setMobileMenu] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [notice, setNotice] = useState("");
  const [searchName, setSearchName] = useState("");
  const closeDialog = useRef(() => setModal(null)).current;
  const isShortlist = location === "/shortlist";
  const isDiscovery = location === "/recruiters" || isShortlist;
  const filtered = filterCandidates(candidates.filter(candidate => !isShortlist || savedIds.includes(candidate.id)), filters);
  const results = [...filtered].sort((a, b) => sort === "salary" ? a.salaryMin - b.salaryMin : sort === "experience" ? b.experience - a.experience : 0);
  const savedCandidates = candidates.filter(candidate => savedIds.includes(candidate.id));
  const activeCount = Object.keys(defaultFilters).filter(key =>
    JSON.stringify(filters[key as keyof Filters]) !== JSON.stringify(defaultFilters[key as keyof Filters])).length;
  const pending = requests.filter(request => request.status !== "Withdrawn").length;
  useEffect(() => {
    document.title = `${location === "/account" ? "Your account" : location === "/privacy" ? "Candidate controls" : location === "/pricing" ? "Pilot & pricing" : isShortlist ? "Your shortlist" : location === "/introductions" ? "Introductions" : "Discover talent"} | ${PUBLIC_BRAND}`;
    setMobileMenu(false);
    setNotice("");
  }, [location, isShortlist]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
          && !document.querySelector("dialog[open]")) {
        const search = document.querySelector<HTMLInputElement>('[data-testid="input-search"]');
        if (search) { event.preventDefault(); search.focus(); }
      }
    };
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, []);
  const update = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters(previous => ({ ...previous, [key]: value }));
  const toggleSave = (id: string) => setSavedIds(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id]);
  const addRequest = (request: Omit<IntroRequest, "id" | "status">) => {
    setRequests(previous => [...previous, { ...request, id: crypto.randomUUID(), status: "Pending candidate approval" }]);
    setModal(null);
    setNotice("Demo introduction added. No message was sent and no identity was shared.");
  };
  return <>
    <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>Skip to content</a>
    <SidebarProvider style={{ "--sidebar-width": "220px" } as CSSProperties}>
    <div className="app-shell w-full">
      <Sidebar collapsible="none" role="complementary" aria-label="Workspace navigation" className={`sidebar ${mobileMenu ? "is-open" : ""}`}>
        <Link href="/" className="wordmark" data-testid="link-home" onClick={() => setMobileMenu(false)} aria-label="Find Work Privately home">findwork<span>privately</span><span className="brand-period">.</span></Link>
        <div className="workspace"><span className="workspace-letter">H</span><span>Harbor workspace<small>Interactive demo</small></span><LockKeyhole size={14} /></div>
        <p className="nav-label">YOUR WORKSPACE</p>
        <nav aria-label="Main navigation">{nav.map(item => <Link key={item.href} href={item.href}
          data-testid={`nav-${item.href === "/recruiters" ? "discover" : item.href.slice(1)}`}
          className={`nav-item ${location === item.href ? "active" : ""}`} aria-current={location === item.href ? "page" : undefined} onClick={() => setMobileMenu(false)}>
          <item.icon size={18} /><span>{item.label}</span>{item.href === "/shortlist" && savedIds.length > 0 && <b>{savedIds.length}</b>}
          {item.href === "/introductions" && pending > 0 && <b>{pending}</b>}
        </Link>)}</nav>
        <div className="sidebar-note"><EyeOff size={20} /><p>Potential, not personal data.</p><span>People decide who sees them and when to make an introduction.</span></div>
        <div className="sidebar-bottom">
          <Link href="/pricing" data-testid="nav-pricing" className={`nav-item ${location === "/pricing" ? "active" : ""}`} onClick={() => setMobileMenu(false)}><Sparkles size={18} /><span>Pilot & pricing</span><ArrowRight size={15} /></Link>
          <button className="nav-item" data-testid="button-trust" onClick={() => setModal({ kind: "trust" })}><CircleHelp size={18} /><span>Trust & how it works</span></button>
          <div className="session-label"><span className="status-dot" />Demo session<small>Resets on refresh or leaving this preview</small></div>
          <a className="attribution" href="https://www.perplexity.ai/" target="_blank" rel="noreferrer" data-testid="link-perplexity">Made with Perplexity</a>
        </div>
      </Sidebar>
      <div className="workspace-main">
        <header className="topbar">
          <button className="icon-button mobile-menu" aria-label="Toggle navigation" aria-expanded={mobileMenu} data-testid="button-mobile-menu" onClick={() => setMobileMenu(!mobileMenu)}><Menu size={21} /></button>
          <div className="breadcrumb">Workspace <ChevronRight size={14} /><span>{location === "/account" ? "Your account" : location === "/privacy" ? "Candidate controls" : location === "/pricing" ? "Pilot & pricing" : isShortlist ? "Your shortlist" : location === "/introductions" ? "Introductions" : "Discover talent"}</span></div>
          <span className="topbar-status"><ShieldCheck size={15} /> Consent comes first</span>
          <Link href="/account" className="button secondary account-link" aria-label="Your account" data-testid="button-account"><Users size={16} /><span>Your account</span></Link>
          <button className="avatar-button" aria-label="About this demo workspace" data-testid="button-workspace-info" onClick={() => setModal({ kind: "trust" })}>H</button>
        </header>
        <main id="main-content" tabIndex={-1}>
          <div className="demo-banner"><span className="status-dot" /><strong>{location === "/account" ? "Private account beta" : "Interactive preview"}</strong><span>{location === "/account" ? "Private account setup only. Production discovery and billing are not enabled." : "All profiles are synthetic. No real candidate data or messages."}</span></div>
          {notice && <div className="notice" role="status" data-testid="status-notice"><Check size={17} /><span>{notice}</span><button className="icon-button" aria-label="Dismiss update" onClick={() => setNotice("")}><X size={16} /></button></div>}
          {isDiscovery && <>
            <section className="page-heading">
              <div><p className="eyebrow">{isShortlist ? "GOOD PEOPLE, IN ONE PLACE" : "A MORE CONSIDERED CONNECTION"}</p>
                <h1>{isShortlist ? "Your next conversation starts here." : "Talent, on their terms."}</h1>
                <p>{isShortlist ? "A thoughtful shortlist. An introduction only when both sides are ready." : "Find the right experience. Start a conversation without compromising someone’s privacy."}</p></div>
              <button className="button primary" data-testid="button-join-pilot" onClick={() => setModal({ kind: "pilot", plan: "founding" })}>Join the recruiter pilot <ArrowRight size={16} /></button>
            </section>
            <div className="privacy-strip"><ShieldCheck size={20} /><div><strong>Anonymous by design.</strong><span>Names, employers, and contact details stay private until the candidate approves.</span></div><button data-testid="button-how-privacy" onClick={() => setModal({ kind: "trust" })}>How it works <ArrowRight size={14} /></button></div>
            <div className="search-line">
              <label className="search-field"><Search size={19} /><span className="sr-only">Search roles or skills</span><input data-testid="input-search" value={filters.query} onChange={event => update("query", event.target.value)} placeholder="Search roles, skills, or keywords" />{filters.query && <button className="icon-button" aria-label="Clear search" data-testid="button-clear-query" onClick={() => update("query", "")}><X size={16} /></button>}<kbd>/</kbd></label>
              <button className="button secondary" data-testid="button-save-search" onClick={() => { setSearchName(""); setModal({ kind: "save" }); }}><Bookmark size={16} />Save search</button>
              <button className="button secondary filter-toggle" data-testid="button-mobile-filters" onClick={() => setShowFilters(!showFilters)} aria-expanded={showFilters}><SlidersHorizontal size={16} />Filters{activeCount > 0 && ` (${activeCount})`}</button>
            </div>
            <div className="industry-tabs" aria-label="Filter by profession">{industries.map(industry => <button key={industry} data-testid={`industry-${(industry.split(" ")[0] ?? "all").toLowerCase()}`} className={filters.industry === industry ? "selected" : ""} aria-pressed={filters.industry === industry} onClick={() => update("industry", industry)}>{industry}</button>)}</div>
            {savedSearches.length > 0 && <div className="saved-search-row"><span>Saved searches</span>{savedSearches.map(search => <span className="saved-search" key={search.id}><button data-testid={`apply-search-${search.id}`} onClick={() => { setFilters(structuredClone(search.filters)); setNotice(`Applied “${search.name}”.`); }}>{search.name}</button><button data-testid={`delete-search-${search.id}`} aria-label={`Delete saved search ${search.name}`} onClick={() => setSavedSearches(previous => previous.filter(item => item.id !== search.id))}><X size={13} /></button></span>)}</div>}
            <div className="discovery-layout">
              <aside className={`filter-panel ${showFilters ? "visible" : ""}`} aria-label="Candidate filters">
                <div className="filter-title"><h2><SlidersHorizontal size={16} /> Refine your search</h2><button className="text-button" data-testid="button-clear-filters" onClick={() => setFilters({ ...defaultFilters })}>Reset</button></div>
                <label className="field-label" htmlFor="location">Location</label><div className="select-wrap"><MapPin size={15} /><select id="location" data-testid="filter-location" value={filters.location} onChange={event => update("location", event.target.value)}>{["Anywhere", ...new Set(candidates.map(candidate => candidate.location))].map(value => <option key={value}>{value}</option>)}</select></div>
                <fieldset><legend>Work arrangement</legend>{arrangements.map(value => <label className="check-row" key={value}><input type="checkbox" data-testid={`filter-${value.toLowerCase()}`} checked={filters.arrangements.includes(value)} onChange={() => update("arrangements", filters.arrangements.includes(value) ? filters.arrangements.filter(item => item !== value) : [...filters.arrangements, value])} /><span>{value}</span><small>{candidates.filter(candidate => candidate.arrangement === value).length}</small></label>)}</fieldset>
                <label className="field-label" htmlFor="employment">Employment type</label><select id="employment" data-testid="filter-employment" value={filters.employment} onChange={event => update("employment", event.target.value)}>{["Any type", ...employmentTypes].map(value => <option key={value}>{value}</option>)}</select>
                <fieldset><legend>Years of experience</legend><div className="range-selects"><label><span className="sr-only">Minimum experience</span><select data-testid="filter-experience-min" value={filters.experienceMin} onChange={event => { const value = Number(event.target.value); setFilters(previous => ({ ...previous, experienceMin: value, experienceMax: Math.max(value, previous.experienceMax) })); }}>{[0, 2, 4, 6, 8, 10, 15, 20].map(value => <option key={value} value={value}>{value} years</option>)}</select></label><span>to</span><label><span className="sr-only">Maximum experience</span><select data-testid="filter-experience-max" value={filters.experienceMax} onChange={event => { const value = Number(event.target.value); setFilters(previous => ({ ...previous, experienceMax: value, experienceMin: Math.min(value, previous.experienceMin) })); }}>{[0, 2, 4, 6, 8, 10, 15, 20].map(value => <option key={value} value={value}>{value === 20 ? "20+ years" : `${value} years`}</option>)}</select></label></div></fieldset>
                <fieldset><legend><label htmlFor="budget">Your maximum budget</label><span>{money(filters.budget)}{filters.budget === 250000 ? "+" : ""}</span></legend><input id="budget" data-testid="filter-budget" type="range" min="60000" max="250000" step="5000" value={filters.budget} onChange={event => update("budget", Number(event.target.value))} /><div className="range-labels"><span>$60k</span><span>$250k+</span></div><p className="filter-help">Matches profiles whose minimum desired pay fits your budget. USD, annualized.</p></fieldset>
                <label className="field-label" htmlFor="availability">Availability</label><select id="availability" data-testid="filter-availability" value={filters.availability} onChange={event => update("availability", event.target.value)}>{availabilityOptions.map(value => <option key={value}>{value}</option>)}</select>
                <div className="filter-footnote"><LockKeyhole size={15} /><p>Only job-related filters. No protected-characteristic screening.</p></div>
              </aside>
              <section className="results" aria-label="Candidate results">
                <div className="results-heading"><div><h2 data-testid="text-result-count">{results.length} {isShortlist ? "shortlisted" : "sample"} profiles</h2><span>Meet the experience. Not the identity.</span></div><div className="result-tools">{isShortlist && savedCandidates.length > 0 && <button className="icon-button" data-testid="button-export-shortlist" aria-label="Export anonymous shortlist CSV" onClick={() => downloadFile("find-work-privately-sample-shortlist.csv", shortlistCsv(savedCandidates))}><ArrowDownToLine size={19} /></button>}<label className="sort-label"><span>Sort:</span><select data-testid="select-sort" aria-label="Sort candidates" value={sort} onChange={event => setSort(event.target.value)}><option value="default">Default order</option><option value="experience">Most experience</option><option value="salary">Lowest salary first</option></select></label></div></div>
                {activeCount > 0 && <div className="active-filters"><span><Filter size={13} />{activeCount} active filters</span><button className="text-button" data-testid="button-clear-all" onClick={() => setFilters({ ...defaultFilters })}>Clear all</button></div>}
                {results.length > 0 ? <div className="candidate-grid">{results.map(candidate => <CandidateCard key={candidate.id} candidate={candidate} saved={savedIds.includes(candidate.id)} onSave={() => toggleSave(candidate.id)} onOpen={() => setModal({ kind: "profile", candidate })} />)}</div> : <div className="empty-state"><FileSearch size={36} /><h2>{isShortlist && !savedIds.length ? "Start with a promising profile." : "A little room can reveal more talent."}</h2><p>{isShortlist && !savedIds.length ? "Bookmark a profile in Discover talent to keep it here during this demo session." : "Try fewer filters or a broader budget. Your next great conversation may be one adjustment away."}</p>{isShortlist && !savedIds.length ? <Link className="button primary" href="/recruiters" data-testid="link-browse-empty">Discover talent <ArrowRight size={16} /></Link> : <button className="button primary" data-testid="button-reset-empty" onClick={() => setFilters({ ...defaultFilters })}>Reset filters</button>}</div>}
                <div className="results-footer"><ShieldCheck size={15} /><span>These {candidates.length} fictional profiles demonstrate the product. There is no live candidate directory yet.</span></div>
              </section>
            </div>
          </>}
          {location === "/introductions" && <section className="secondary-page"><p className="eyebrow">EVERY CONVERSATION STARTS WITH A YES</p><h1>Introductions, not cold outreach.</h1><p className="page-description">Candidates choose which opportunity is worth a conversation. These requests are simulated and never sent.</p>{requests.length === 0 ? <div className="empty-state"><Handshake size={38} /><h2>A better first conversation.</h2><p>Open a sample profile and try an introduction. Your request will appear here without exposing anyone’s identity.</p><Link className="button primary" href="/recruiters" data-testid="link-browse-introductions">Explore profiles <ArrowRight size={16} /></Link></div> : <div className="intro-list">{requests.map(request => <article className="intro-card" key={request.id} data-testid={`request-${request.candidateId}`}><span className="mini-eyebrow">SIMULATED REQUEST · {request.candidateId}</span><h2>{request.role}</h2><p>{request.company} · {request.salary}</p><blockquote>{request.message}</blockquote><div className="intro-card-footer"><span className={`badge ${request.status === "Withdrawn" ? "neutral" : ""}`}><Clock3 size={13} />{request.status}</span>{request.status !== "Withdrawn" && <button className="text-button" data-testid={`withdraw-${request.candidateId}`} onClick={() => setRequests(previous => previous.map(item => item.id === request.id ? { ...item, status: "Withdrawn" } : item))}>Withdraw request</button>}</div></article>)}</div>}</section>}
          {location === "/privacy" && <PrivacyPage onTrust={() => setModal({ kind: "trust" })} />}
          {location === "/pricing" && <PricingPage onJoin={plan => setModal({ kind: "pilot", plan })} />}
          {location === "/account" && <AccountPage />}
          {!["/recruiters", "/shortlist", "/introductions", "/privacy", "/pricing", "/account"].includes(location) && <section className="empty-state"><h1>Let’s get you back to the right place.</h1><p>This page isn’t part of the workspace. Your demo session is still here.</p><Link href="/recruiters" className="button primary">Discover talent</Link></section>}
        </main>
      </div>
    </div>
    </SidebarProvider>
    {modal?.kind === "profile" && <Dialog title="Meet the experience." onClose={closeDialog} wide><ProfileDetails candidate={modal.candidate} saved={savedIds.includes(modal.candidate.id)} onSave={() => toggleSave(modal.candidate.id)} requested={requests.some(request => request.candidateId === modal.candidate.id && request.status !== "Withdrawn")} onIntro={() => setModal({ kind: "intro", candidate: modal.candidate })} /></Dialog>}
    {modal?.kind === "intro" && <Dialog title="Make a considered introduction." onClose={closeDialog}><IntroForm candidate={modal.candidate} onSubmit={addRequest} /></Dialog>}
    {modal?.kind === "pilot" && <Dialog title={modal.plan === "candidate" ? "Be part of a more private job search." : "Help shape better recruiting."} onClose={closeDialog}><PilotForm plan={modal.plan} /></Dialog>}
    {modal?.kind === "save" && <Dialog title="Keep a good search close." onClose={closeDialog}><form onSubmit={event => { event.preventDefault(); if (!searchName.trim()) return; setSavedSearches(previous => [...previous, { id: crypto.randomUUID(), name: searchName.trim(), filters: structuredClone(filters) }]); setModal(null); setNotice("Search saved for this demo session."); }}><p className="dialog-intro">Save your current filters to return to them in this session. Saved searches reset when you refresh.</p><label className="field-label" htmlFor="search-name">Search name</label><input id="search-name" data-testid="input-search-name" required maxLength={60} value={searchName} onChange={event => setSearchName(event.target.value)} placeholder="e.g. Remote finance, $120k" /><button className="button primary full-width" data-testid="button-confirm-save-search" type="submit">Save search <Bookmark size={16} /></button></form></Dialog>}
    {modal?.kind === "trust" && <Dialog title="Privacy is the product." onClose={closeDialog} wide><TrustContent /></Dialog>}
  </>;
}

function CandidateCard({ candidate, saved, onSave, onOpen }: { candidate: Candidate; saved: boolean; onSave: () => void; onOpen: () => void }) {
  return <article className="candidate-card" data-testid={`candidate-${candidate.id}`}>
    <div className="card-top"><span className="candidate-code"><EyeOff size={13} />{candidate.id}</span><span className="sample-label">SAMPLE</span><button className={`icon-button save-button ${saved ? "saved" : ""}`} aria-label={`${saved ? "Remove" : "Add"} ${candidate.id} ${saved ? "from" : "to"} shortlist`} aria-pressed={saved} data-testid={`save-${candidate.id}`} onClick={onSave}><Bookmark size={19} fill={saved ? "currentColor" : "none"} /></button></div>
    <h3><button className="title-button" data-testid={`title-${candidate.id}`} onClick={onOpen}>{candidate.role}</button></h3>
    <div className="candidate-meta"><span><MapPin size={13} />{candidate.location}</span><span>{candidate.experience} years’ experience</span></div>
    <p className="candidate-description">{candidate.description}</p>
    <div className="skill-tags">{candidate.skills.slice(0, 3).map(skill => <span key={skill}>{skill}</span>)}{candidate.skills.length > 3 && <span className="skill-extra" title={candidate.skills.slice(3).join(", ")}>+{candidate.skills.length - 3}</span>}</div>
    <div className="candidate-pay"><strong>{money(candidate.salaryMin)}–{money(candidate.salaryMax)}</strong><span>/ year, USD</span><span className="arrangement-badge">{candidate.arrangement}</span></div>
    <footer className="card-footer"><span className={`availability ${candidate.availability === "Immediately" ? "available-now" : ""}`}><span className="status-dot" />{candidate.availability === "Immediately" ? "Available now" : candidate.availability === "Within a month" ? "Within a month" : "Open to exploring"}</span><button className="profile-link" data-testid={`view-${candidate.id}`} onClick={onOpen}>View profile <ArrowRight size={15} /></button></footer>
  </article>;
}

function ProfileDetails({ candidate, saved, onSave, onIntro, requested }: { candidate: Candidate; saved: boolean; onSave: () => void; onIntro: () => void; requested: boolean }) {
  return <><div className="detail-eyebrow"><span className="candidate-code"><EyeOff size={14} />{candidate.id}</span><span className="sample-label">SYNTHETIC SAMPLE</span></div><h3 className="profile-title">{candidate.role}</h3><p className="detail-meta">{candidate.location} · {candidate.arrangement} · {candidate.employment}</p><p>{candidate.description}</p><div className="detail-grid"><div><span>Experience</span><strong>{candidate.experience} years</strong></div><div><span>Desired annual pay</span><strong>{money(candidate.salaryMin)}–{money(candidate.salaryMax)}</strong></div><div><span>Availability</span><strong>{candidate.availability}</strong></div></div><h3 className="detail-heading">What they bring</h3><ul className="check-list">{candidate.highlights.map(highlight => <li key={highlight}><Check size={16} />{highlight}</li>)}</ul><h3 className="detail-heading">Skills & experience</h3><div className="skill-tags all-skills">{candidate.skills.map(skill => <span key={skill}>{skill}</span>)}</div><div className="private-fields"><LockKeyhole size={19} /><div><strong>Some things should stay personal.</strong><p>Name, current employer, résumé, and contact details are not part of discovery. An introduction needs the candidate’s specific approval.</p></div></div><div className="dialog-actions"><button className="button secondary" data-testid="button-profile-shortlist" aria-pressed={saved} onClick={onSave}><Bookmark size={16} fill={saved ? "currentColor" : "none"} />{saved ? "Shortlisted" : "Add to shortlist"}</button><button className="button primary" data-testid="button-introduce" disabled={requested} onClick={onIntro}>{requested ? "Demo request pending" : "Try an introduction"}<ArrowRight size={16} /></button></div><p className="fine-print">Demo only. No messages are sent, and there is no identity to unlock.</p></>;
}

function IntroForm({ candidate, onSubmit }: { candidate: Candidate; onSubmit: (request: Omit<IntroRequest, "id" | "status">) => void }) {
  const { register, handleSubmit, formState: { errors } } = useForm({ defaultValues: { role: candidate.role, company: "Harbor Labs (demo)", salary: `${money(candidate.salaryMin)}–${money(candidate.salaryMax)} USD`, message: "" } });
  return <form onSubmit={handleSubmit(values => onSubmit({ ...values, candidateId: candidate.id }))}><p className="dialog-intro">An opportunity for <strong>{candidate.id}</strong>. Give the candidate enough information to make a real choice.</p><label className="field-label" htmlFor="intro-role">Role title</label><input id="intro-role" data-testid="input-intro-role" {...register("role", { required: true, maxLength: 120 })} /><label className="field-label" htmlFor="intro-company">Named hiring company</label><input id="intro-company" data-testid="input-intro-company" {...register("company", { required: true, maxLength: 120 })} /><label className="field-label" htmlFor="intro-salary">Compensation range</label><input id="intro-salary" data-testid="input-intro-salary" {...register("salary", { required: true, maxLength: 100 })} /><label className="field-label" htmlFor="intro-message">Why this could be a fit</label><textarea id="intro-message" data-testid="input-intro-message" rows={4} placeholder="Share the opportunity, work arrangement, and why their experience stood out." {...register("message", { required: "Add a short, specific message.", minLength: { value: 20, message: "Use at least 20 characters." }, maxLength: 1500 })} />{Object.keys(errors).length > 0 && <p className="field-error" role="alert">Complete every field and include a message of at least 20 characters.</p>}<div className="inline-disclosure"><EyeOff size={17} /><span>This is a simulation. Nothing will be sent or saved after refresh.</span></div><button className="button primary full-width" data-testid="button-submit-intro" type="submit">Create demo introduction <ArrowRight size={16} /></button></form>;
}

export function PilotForm({ plan }: { plan: "candidate" | "founding" | "team" }) {
  const [success, setSuccess] = useState(false);
  const status = useQuery<{ intakeReady: boolean }>({ queryKey: ["/api/status"], queryFn: async () => (await apiRequest("GET", "/api/status")).json() });
  const form = useForm<InsertPilotLead>({ resolver: zodResolver(insertPilotLeadSchema) as never, defaultValues: { name: "", email: "", organization: "", audience: plan === "candidate" ? "candidate" : "recruiter", plan, consent: false as unknown as true, website: "" } });
  const mutation = useMutation({ mutationFn: async (values: InsertPilotLead) => (await apiRequest("POST", "/api/pilot", values)).json(), onSuccess: () => setSuccess(true) });
  if (success) return <div className="pilot-success" role="status"><Check size={32} /><h3>You’re on the pilot list.</h3><p>Your interest was recorded. No payment was collected and no account has been created.</p><p className="fine-print">We’ll only use the submitted information to contact you about the pilot.</p></div>;
  return <form onSubmit={form.handleSubmit(values => mutation.mutate(values))}><p className="dialog-intro">Start with a conversation, not a checkout. {plan === "candidate" ? "Candidate privacy controls stay free." : "Pilot pricing is shared during onboarding. It is a proposed pilot price, not an active subscription."}</p><div className="form-row"><div><label className="field-label" htmlFor="pilot-name">Your name</label><input id="pilot-name" data-testid="input-pilot-name" autoComplete="name" {...form.register("name")} /></div><div><label className="field-label" htmlFor="pilot-email">Email</label><input id="pilot-email" type="email" data-testid="input-pilot-email" autoComplete="email" {...form.register("email")} /></div></div><label className="field-label" htmlFor="pilot-organization">{plan === "candidate" ? "Field or role of interest" : "Company or agency"}</label><input id="pilot-organization" data-testid="input-pilot-company" autoComplete="organization" {...form.register("organization")} /><div className="honeypot" aria-hidden="true"><label>Website<input tabIndex={-1} autoComplete="off" {...form.register("website")} /></label></div><label className="check-row consent"><input type="checkbox" data-testid="input-pilot-consent" {...form.register("consent")} /><span>I agree to be contacted about this pilot. I won’t submit confidential employer or candidate information.</span></label>{Object.keys(form.formState.errors).length > 0 && <p className="field-error" role="alert">Enter your name, a valid email, your company or field, and agree to pilot contact.</p>}{mutation.error && <p className="field-error" role="alert" data-testid="status-pilot-error">{mutation.error.message}</p>}{status.isPending ? <p className="fine-print">Checking pilot signup availability…</p> : !status.data?.intakeReady && <div className="setup-notice" data-testid="status-intake-unavailable"><LockKeyhole size={17} /><p>Pilot signup is not connected to storage yet. This form cannot collect your details until setup is complete. Nothing has been submitted.</p></div>}<button className="button primary full-width" data-testid="button-submit-pilot" type="submit" disabled={mutation.isPending || !status.data?.intakeReady}>{mutation.isPending ? "Submitting…" : !status.data?.intakeReady ? "Pilot signup opens after setup" : "Request pilot access"}<ArrowRight size={16} /></button><p className="fine-print">No card required. No automatic billing. No candidate directory access.</p></form>;
}

function PrivacyPage({ onTrust }: { onTrust: () => void }) {
  const [active, setActive] = useState(true);
  const [mode, setMode] = useState<"selected" | "verified">("selected");
  const [allowed, setAllowed] = useState(["company-a"]);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [company, setCompany] = useState("company-a");
  const organizations = [{ id: "company-a", name: "Harbor Labs" }, { id: "company-b", name: "Ridge Studio" }, { id: "employer-x", name: "Current employer" }];
  const context = structuredClone(baseContext);
  context.candidate.policy.active = active;
  context.candidate.policy.mode = mode;
  context.memberships[0]!.company_id = company;
  context.opportunity.hiring_company_id = company;
  context.candidate.rules = [
    ...allowed.map(id => ({ candidate_id: "candidate-1", company_id: id, effect: "allow", scope: { kind: "company" } })),
    ...blocked.map(id => ({ candidate_id: "candidate-1", company_id: id, effect: "block", scope: { kind: "company" } })),
  ];
  const decision = evaluate(context);
  const reason = !active ? "Search is paused for everyone." : company === "employer-x" ? "Your current employer is always excluded." : blocked.includes(company) ? "A company block overrides every allow." : decision.allowed ? "This company passes your discovery rules. Your identity is still private." : "This company is not on your selected-company list.";
  return <section className="secondary-page privacy-page"><p className="eyebrow">CONTROL IS NOT A PREMIUM FEATURE</p><h1>Your next move. Your rules.</h1><p className="page-description">Try the candidate’s side of the connection. These controls run the reference rule engine with fictional companies; they do not change a real account.</p><div className="privacy-layout"><div className="settings-panel"><div className="setting-heading"><div><h2>Discovery status</h2><p>Pause means nobody can discover you.</p></div><button role="switch" aria-checked={active} aria-label="Activate candidate discovery" className={`switch ${active ? "on" : ""}`} data-testid="switch-discovery" onClick={() => setActive(!active)}><span /></button></div><fieldset><legend>Who can discover your anonymous profile?</legend><label className="radio-row"><input type="radio" name="mode" value="selected" checked={mode === "selected"} data-testid="privacy-selected" onChange={() => setMode("selected")} /><span><strong>Only companies I select</strong><small>Start invisible, then choose who gets a first look.</small></span></label><label className="radio-row"><input type="radio" name="mode" value="verified" checked={mode === "verified"} data-testid="privacy-verified" onChange={() => setMode("verified")} /><span><strong>Verified recruiters, except my exclusions</strong><small>Broader discovery. Blocks and employer exclusions still win.</small></span></label></fieldset><h2 className="detail-heading">Company permissions</h2><p className="filter-help">A block always wins if the same company is also selected.</p><div className="permission-table"><div className="permission-header"><span>Fictional organization</span><span>Allow</span><span>Block</span></div>{organizations.map(org => <div className="permission-row" key={org.id}><span>{org.name}{org.id === "employer-x" && <small>Automatic exclusion</small>}</span><label><span className="sr-only">Allow {org.name}</span><input data-testid={`allow-${org.id}`} type="checkbox" checked={allowed.includes(org.id)} onChange={() => setAllowed(previous => previous.includes(org.id) ? previous.filter(id => id !== org.id) : [...previous, org.id])} /></label><label><span className="sr-only">Block {org.name}</span><input data-testid={`block-${org.id}`} type="checkbox" checked={blocked.includes(org.id)} onChange={() => setBlocked(previous => previous.includes(org.id) ? previous.filter(id => id !== org.id) : [...previous, org.id])} /></label></div>)}</div><div className="inline-disclosure"><ShieldCheck size={18} /><span>Current employers and reviewed affiliates are excluded in the reference contract. Agency opportunities also need a verified named-client mandate.</span></div></div><aside className="visibility-preview"><p className="eyebrow">SEE IT FROM THE OTHER SIDE</p><h2>Who gets a first look?</h2><label className="field-label" htmlFor="preview-company">Simulate a recruiter from</label><select id="preview-company" data-testid="select-privacy-company" value={company} onChange={event => setCompany(event.target.value)}>{organizations.map(org => <option key={org.id} value={org.id}>{org.name}</option>)}</select><div className={`visibility-result ${decision.allowed ? "can-see" : ""}`} data-testid="status-visibility"><div>{decision.allowed ? <ShieldCheck size={28} /> : <EyeOff size={28} />}</div><h3>{decision.allowed ? "Anonymous profile visible" : "Not discoverable"}</h3><p>{reason}</p></div><div className="identity-lock"><LockKeyhole size={17} /><div><strong>Identity stays locked</strong><p>Discovery is not permission to see your name, contact details, or current employer.</p></div></div><p className="fine-print">Simulation only. Production authentication, verified company data, database policies, and identity approvals must be connected before real use.</p><button className="text-button" onClick={onTrust} data-testid="button-privacy-details">Understand the privacy model <ArrowRight size={14} /></button></aside></div></section>;
}

function PricingPage({ onJoin }: { onJoin: (plan: "candidate" | "founding" | "team") => void }) {
  return <section className="secondary-page pricing-page"><p className="eyebrow">A BUSINESS MODEL BUILT ON BETTER CONNECTIONS</p><h1>Recruiters pay. Privacy doesn’t.</h1><p className="page-description">A proposed pilot, not a paywall on someone’s next move. Help us validate the product before subscriptions launch.</p><div className="pricing-layout"><article className="founding-plan"><span className="badge neutral">PROPOSED FOUNDING PILOT</span><h2>For thoughtful recruiters.</h2><div className="price"><strong>$49</strong><span>/ recruiter / month</span></div><p>Start with one recruiter seat. A proposed pilot price to test with real customers, not an active subscription.</p><ul className="check-list"><li><Check size={17} />Focused, job-related search filters</li><li><Check size={17} />Anonymous shortlists and saved searches</li><li><Check size={17} />Candidate-approved introduction requests</li><li><Check size={17} />Named-company recruiting, not blind outreach</li></ul><button className="button primary full-width" data-testid="button-founding-pilot" onClick={() => onJoin("founding")}>Request founding access <ArrowRight size={16} /></button><p className="fine-print">No checkout yet. Availability depends on verification, candidate supply, and onboarding.</p></article><div className="other-plans"><article><div><p className="eyebrow">FOR CANDIDATES</p><h2>Your privacy is not for sale.</h2><p>Proposed free access to company blocks, selected-company visibility, search pause, and control over introductions.</p></div><button className="button secondary" data-testid="button-candidate-pilot" onClick={() => onJoin("candidate")}>Join as a candidate <ArrowRight size={15} /></button></article><article><div><p className="eyebrow">FOR SMALL TEAMS</p><h2>A shared, considered approach.</h2><p>Proposed $129/month for three recruiter seats. Shared shortlists, clear company context, and a small-team onboarding pilot.</p></div><button className="button secondary" data-testid="button-team-pilot" onClick={() => onJoin("team")}>Discuss a team pilot <ArrowRight size={15} /></button></article></div></div><section className="commercial-boundary"><h2>Earn the right to charge.</h2><p>First, prove useful mutual introductions in a focused hiring market. Real accounts, recruiter verification, durable permissions, legal terms, and billing must be in place before a paid launch.</p><p>This preview contains no live candidates, paid subscriptions, or automated charges.</p></section></section>;
}

function TrustContent() {
  return <div className="trust-content"><p className="dialog-intro">A first look at someone’s experience should not expose their job search. The product is being built around explicit company scope and mutual consent.</p><ol className="trust-steps"><li><span>01</span><div><h3>Candidates choose their audience.</h3><p>Start with selected companies. Company blocks, current-employer exclusions, and pause take precedence.</p></div></li><li><span>02</span><div><h3>Recruiters see experience first.</h3><p>Anonymous summaries show job-relevant information. Names, current employers, and contact details are not included.</p></div></li><li><span>03</span><div><h3>An introduction needs a separate yes.</h3><p>A named company and a specific opportunity. Discovery never automatically releases an identity.</p></div></li></ol><div className="setup-notice"><LockKeyhole size={20} /><div><strong>Where this preview stops</strong><p>All profiles and organizations here are fictional. Saved items and requests last only for this session. Production accounts, verification, durable permissions, identity release, and payments are not connected. No platform can promise that a person will never be inferred from their profile.</p></div></div></div>;
}

export default App;
