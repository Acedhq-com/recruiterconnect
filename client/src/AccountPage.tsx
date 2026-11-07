import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, LockKeyhole, LogOut, Mail, ShieldCheck, UserRound } from "lucide-react";
import { z } from "zod";
import {
  PUBLIC_APP_ORIGIN, onboardAccountSchema, savePrivateProfileSchema,
  startEmailSchema, verifyEmailSchema,
} from "../../shared/account-schema.js";
import type { DiscoveryStatus, OnboardAccount, PrivateAccount, PrivateProfile, PublicAccountSession } from "../../shared/account-schema.js";
import { apiRequest, queryClient } from "./lib/queryClient.js";
import CandidatePrivacyPanel from "./CandidatePrivacy.js";
import CandidateDiscoveryPanel, { discoveryLabel } from "./CandidateDiscovery.js";
import RecruiterWorkspace from "./RecruiterWorkspace.js";

const sessionKey = ["/api/auth/session"];
const loadSession = async (): Promise<PublicAccountSession> => (await apiRequest("GET", sessionKey[0]!)).json();
const post = async <T,>(path: string, input: unknown, owner?: string): Promise<T> =>
  (await apiRequest("POST", path, input, owner ? { "X-Account-Id": owner } : {})).json();
function ErrorMessage({ error }: { error: Error | null }) {
  return error ? <p className="field-error" role="alert">{error.message}</p> : null;
}

export default function AccountPage() {
  const hostname = window.location.hostname;
  const firstParty = hostname === new URL(PUBLIC_APP_ORIGIN).hostname || ["localhost", "127.0.0.1"].includes(hostname);
  return <section className="secondary-page account-page">
    <p className="eyebrow">YOUR ACCOUNT IS NOT YOUR PUBLIC PROFILE</p>
    <h1>Private by default. Yours to control.</h1>
    <p className="page-description">Account details stay private. Creating a recruiter account does not verify a company or unlock anyone’s information.</p>
    {firstParty ? <FirstPartyAccount /> : <div className="settings-panel account-card">
      <LockKeyhole size={26} /><h2>Open secure account sign-in.</h2>
      <p>Real accounts use first-party, HttpOnly sessions on FindWorkPrivately.com. The embedded preview and old Vercel address do not handle your sign-in code.</p>
      <a href={`${PUBLIC_APP_ORIGIN}/#/account`} target="_blank" rel="noopener noreferrer" className="button primary"
        data-testid="link-canonical-account">Open Find Work Privately <ArrowRight size={16} /></a>
    </div>}
  </section>;
}

function FirstPartyAccount() {
  const [notice, setNotice] = useState("");
  const session = useQuery({ queryKey: sessionKey, queryFn: loadSession, staleTime: 0,
    gcTime: 0, retry: false, refetchOnWindowFocus: true });
  if (session.isPending) return <div className="settings-panel account-card" role="status"><LockKeyhole size={24} /><p>Checking your private session…</p></div>;
  if (session.error || !session.data) return <div className="settings-panel account-card"><h2>Account access is temporarily unavailable.</h2><ErrorMessage error={session.error} /><button className="button secondary" data-testid="button-retry-account" onClick={() => void session.refetch()}>Try again</button></div>;
  const data = session.data;
  const accept = (value: PublicAccountSession) => { if (value.user) setNotice(""); queryClient.setQueryData(sessionKey, value); };
  const acceptSaved = (value: PublicAccountSession) => {
    const current = queryClient.getQueryData<PublicAccountSession>(sessionKey);
    if (current?.user?.id === data.user?.id && value.user?.id === data.user?.id) accept(value);
  };
  return <>{notice && <div className="notice" role="status"><Check size={17} /><span>{notice}</span></div>}
    {!data.user ? <SignInPanel enabled={data.authEnabled} onSignedIn={accept} /> : <div className="account-layout">
      <div>
        {!data.account ? <OnboardingPanel key={data.user.id} email={data.user.email} owner={data.user.id} onSaved={acceptSaved} />
          : <PrivateWorkspace key={data.user.id} data={data} onSaved={acceptSaved} />}
      </div>
      <AccountSafety key={data.user.id} data={data} onSaved={acceptSaved} onSignedOut={(revoked) => {
        accept({ ...data, user: null, account: null, profile: null, privacy: null, recruiter: null, discovery: null });
        setNotice(revoked ? "Signed out of this browser." : "Signed out here. Server-side session revocation could not be confirmed; contact the operator if this persists.");
      }} />
    </div>}
  </>;
}

