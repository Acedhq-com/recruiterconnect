import { useState } from "react";
import type { FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Building2, Check, EyeOff, LockKeyhole, Plus, Search, ShieldCheck, X } from "lucide-react";
import {
  MAX_CLIENTS, addClientSchema, saveRecruiterFirmSchema, searchRequestSchema,
} from "../../shared/account-schema.js";
import type {
  PrivateAccount, PublicAccountSession, RecruiterRecord, RecruiterStatus, SaveRecruiterFirm, SearchCard, SearchRequest,
} from "../../shared/account-schema.js";
import { apiRequest } from "./lib/queryClient.js";

const post = async <T,>(path: string, input: unknown, owner: string): Promise<T> =>
  (await apiRequest("POST", path, input, { "X-Account-Id": owner })).json();

const STATUS: Record<RecruiterStatus | "none", { label: string; text: string }> = {
  none: { label: "Not submitted", text: "Tell us who you recruit for. We check every recruiter by hand before they can see anyone." },
  draft: { label: "Not submitted", text: "Add a link that shows you work at this firm and the companies you recruit for, then submit for review." },
  pending: { label: "Waiting for review", text: "We are checking your details. You cannot search until you are verified. Editing anything below withdraws this submission." },
  verified: { label: "Verified", text: "You can search anonymous candidate profiles. Editing your firm or hires-for list withdraws verification until we re-check it." },
  rejected: { label: "Not approved", text: "This application was not approved. Update your details, then submit again." },
  suspended: { label: "Paused", text: "This recruiter profile is paused. Contact the operator." },
};

type SearchPage = { results: SearchCard[]; nextOffset: number | null };

type Props = { account: PrivateAccount; recruiter: RecruiterRecord | null; onSaved: (value: PublicAccountSession) => void };

