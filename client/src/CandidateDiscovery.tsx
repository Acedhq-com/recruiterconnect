import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, Eye, EyeOff, LockKeyhole, ShieldCheck } from "lucide-react";
import { DISCOVERY_CONSENT_VERSION } from "../../shared/account-schema.js";
import type {
  DiscoveryBlocker, DiscoveryStatus, PrivateAccount, PrivateProfile, PublicAccountSession,
} from "../../shared/account-schema.js";
import { apiRequest } from "./lib/queryClient.js";

const post = async (input: unknown, owner: string): Promise<PublicAccountSession> =>
  (await apiRequest("POST", "/api/account/discovery", input, { "X-Account-Id": owner })).json();

// What the candidate can fix themselves, in plain words.
const FIXES: Partial<Record<DiscoveryBlocker, string>> = {
  profile_incomplete: "Add a headline in your private draft above and save it.",
  employer_missing: "Save your current employer in the section above. It is how we keep your own firm from seeing you.",
  mentions_blocked_company: "Your headline or skills name a company on your block list. Edit the draft so it does not, then save it.",
};

export function discoveryLabel(discovery: DiscoveryStatus | null): string {
  if (!discovery || !discovery.enabled) return "Not discoverable";
  if (discovery.visible) return "Visible to verified recruiters";
  if (discovery.blockers.includes("awaiting_review")) return "Waiting for review";
  return "Not visible";
}

type Props = {
  account: PrivateAccount; profile: PrivateProfile; discovery: DiscoveryStatus;
  onSaved: (value: PublicAccountSession) => void;
};

export default function CandidateDiscoveryPanel({ account, profile, discovery, onSaved }: Props) {
  const [understood, setUnderstood] = useState(false);
  const enable = useMutation({
    mutationFn: () => post({ enabled: true, consentVersion: DISCOVERY_CONSENT_VERSION }, account.user_id),
    onSuccess: value => { setUnderstood(false); onSaved(value); },
  });
  const disable = useMutation({
    mutationFn: () => post({ enabled: false }, account.user_id),
    onSuccess: onSaved,
  });
  const busy = enable.isPending || disable.isPending;
  const fixes = discovery.blockers.filter(item => FIXES[item]);
  const needsConsent = !discovery.enabled || discovery.blockers.includes("consent_outdated");
  const review = discovery.blockers.find(item => item === "awaiting_review" || item === "review_rejected" || item === "review_suspended");

  return <section className="settings-panel account-card privacy-panel" aria-labelledby="discovery-title" data-testid="candidate-discovery">
    <div className="account-card-title"><div>
      <h2 id="discovery-title">Let verified recruiters find you</h2>
      <p>{discovery.enabled ? "You have opted in. You can turn it off at any time and disappear from search at once."
        : "Optional, and off until you turn it on. You can turn it off at any time and disappear from search at once."}</p>
    </div><span className={`badge ${discovery.visible ? "" : "neutral"}`} data-testid="discovery-status">
      {discovery.visible ? <Eye size={13} /> : <EyeOff size={13} />}{discoveryLabel(discovery)}</span></div>

    <div className="privacy-card" data-testid="discovery-card">
      <span className="fine-print">{discovery.visible ? "This is exactly what verified recruiters see." : "This is exactly what a verified recruiter would see."}</span>
      {discovery.handle && <span data-testid="discovery-handle">{discovery.handle}</span>}
      <strong>{profile.headline || "Add a headline in your private draft"}</strong>
      <span>{profile.work_preference}</span>
      {profile.skills.length > 0 && <ul aria-label="Skills">{profile.skills.map(skill => <li key={skill}>{skill}</li>)}</ul>}
    </div>
    <p className="fine-print"><strong>Never shown:</strong> your name, email, current employer, or block list. Check that your headline and skills do not identify you or your employer.</p>

    {fixes.length > 0 && <div className="privacy-note" role="note" data-testid="discovery-fixes">
      <LockKeyhole size={18} aria-hidden="true" />
      <div>{fixes.map(item => <p key={item}>{FIXES[item]}</p>)}</div>
    </div>}

    {discovery.enabled && review === "awaiting_review" && <div className="privacy-note" role="status" data-testid="discovery-waiting">
      <ShieldCheck size={18} aria-hidden="true" />
      <p>You are not visible to anyone yet. We check each profile by hand before it can appear. Nothing about you is shared in the meantime.</p>
    </div>}
    {discovery.enabled && (review === "review_rejected" || review === "review_suspended") && <div className="privacy-note" role="status" data-testid="discovery-held">
      <ShieldCheck size={18} aria-hidden="true" />
      <p>This profile is not visible to recruiters. You are not shown to anyone. Turn discoverability off, or contact the operator if you think this is a mistake.</p>
    </div>}
    {discovery.visible && <div className="privacy-note" role="status" data-testid="discovery-live">
      <Eye size={18} aria-hidden="true" />
      <p>You are in search for verified recruiters whose firm and hiring clients are not on your block list. They can see the card above and nothing else. They cannot contact you yet.</p>
    </div>}

    {needsConsent && fixes.length === 0 && <form className="consent-form" onSubmit={event => { event.preventDefault(); if (understood) enable.mutate(); }}>
      <h3>What you are agreeing to</h3>
      <ul className="consent-list">
        <li>Recruiters we have verified can find you in search and see the card above, with a random ID instead of your name.</li>
        <li>A recruiter whose firm or hiring clients match anything on your block list never sees you. Matching is by name, so list parent firms, affiliates and clients the way people write them.</li>
        <li>Recruiters cannot message you or learn who you are. Introductions, which will need your approval every time, are not available yet. You will be asked again before that exists.</li>
        <li>We review each profile by hand before it appears.</li>
        <li>This only controls what Find Work Privately shows. Someone could still recognise you from your headline and skills, or find you somewhere else.</li>
      </ul>
      <label className="check-row consent"><input type="checkbox" data-testid="discovery-consent" checked={understood}
        onChange={event => setUnderstood(event.target.checked)} />
        <span>I have read this, and my headline and skills do not name my employer or identify me.</span></label>
      {enable.error && <p className="field-error" role="alert">{enable.error.message}</p>}
      <button type="submit" className="button primary full-width" data-testid="discovery-enable" disabled={!understood || busy}>
        {enable.isPending ? "Saving…" : discovery.enabled ? "Confirm again" : "Make me discoverable"}</button>
    </form>}

    {discovery.enabled && <>
      {disable.error && <p className="field-error" role="alert">{disable.error.message}</p>}
      <button type="button" className="button secondary full-width" data-testid="discovery-disable" disabled={busy}
        onClick={() => disable.mutate()}>{disable.isPending ? "Turning off…" : "Turn off and disappear from search"}</button>
    </>}
    {enable.isSuccess && !enable.isPending && !discovery.visible && <p className="account-save-status" role="status"><Check size={16} />Saved. We will review your profile before it appears.</p>}
  </section>;
}