function SignInPanel({ enabled, onSignedIn }: { enabled: boolean; onSignedIn: (value: PublicAccountSession) => void }) {
  const [email, setEmail] = useState("");
  const startForm = useForm<z.infer<typeof startEmailSchema>>({ resolver: zodResolver(startEmailSchema), defaultValues: { email: "" } });
  const verifyForm = useForm<z.infer<typeof verifyEmailSchema>>({ resolver: zodResolver(verifyEmailSchema) });
  const request = useMutation({
    mutationFn: (input: z.infer<typeof startEmailSchema>) => post<{ accepted: boolean }>("/api/auth/start", input),
    onSuccess: () => { const value = startForm.getValues("email").trim().toLowerCase(); setEmail(value); verifyForm.setValue("email", value); },
  });
  const verify = useMutation({
    mutationFn: (input: z.infer<typeof verifyEmailSchema>) => post<PublicAccountSession>("/api/auth/verify", input),
    onSuccess: onSignedIn,
  });
  return <div className="settings-panel account-card sign-in-card">
    <Mail size={27} /><h2>{email ? "Check your email." : "One email. One secure code."}</h2>
    <p>{email ? `Enter the latest sign-in code sent to ${email}.` : "New and returning users sign in the same way. No password to store, share, or reset."}</p>
    {!enabled && <div className="setup-notice" data-testid="status-account-setup-pending"><LockKeyhole size={19} /><div><strong>Email sign-in is not enabled yet.</strong><p>The sending domain and verification-email service still need setup. Your details are not being collected by this form. The separate pilot-interest form remains available.</p></div></div>}
    {!email ? <form onSubmit={startForm.handleSubmit(input => request.mutate(input))}>
      <label className="field-label" htmlFor="account-email">Your email</label>
      <input id="account-email" data-testid="input-account-email" type="email" autoComplete="email" {...startForm.register("email")} disabled={!enabled} />
      {startForm.formState.errors.email && <p className="field-error" role="alert">Enter a valid email address.</p>}
      <ErrorMessage error={request.error} />
      <button type="submit" className="button primary full-width" data-testid="button-send-account-code" disabled={!enabled || request.isPending}>
        {request.isPending ? "Requesting code…" : enabled ? "Email me a sign-in code" : "Email setup pending"}<ArrowRight size={16} />
      </button>
    </form> : <form onSubmit={verifyForm.handleSubmit(input => verify.mutate(input))}>
      <input type="hidden" {...verifyForm.register("email")} />
      <label className="field-label" htmlFor="account-code">Code from your email</label>
      <input id="account-code" data-testid="input-account-code" inputMode="numeric" autoComplete="one-time-code" maxLength={10} {...verifyForm.register("code")} />
      {verifyForm.formState.errors.code && <p className="field-error" role="alert">Enter the numeric code from your email.</p>}
      <ErrorMessage error={verify.error} />
      <button type="submit" className="button primary full-width" data-testid="button-verify-account-code" disabled={verify.isPending}>
        {verify.isPending ? "Verifying…" : "Verify and continue"}<ArrowRight size={16} />
      </button>
      <button type="button" className="text-button" data-testid="button-change-account-email" onClick={() => { setEmail(""); verifyForm.reset(); verify.reset(); request.reset(); }}>Use another email or request a new code</button>
    </form>}
    <div className="inline-disclosure"><ShieldCheck size={17} /><span>Session tokens stay in secure HttpOnly cookies, not browser storage. Signing in does not make you discoverable or approve recruiter access.</span></div>
  </div>;
}

function OnboardingPanel({ email, owner, onSaved }: { email: string; owner: string; onSaved: (value: PublicAccountSession) => void }) {
  const form = useForm<OnboardAccount>({ resolver: zodResolver(onboardAccountSchema), defaultValues: { kind: "candidate", displayName: "" } });
  const mutation = useMutation({ mutationFn: (input: OnboardAccount) => post<PublicAccountSession>("/api/account/onboard", input, owner), onSuccess: onSaved });
  return <form className="settings-panel account-card" onSubmit={form.handleSubmit(input => mutation.mutate(input))}>
    <UserRound size={26} /><h2>Your email is verified.</h2><p className="account-email">{email}</p>
    <label className="field-label" htmlFor="account-name">Private display name</label>
    <input id="account-name" data-testid="input-account-name" autoComplete="name" {...form.register("displayName")} />
    <fieldset className="account-kind"><legend>How will you use the private beta?</legend>
      <label className="radio-row"><input type="radio" value="candidate" data-testid="account-kind-candidate" {...form.register("kind")} /><span><strong>Candidate</strong><small>Save a private draft. Nobody can find you unless you choose to be found.</small></span></label>
      <label className="radio-row"><input type="radio" value="recruiter" data-testid="account-kind-recruiter" {...form.register("kind")} /><span><strong>Recruiter</strong><small>Apply for verification. You see no candidates until we have checked you.</small></span></label>
    </fieldset>
    <label className="check-row consent"><input type="checkbox" data-testid="account-beta-consent" {...form.register("acknowledgePrivateBeta")} /><span>I understand that this account does not enable candidate visibility, verify a recruiter, or start a paid subscription.</span></label>
    {Object.keys(form.formState.errors).length > 0 && <p className="field-error" role="alert">Add your name, choose a type, and acknowledge the private-beta boundary.</p>}
    <ErrorMessage error={mutation.error} />
    <button type="submit" className="button primary full-width" data-testid="button-create-private-account" disabled={mutation.isPending}>{mutation.isPending ? "Saving…" : "Create my private account"}<ArrowRight size={16} /></button>
  </form>;
}