export default function RecruiterWorkspace({ account, recruiter, onSaved }: Props) {
  const owner = account.user_id;
  const status = recruiter?.status ?? "none";
  const locked = status === "suspended";
  const [firm, setFirm] = useState(recruiter?.firm_name ?? "");
  const [link, setLink] = useState(recruiter?.proof_url ?? "");
  const [company, setCompany] = useState("");
  const [firmError, setFirmError] = useState("");
  const [companyError, setCompanyError] = useState("");
  const [savedFirm, setSavedFirm] = useState(false);
  const saveFirm = useMutation({
    mutationFn: (input: SaveRecruiterFirm) => post<PublicAccountSession>("/api/account/recruiter", input, owner),
    onSuccess: value => { onSaved(value); setSavedFirm(true); },
  });
  const addClient = useMutation({
    mutationFn: (value: string) => post<PublicAccountSession>("/api/account/recruiter/clients", { company: value }, owner),
    onSuccess: value => { onSaved(value); setCompany(""); },
  });
  const removeClient = useMutation({
    mutationFn: (id: string) => post<PublicAccountSession>("/api/account/recruiter/clients/remove", { id }, owner),
    onSuccess: onSaved,
  });
  const submit = useMutation({
    mutationFn: () => post<PublicAccountSession>("/api/account/recruiter/submit", {}, owner),
    onSuccess: onSaved,
  });
  const busy = saveFirm.isPending || addClient.isPending || removeClient.isPending || submit.isPending;
  const clients = recruiter?.clients ?? [];
  const full = clients.length >= MAX_CLIENTS;
  const canSubmit = status === "draft" && !!recruiter?.proof_url && clients.length > 0;

  function submitFirm(event: FormEvent) {
    event.preventDefault();
    setSavedFirm(false);
    const parsed = saveRecruiterFirmSchema.safeParse({ firm, proofUrl: link });
    if (!parsed.success) { setFirmError("Enter your firm (2 to 150 characters) and, if you add a link, a full https:// address."); return; }
    setFirmError("");
    saveFirm.mutate(parsed.data);
  }
  function submitClient(event: FormEvent) {
    event.preventDefault();
    const parsed = addClientSchema.safeParse({ company });
    if (!parsed.success) { setCompanyError("Enter a company name (2 to 150 characters)."); return; }
    setCompanyError("");
    addClient.mutate(parsed.data.company);
  }

  return <div className="privacy-stack">
    <section className="settings-panel account-card privacy-panel" aria-labelledby="recruiter-title" data-testid="recruiter-setup">
      <div className="account-card-title"><div>
        <h2 id="recruiter-title">Your recruiter profile</h2>
        <p>Every recruiter is checked by hand before seeing any candidate.</p>
      </div><span className={`badge ${status === "verified" ? "" : "neutral"}`} data-testid="recruiter-status">
        {status === "verified" ? <ShieldCheck size={13} /> : <LockKeyhole size={13} />}{STATUS[status].label}</span></div>
      <div className="privacy-note" role="note" data-testid="recruiter-status-text">
        <ShieldCheck size={18} aria-hidden="true" /><p>{STATUS[status].text}</p></div>

      <form onSubmit={submitFirm} noValidate>
        <label className="field-label" htmlFor="recruiter-firm">Your firm</label>
        <input id="recruiter-firm" data-testid="recruiter-firm-input" autoComplete="organization" maxLength={150}
          value={firm} onChange={event => { setFirm(event.target.value); setSavedFirm(false); }} disabled={locked}
          placeholder="e.g. Zenith Search Partners" />
        <label className="field-label" htmlFor="recruiter-link">A link that shows you work there</label>
        <input id="recruiter-link" data-testid="recruiter-link-input" inputMode="url" autoComplete="off" maxLength={300}
          value={link} onChange={event => { setLink(event.target.value); setSavedFirm(false); }} disabled={locked}
          placeholder="https://… your profile on your firm's site or LinkedIn" />
        <p className="fine-print">Only the operator opens this link, to check your details. It is never shown to candidates.</p>
        {firmError && <p className="field-error" role="alert">{firmError}</p>}
        {saveFirm.error && <p className="field-error" role="alert">{saveFirm.error.message}</p>}
        <button type="submit" className="button secondary" data-testid="recruiter-firm-save" disabled={busy || locked}>
          {saveFirm.isPending ? "Saving…" : recruiter ? "Save firm details" : "Save and continue"}</button>
        {savedFirm && !saveFirm.isPending && !saveFirm.error && <p className="account-save-status" role="status"><Check size={16} />Saved.</p>}
      </form>

      {recruiter && <div className="privacy-blocks">
        <div className="privacy-blocks-head"><h3>Companies you recruit for</h3>
          <span className="privacy-count" data-testid="recruiter-client-count">{clients.length} of {MAX_CLIENTS}</span></div>
        <p className="fine-print">List every company you hire for, including your own firm if you hire for it. A candidate who blocked any company on this list never appears in your results. A complete list is a condition of verification.</p>
        {clients.length === 0
          ? <p className="fine-print" data-testid="recruiter-clients-empty">Nobody listed yet. You cannot search with an empty list.</p>
          : <ul className="privacy-list" aria-label="Companies you recruit for">
            {clients.map(client => <li key={client.id} data-testid={`recruiter-client-${client.id}`}>
              <Building2 size={16} aria-hidden="true" /><span className="privacy-name">{client.company_name}</span>
              <button type="button" className="text-button" disabled={busy || locked} data-testid={`recruiter-client-remove-${client.id}`}
                aria-label={`Remove ${client.company_name}`} onClick={() => removeClient.mutate(client.id)}><X size={14} />Remove</button>
            </li>)}
          </ul>}
        {removeClient.error && <p className="field-error" role="alert">{removeClient.error.message}</p>}
        <form onSubmit={submitClient} noValidate>
          <label className="field-label" htmlFor="recruiter-company">Add a company</label>
          <div className="privacy-row">
            <input id="recruiter-company" data-testid="recruiter-client-input" autoComplete="off" maxLength={150} value={company}
              onChange={event => setCompany(event.target.value)} disabled={full || locked} placeholder="A client or employer you hire for" />
            <button type="submit" className="button secondary" data-testid="recruiter-client-add" disabled={busy || full || locked}>
              <Plus size={15} />{addClient.isPending ? "Adding…" : "Add"}</button>
          </div>
          {companyError && <p className="field-error" role="alert">{companyError}</p>}
          {addClient.error && <p className="field-error" role="alert">{addClient.error.message}</p>}
        </form>
      </div>}

      {(status === "draft" || status === "rejected") && recruiter && <div className="privacy-blocks">
        <h3>Submit for review</h3>
        <p className="fine-print">{status === "rejected" ? "Change your details above first, then submit again." : canSubmit ? "Everything needed is in place." : "Add a link and at least one company first."}</p>
        {submit.error && <p className="field-error" role="alert">{submit.error.message}</p>}
        <button type="button" className="button primary full-width" data-testid="recruiter-submit" disabled={!canSubmit || busy}
          onClick={() => submit.mutate()}>{submit.isPending ? "Submitting…" : "Submit for review"}</button>
      </div>}
    </section>

    {status === "verified" && <SearchPanel owner={owner} />}
  </div>;
}

