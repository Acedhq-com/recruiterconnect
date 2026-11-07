import { lazy, Suspense, useEffect, useState } from "react";
import { Link } from "wouter";
import { ArrowRight, Ban, EyeOff, LockKeyhole, ShieldCheck, UserCheck } from "lucide-react";
import { PUBLIC_BRAND } from "../../shared/account-schema.js";
import "./landing.css";

const PilotDialog = lazy(() => import("./PilotDialog.js"));

type Plan = "candidate" | "founding";

export default function Landing() {
  const [plan, setPlan] = useState<Plan | null>(null);
  useEffect(() => { document.title = `${PUBLIC_BRAND} | Open to recruiters. Invisible to your employer.`; }, []);
  return <div className="landing">
    <a href="#landing-main" className="skip-link" onClick={event => {
      event.preventDefault(); document.getElementById("landing-main")?.focus();
    }}>Skip to content</a>
    <header className="landing-nav">
      <Link href="/" className="landing-brand" data-testid="landing-brand">findwork<span>privately.</span></Link>
      <nav aria-label="Landing navigation">
        <a href="#how-it-works">How it works</a>
        <a href="#recruiters">For recruiters</a>
        <a href="#faq">Privacy</a>
        <Link href="/" data-testid="landing-nav-workspace">Job search workspace</Link>
      </nav>
      <button className="button primary" data-testid="landing-nav-join" onClick={() => setPlan("candidate")}>Join the pilot</button>
    </header>

    <main id="landing-main" tabIndex={-1}>
      <section className="landing-hero">
        <p className="landing-eyebrow">Founding pilot · Chicago accounting &amp; finance</p>
        <h1>Open to recruiters.<br />Invisible to your employer.</h1>
        <p className="landing-lede">Tell recruiters you're ready for a conversation without your current firm ever finding out.
          You decide which companies can't see you. No one learns your name until you approve the introduction.</p>
        <div className="landing-actions">
          <button className="button primary button-stack" data-testid="landing-join-candidate" onClick={() => setPlan("candidate")}>Join as a candidate <small>free, always</small></button>
          <a href="#recruiters" className="button secondary" data-testid="landing-recruiter-link">I'm a recruiter <ArrowRight size={15} /></a>
        </div>
        <p className="landing-fine">No public profile. No "Open to Work" badge. No notification to anyone.</p>
      </section>

      <section className="landing-section landing-problem">
        <p className="landing-eyebrow">Why this exists</p>
        <h2>"Recruiters only" still isn't private enough.</h2>
        <p>LinkedIn's recruiter-only setting hides your status from the one employer on your profile, and LinkedIn itself says
          it can't guarantee complete privacy. It doesn't know about your firm's other offices, its parent company, or the
          clients you audit. People have been called into a partner's office over it.</p>
        <p className="landing-emphasis">A job search shouldn't announce itself.</p>
      </section>

      <section className="landing-section" id="how-it-works">
        <p className="landing-eyebrow">How it works</p>
        <ol className="landing-steps">
          <li><span>1</span><div><h3>Set your boundaries.</h3>
            <p>List the companies that must never see you: your current firm, past firms, clients, anyone. We add known
              affiliates and sister offices. Blocks always win over everything else.</p></div></li>
          <li><span>2</span><div><h3>Stay anonymous.</h3>
            <p>Recruiters see a headline, your target roles, pay range, location and availability. Not your name, not your
              employer, not your photo.</p></div></li>
          <li><span>3</span><div><h3>Approve each introduction.</h3>
            <p>A recruiter sends the role and pay range. You say yes or no. Only a yes reveals your name and contact, and we
              log every reveal.</p></div></li>
        </ol>
        <p className="landing-fine">Pause or delete any time. Free for candidates, always.</p>
      </section>

      <section className="landing-section landing-trust" aria-label="Privacy commitments">
        <div><Ban size={20} /><h3>Blocks beat everything.</h3><p>A blocked company never sees you, no matter how good the match.</p></div>
        <div><UserCheck size={20} /><h3>Verified recruiters only.</h3><p>Every recruiter in the pilot is checked by a person before they can search.</p></div>
        <div><LockKeyhole size={20} /><h3>You hold the reveal.</h3><p>No name, employer or contact leaves without your approval.</p></div>
        <div><EyeOff size={20} /><h3>Nothing is public.</h3><p>No profile page, no badge, no feed, no notifications to your network.</p></div>
      </section>

      <section className="landing-section landing-recruiters" id="recruiters">
        <p className="landing-eyebrow">For recruiters</p>
        <h2>Candidates who actually want to hear from you.</h2>
        <p>Accounting and finance professionals in Chicago who are open to a move but can't be visible on LinkedIn. You see
          anonymous, pre-screened profiles with real pay expectations, request an introduction, and get the name when the
          candidate says yes.</p>
        <ul>
          <li>One niche, verified by hand, no wasted outreach</li>
          <li>Clear pay and availability up front</li>
          <li>Your first two introductions in the pilot are free</li>
        </ul>
        <div className="landing-actions">
          <button className="button primary" data-testid="landing-join-recruiter" onClick={() => setPlan("founding")}>Apply to the recruiter pilot <ArrowRight size={15} /></button>
          <Link href="/recruiters" className="button secondary" data-testid="landing-sample-search">See a sample search</Link>
        </div>
        <p className="landing-fine">Pilot seats are limited while we verify every participant personally. Pricing is shared during onboarding.
          The sample search uses fictional profiles.</p>
      </section>

      <section className="landing-section landing-status">
        <p className="landing-eyebrow">Where we are</p>
        <h2>A founding pilot, not a finished network.</h2>
        <ul>
          <li>Candidate and recruiter accounts are verified by a person, one at a time.</li>
          <li>Introductions are matched and sent by hand while we learn what both sides need.</li>
          <li>The free career workspace (job feeds, application tracker, draft studio) is available to anyone and is never shown to recruiters.</li>
        </ul>
        <p>If you want to be in the first group, join now. If you'd rather wait until it's bigger, that's fine too.</p>
      </section>

      <section className="landing-section landing-faq" id="faq">
        <p className="landing-eyebrow">Questions</p>
        <dl>
          <div><dt>Will my employer know I signed up?</dt><dd>No. There is no public profile, no badge, and nothing is posted or sent to your network. Your employer is on your block list from the start.</dd></div>
          <div><dt>What do recruiters see before I approve?</dt><dd>Headline, target roles, pay range, location preference, availability. Nothing that identifies you.</dd></div>
          <div><dt>What if a recruiter works for a company I blocked?</dt><dd>They can't see you at all. Blocks are checked against the recruiter's firm and every employer they recruit for.</dd></div>
          <div><dt>Does this cost me anything?</dt><dd>No. Candidates never pay. Recruiters pay for access.</dd></div>
          <div><dt>Can I leave?</dt><dd>Yes. Pause hides you instantly. Delete removes your account and profile.</dd></div>
        </dl>
      </section>
    </main>

    <footer className="landing-footer">
      <span><ShieldCheck size={14} /> {PUBLIC_BRAND}</span>
      <nav aria-label="Footer">
        <Link href="/workspace-privacy">Privacy</Link>
        <Link href="/">Job search workspace</Link>
        <Link href="/account">Account</Link>
        <Link href="/recruiters">Recruiter preview</Link>
      </nav>
      <span>Made in Chicago</span>
    </footer>

    {plan && <Suspense fallback={null}><PilotDialog plan={plan} onClose={() => setPlan(null)} /></Suspense>}
  </div>;
}