const profileFormSchema = savePrivateProfileSchema.omit({ skills: true }).extend({
  skillsText: z.string().max(600).refine(value => {
    const items = value.split(",").map(item => item.trim()).filter(Boolean);
    return items.length <= 12 && items.every(item => item.length <= 40 && !/[\u0000-\u001f\u007f]/.test(item));
  }, "Use up to 12 skills, at most 40 characters each."),
});
type ProfileValues = z.infer<typeof profileFormSchema>;
const toProfileValues = (account: PrivateAccount, profile: PrivateProfile): ProfileValues => ({
  displayName: account.display_name, headline: profile.headline,
  skillsText: profile.skills.join(", "), workPreference: profile.work_preference, expectedVersion: profile.version,
});

function PrivateWorkspace({ data, onSaved }: { data: PublicAccountSession; onSaved: (value: PublicAccountSession) => void }) {
  const account = data.account!;
  if (account.status !== "active") return <div className="settings-panel account-card"><LockKeyhole size={26} /><h2>{account.status === "deletion_requested" ? "Your deletion request is recorded." : "This account is paused."}</h2><p>{account.status === "deletion_requested" ? "This is a private request for operator review, not a claim that your records have already been deleted. Editing and discovery are blocked." : "Account changes are unavailable while the operator reviews this account."}</p></div>;
  if (account.account_kind === "recruiter") return <RecruiterWorkspace key={`recruiter-${account.user_id}`} account={account}
    recruiter={data.recruiter} onSaved={onSaved} />;
  if (!data.profile) return <div className="settings-panel account-card"><h2>Your private draft is unavailable.</h2><p>No profile data is being guessed or substituted with a sample. Please reload the account page.</p></div>;
  return <div className="privacy-stack">
    <PrivateProfileForm key={account.user_id} account={account} profile={data.profile} discovery={data.discovery} onSaved={onSaved} />
    {data.privacy && <CandidatePrivacyPanel key={`privacy-${account.user_id}`} account={account}
      privacy={data.privacy} discovery={data.discovery} onSaved={onSaved} />}
    {data.privacy && data.discovery && <CandidateDiscoveryPanel key={`discovery-${account.user_id}`} account={account}
      profile={data.profile} discovery={data.discovery} onSaved={onSaved} />}
  </div>;
}