function SearchPanel({ owner }: { owner: string }) {
  const [query, setQuery] = useState("");
  const [preference, setPreference] = useState<"" | "Remote" | "Hybrid" | "On-site">("");
  const [cards, setCards] = useState<SearchCard[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [lastSearch, setLastSearch] = useState<SearchRequest>({});
  const [inputError, setInputError] = useState("");
  const run = useMutation({
    mutationFn: (input: SearchRequest) => post<SearchPage>("/api/recruiter/search", input, owner),
    onSuccess: (page, input) => {
      setCards(previous => (input.offset ? [...(previous ?? []), ...page.results] : page.results));
      setNext(page.nextOffset);
      setLastSearch(input);
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = searchRequestSchema.safeParse({ ...(query.trim() ? { query } : {}), ...(preference ? { workPreference: preference } : {}) });
    if (!parsed.success) { setInputError("Use up to 80 characters for the search words."); return; }
    setInputError("");
    run.mutate(parsed.data);
  }
  return <section className="settings-panel account-card privacy-panel" aria-labelledby="search-title" data-testid="recruiter-search">
    <div className="account-card-title"><div>
      <h2 id="search-title">Find candidates</h2>
      <p>Real, anonymous profiles from people who chose to be found. Each search is counted; the limit is 60 an hour.</p>
    </div><span className="badge"><EyeOff size={13} />Anonymous</span></div>
    <form onSubmit={submit} noValidate>
      <div className="privacy-row search-row">
        <input aria-label="Search words" data-testid="search-query" maxLength={80} value={query} onChange={event => setQuery(event.target.value)}
          placeholder="e.g. US GAAP, internal audit" />
        <select aria-label="Work preference" data-testid="search-preference" value={preference}
          onChange={event => setPreference(event.target.value as typeof preference)}>
          <option value="">Any arrangement</option><option>Remote</option><option>Hybrid</option><option>On-site</option></select>
        <button type="submit" className="button primary" data-testid="search-run" disabled={run.isPending}>
          <Search size={15} />{run.isPending ? "Searching…" : "Search"}</button>
      </div>
      {inputError && <p className="field-error" role="alert">{inputError}</p>}
      {run.error && <p className="field-error" role="alert" data-testid="search-error">{run.error.message}</p>}
    </form>
    {cards && (cards.length === 0
      ? <div className="privacy-note" role="status" data-testid="search-empty"><EyeOff size={18} aria-hidden="true" />
        <p>No matching profiles right now. Candidates appear only after they opt in and we approve them, and anyone who blocked a company on your list is never shown.</p></div>
      : <ul className="result-list" aria-label="Candidate results" data-testid="search-results">
        {cards.map(card => <li key={card.handle} className="privacy-card" data-testid={`search-card-${card.handle}`}>
          <span className="fine-print">{card.handle}</span>
          <strong>{card.headline}</strong>
          <span>{card.work_preference}</span>
          {card.skills.length > 0 && <ul aria-label="Skills">{card.skills.map(skill => <li key={skill}>{skill}</li>)}</ul>}
        </li>)}
      </ul>)}
    {next !== null && <button type="button" className="button secondary full-width" data-testid="search-more" disabled={run.isPending}
      onClick={() => run.mutate({ ...lastSearch, offset: next })}>Show more</button>}
    <p className="fine-print privacy-limits"><strong>What you see and do not.</strong> Names, employers and contact details are never shown. You cannot contact anyone yet; introductions, which candidates approve one at a time, are not available. Do not try to work out who someone is.</p>
  </section>;
}
