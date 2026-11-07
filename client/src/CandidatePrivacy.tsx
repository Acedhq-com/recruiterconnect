import { useState } from "react";
import type { FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Building2, Check, Eye, LockKeyhole, Plus, X } from "lucide-react";
import { MAX_BLOCKS, addBlockSchema, saveEmployerSchema } from "../../shared/account-schema.js";
import type { DiscoveryStatus, PrivateAccount, PublicAccountSession, CandidatePrivacy } from "../../shared/account-schema.js";
import { apiRequest } from "./lib/queryClient.js";

const post = async (path: string, input: unknown, owner: string): Promise<PublicAccountSession> =>
  (await apiRequest("POST", path, input, { "X-Account-Id": owner })).json();

type Props = {
  account: PrivateAccount; privacy: CandidatePrivacy; discovery: DiscoveryStatus | null;
  onSaved: (value: PublicAccountSession) => void;
};

export default function CandidatePrivacyPanel({ account, privacy, discovery, onSaved }: Props) {
  const owner = account.user_id;
  const [employer, setEmployer] = useState(privacy.current_employer ?? "");
  const [company, setCompany] = useState("");
  const [employerError, setEmployerError] = useState("");
  const [companyError, setCompanyError] = useState("");
  const [savedEmployer, setSavedEmployer] = useState(false);
  const saveEmployer = useMutation({
    mutationFn: (value: string) => post("/api/account/employer", { employer: value }, owner),
    onSuccess: value => { onSaved(value); setSavedEmployer(true); },
  });
  const addBlock = useMutation({
    mutationFn: (value: string) => post("/api/account/blocks", { company: value }, owner),
    onSuccess: value => { onSaved(value); setCompany(""); },
  });
  const removeBlock = useMutation({
    mutationFn: (id: string) => post("/api/account/blocks/remove", { id }, owner),
    onSuccess: onSaved,
  });
  const full = privacy.blocks.length >= MAX_BLOCKS;
  const busy = saveEmployer.isPending || addBlock.isPending || removeBlock.isPending;

  function submitEmployer(event: FormEvent) {
    event.preventDefault();
    setSavedEmployer(false);
    const parsed = saveEmployerSchema.safeParse({ employer });
    if (!parsed.success) { setEmployerError("Enter your current employer (2 to 150 characters)."); return; }
    setEmployerError("");
    saveEmployer.mutate(parsed.data.employer);
  }
  function submitBlock(event: FormEvent) {
    event.preventDefault();
    const parsed = addBlockSchema.safeParse({ company });
    if (!parsed.success) { setCompanyError("Enter a company name (2 to 150 characters)."); return; }
    setCompanyError("");
    addBlock.mutate(parsed.data.company);
  }

  return <section className="settings-panel account-card privacy-panel" aria-labelledby="privacy-title" data-testid="candidate-privacy">
    <div className="account-card-title"><div>
      <h2 id="privacy-title">Companies that must never see you</h2>
      <p>Your current employer and any other companies you list. Stored privately and never shown to anyone else.</p>
    </div><span className="badge"><LockKeyhole size={13} />Private</span></div>

    <div className="privacy-note" role="note" data-testid="privacy-not-live">
      <Eye size={18} aria-hidden="true" />
      <p>{discovery?.enabled
        ? "These blocks apply to every search. A recruiter whose firm or hiring clients match anything here never sees you."
        : "Nobody can find you unless you choose to be found, further down. Set this up first: when you do turn discoverability on, these blocks apply to every search."}</p>
    </div>

    <form onSubmit={submitEmployer} noValidate aria-describedby="privacy-employer-help">
      <label className="field-label" htmlFor="privacy-employer">Your current employer</label>
      <div className="privacy-row">
        <input id="privacy-employer" data-testid="privacy-employer-input" autoComplete="off" maxLength={150}
          value={employer} onChange={event => { setEmployer(event.target.value); setSavedEmployer(false); }}
          aria-invalid={!!employerError} placeholder="e.g. Smith & Jones LLP" />
        <button type="submit" className="button secondary" data-testid="privacy-employer-save" disabled={busy}>
          {saveEmployer.isPending ? "Saving…" : privacy.current_employer ? "Change employer" : "Save employer"}</button>
      </div>
      <p className="fine-print" id="privacy-employer-help">Private. It is added to your block list automatically and cannot be removed while it is your current employer. If you change jobs, your old employer stays blocked until you remove it.</p>
      {employerError && <p className="field-error" role="alert">{employerError}</p>}
      {saveEmployer.error && <p className="field-error" role="alert">{saveEmployer.error.message}</p>}
      {savedEmployer && !saveEmployer.isPending && !saveEmployer.error && <p className="account-save-status" role="status"><Check size={16} />Employer saved and blocked.</p>}
    </form>

    <div className="privacy-blocks">
      <div className="privacy-blocks-head"><h3>Blocked companies</h3>
        <span className="privacy-count" data-testid="privacy-count">{privacy.blocks.length} of {MAX_BLOCKS}</span></div>
      {privacy.blocks.length === 0
        ? <p className="fine-print" data-testid="privacy-empty">Nothing blocked yet. Start by saving your current employer above.</p>
        : <ul className="privacy-list" aria-label="Blocked companies">
          {privacy.blocks.map(block => <li key={block.id} data-testid={`privacy-block-${block.id}`}>
            <Building2 size={16} aria-hidden="true" />
            <span className="privacy-name">{block.company_name}</span>
            {block.source === "current_employer"
              ? <span className="badge neutral">Current employer</span>
              : <button type="button" className="text-button" data-testid={`privacy-remove-${block.id}`} disabled={busy}
                aria-label={`Remove ${block.company_name} from your block list`} onClick={() => removeBlock.mutate(block.id)}>
                <X size={14} />Remove</button>}
          </li>)}
        </ul>}
      {removeBlock.error && <p className="field-error" role="alert">{removeBlock.error.message}</p>}

      <form onSubmit={submitBlock} noValidate>
        <label className="field-label" htmlFor="privacy-company">Block another company</label>
        <div className="privacy-row">
          <input id="privacy-company" data-testid="privacy-block-input" autoComplete="off" maxLength={150}
            value={company} onChange={event => setCompany(event.target.value)} disabled={full}
            aria-invalid={!!companyError} placeholder="Past employer, client, competitor or parent firm" />
          <button type="submit" className="button secondary" data-testid="privacy-block-add" disabled={busy || full}>
            <Plus size={15} />{addBlock.isPending ? "Adding…" : "Block"}</button>
        </div>
        {full && <p className="fine-print">Your list is full. Remove a company to add another.</p>}
        {companyError && <p className="field-error" role="alert">{companyError}</p>}
        {addBlock.error && <p className="field-error" role="alert">{addBlock.error.message}</p>}
      </form>
    </div>

    <p className="fine-print privacy-limits"><strong>What this can and cannot do.</strong> It controls what Find Work Privately shows. It cannot stop a recruiter or coworker finding you on other sites. Companies are matched by name, so list a parent firm or affiliate under the names people use for it.</p>
  </section>;
}