function PrivateProfileForm({ account, profile, discovery, onSaved }: { account: PrivateAccount; profile: PrivateProfile; discovery: DiscoveryStatus | null; onSaved: (value: PublicAccountSession) => void }) {
  const [saved, setSaved] = useState(false);
  const form = useForm<ProfileValues>({ resolver: zodResolver(profileFormSchema), defaultValues: toProfileValues(account, profile) });
  const mutation = useMutation({
    mutationFn: (input: ProfileValues) => post<PublicAccountSession>("/api/account/profile", {
      displayName: input.displayName, headline: input.headline, skills: input.skillsText.split(",").map(item => item.trim()).filter(Boolean),
      workPreference: input.workPreference, expectedVersion: input.expectedVersion,
    }, account.user_id),
    onSuccess: value => { onSaved(value); if (value.account && value.profile) form.reset(toProfileValues(value.account, value.profile)); setSaved(true); },
    onError: () => { void queryClient.invalidateQueries({ queryKey: sessionKey }); },
  });
  return <form className="settings-panel account-card" onSubmit={form.handleSubmit(input => { setSaved(false); mutation.mutate(input); })}>
    <div className="account-card-title"><div><h2>Your private candidate draft</h2><p>Saved to your account, never to the public sample directory.</p></div><span className="badge" data-testid="profile-visibility"><LockKeyhole size={13} />{discoveryLabel(discovery)}</span></div>
    <label className="field-label" htmlFor="private-name">Private display name</label><input id="private-name" data-testid="input-private-name" autoComplete="name" {...form.register("displayName")} />
    <label className="field-label" htmlFor="private-headline">Professional headline</label><input id="private-headline" data-testid="input-private-headline" placeholder="e.g. Senior accountant" {...form.register("headline")} />
    <label className="field-label" htmlFor="private-skills">Skills, separated by commas</label><input id="private-skills" data-testid="input-private-skills" placeholder="e.g. US GAAP, Excel, Reconciliations" {...form.register("skillsText")} />
    <label className="field-label" htmlFor="private-work">Work preference</label><select id="private-work" data-testid="select-private-work" {...form.register("workPreference")}>{["Remote", "Hybrid", "On-site"].map(item => <option key={item}>{item}</option>)}</select>
    <input type="hidden" {...form.register("expectedVersion", { valueAsNumber: true })} />
    {Object.keys(form.formState.errors).length > 0 && <p className="field-error" role="alert">Check the name, headline, and skills. Use at most 12 skills, with up to 40 characters each.</p>}
    <ErrorMessage error={mutation.error} />
    {mutation.error && <button type="button" className="text-button" data-testid="button-reload-private-profile" onClick={() => { form.reset(toProfileValues(account, profile)); mutation.reset(); }}>Reload the latest saved draft</button>}
    {saved && <p className="account-save-status" role="status"><Check size={16} />Your private draft is saved.</p>}
    <button className="button primary full-width" type="submit" data-testid="button-save-private-profile" disabled={mutation.isPending}>{mutation.isPending ? "Saving…" : "Save private draft"}<Check size={16} /></button>
    <p className="fine-print">Do not put confidential employer or client information in your headline or skills. Saving this draft never makes you discoverable; that is a separate choice further down.</p>
  </form>;
}

function AccountSafety({ data, onSaved, onSignedOut }: { data: PublicAccountSession; onSaved: (value: PublicAccountSession) => void; onSignedOut: (revoked: boolean) => void }) {
  const [confirmation, setConfirmation] = useState("");
  const logout = useMutation({ mutationFn: () => post<{ revocationComplete: boolean }>("/api/auth/logout", {}),
    onSuccess: value => onSignedOut(value.revocationComplete) });
  const deletion = useMutation({ mutationFn: () => post<PublicAccountSession>("/api/account/deletion-request", { confirmation }, data.user!.id), onSuccess: value => { setConfirmation(""); onSaved(value); } });
  const cancel = useMutation({ mutationFn: () => post<PublicAccountSession>("/api/account/cancel-deletion", {}, data.user!.id), onSuccess: onSaved });
  return <aside className="visibility-preview account-safety"><p className="eyebrow">YOUR VERIFIED SIGN-IN</p><h2>Account access only.</h2><p className="account-email">{data.user!.email}</p>
    <div className="identity-lock"><ShieldCheck size={20} /><div><strong>Verified email is not recruiter verification.</strong><p>It never overrides candidate blocks or employer exclusions, grants company membership, or unlocks identity information.</p></div></div>
    <p className="fine-print">Private account data is protected by owner-only database rules. Signing out clears this browser’s cookies and requests revocation of this sign-in session.</p>
    <ErrorMessage error={logout.error} /><button className="button secondary full-width" data-testid="button-account-signout" onClick={() => logout.mutate()} disabled={logout.isPending}><LogOut size={16} />{logout.isPending ? "Signing out…" : "Sign out"}</button>
    {data.account?.status === "active" && <div className="account-delete"><h3>Request account deletion</h3><p>This records a private operator-review request and blocks account editing. It is not an instant deletion claim.</p><label className="field-label" htmlFor="deletion-confirm">Type DELETE to confirm</label><input id="deletion-confirm" data-testid="input-delete-confirm" value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="off" /><ErrorMessage error={deletion.error} /><button className="button secondary full-width" data-testid="button-request-deletion" disabled={confirmation !== "DELETE" || deletion.isPending} onClick={() => deletion.mutate()}>Request deletion review</button></div>}
    {data.account?.status === "deletion_requested" && <><ErrorMessage error={cancel.error} /><button className="button secondary full-width" data-testid="button-cancel-deletion" onClick={() => cancel.mutate()} disabled={cancel.isPending}>Cancel deletion request</button></>}
  </aside>;
}
