import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, LockKeyhole, X } from "lucide-react";
import { insertPilotLeadSchema } from "../../shared/schema.js";
import type { InsertPilotLead } from "../../shared/schema.js";
import { apiRequest } from "./lib/queryClient.js";
import "./landing.css";

export type Plan = "candidate" | "founding" | "research";

const copy = {
  candidate: {
    title: "Join the candidate pilot.",
    intro: "Free, and nothing here is public. Share a way to reach you and roughly what you do. Story will email you personally to set up your block list and anonymous profile.",
    organizationLabel: "Current role and city",
    organizationHint: "Example: Audit Senior, Chicago. Don't name your employer here.",
    submit: "Join as a candidate",
    successTitle: "You're on the candidate list.",
    successBody: "Expect a personal email within a few days to set up your block list and anonymous profile. Nothing about you is visible to anyone until that's done and you approve it.",
  },
  founding: {
    title: "Apply to the recruiter pilot.",
    intro: "Pilot seats are limited while every participant is verified by hand. Tell us who you recruit for and we'll follow up to verify your firm before anything is shown to you.",
    organizationLabel: "Firm or company, and the roles you hire for",
    organizationHint: "Example: Smith Search Partners, senior accountants and controllers in Chicago.",
    submit: "Apply to the recruiter pilot",
    successTitle: "Application received.",
    successBody: "Expect a personal email within a few days to verify your firm and walk through how introductions work. Your first two introductions in the pilot are free; pricing is shared during onboarding.",
  },
  research: {
    title: "Request LinkedIn search access.",
    intro: "LinkedIn search runs through a paid data provider, so access is opened by hand for pilot members. Tell us where to reach you and what you're looking for. Use the same email as your Find Work Privately account if you have one.",
    organizationLabel: "Target role and location",
    organizationHint: "Example: Senior accountant, remote or Chicago. Don't name your current employer here.",
    submit: "Request access",
    successTitle: "Request received.",
    successBody: "Story will email you personally within a few days. Once your account is enabled, Private research will show LinkedIn search as available the next time you open it.",
  },
} as const;

export default function PilotDialog({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [success, setSuccess] = useState(false);
  const text = copy[plan];
  useEffect(() => {
    const element = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    const cancel = (event: Event) => { event.preventDefault(); onClose(); };
    element.addEventListener("cancel", cancel);
    return () => { element.removeEventListener("cancel", cancel); element.close(); previous?.focus(); };
  }, [onClose]);
  const status = useQuery<{ intakeReady: boolean }>({ queryKey: ["/api/status"], queryFn: async () => (await apiRequest("GET", "/api/status")).json() });
  const form = useForm<InsertPilotLead>({
    resolver: zodResolver(insertPilotLeadSchema) as never,
    defaultValues: { name: "", email: "", organization: "", audience: plan === "founding" ? "recruiter" : "candidate", plan, consent: false as unknown as true, website: "" },
  });
  const mutation = useMutation({
    mutationFn: async (values: InsertPilotLead) => (await apiRequest("POST", "/api/pilot", values)).json(),
    onSuccess: () => setSuccess(true),
  });
  const errors = form.formState.errors;
  const ready = status.data?.intakeReady === true;
  return <dialog ref={ref} className="landing-dialog" aria-labelledby="landing-dialog-title" data-testid="landing-pilot-dialog"
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <header><h2 id="landing-dialog-title">{text.title}</h2>
      <button type="button" className="landing-dialog-close" aria-label="Close" data-testid="landing-dialog-close" onClick={onClose}><X size={20} /></button></header>
    {success ? <div className="landing-dialog-success" role="status">
      <Check size={30} /><h3>{text.successTitle}</h3><p>{text.successBody}</p>
      <p className="landing-dialog-fine">Your details are used only to contact you about the pilot. Nothing was published and no account was created.</p>
      <button type="button" className="button secondary" data-testid="landing-dialog-done" onClick={onClose}>Done</button>
    </div> : <form onSubmit={form.handleSubmit(values => mutation.mutate(values))} noValidate>
      <p className="landing-dialog-intro">{text.intro}</p>
      <div className="landing-dialog-row">
        <label>Your name<input autoComplete="name" maxLength={100} data-testid="input-pilot-name" aria-invalid={!!errors.name} {...form.register("name")} /></label>
        <label>Email<input type="email" autoComplete="email" maxLength={254} data-testid="input-pilot-email" aria-invalid={!!errors.email} {...form.register("email")} /></label>
      </div>
      <label>{text.organizationLabel}<input maxLength={150} data-testid="input-pilot-company" aria-invalid={!!errors.organization} {...form.register("organization")} />
        <small>{text.organizationHint}</small></label>
      <div className="landing-honeypot" aria-hidden="true"><label>Website<input tabIndex={-1} autoComplete="off" {...form.register("website")} /></label></div>
      <label className="landing-dialog-consent"><input type="checkbox" data-testid="input-pilot-consent" {...form.register("consent")} />
        <span>I agree to be contacted about this pilot. I won't put confidential employer or candidate information in this form.</span></label>
      {Object.keys(errors).length > 0 && <p className="landing-dialog-error" role="alert">
        {errors.consent && !errors.name && !errors.email && !errors.organization ? "Please tick the box agreeing to be contacted." : "Enter your name, a valid email, and the role or firm field, then agree to be contacted."}</p>}
      {mutation.error && <p className="landing-dialog-error" role="alert" data-testid="status-pilot-error">{mutation.error.message}</p>}
      {!status.isPending && !ready && <div className="landing-dialog-notice" data-testid="status-intake-unavailable"><LockKeyhole size={16} />
        <p>Sign-up isn't available right now. Nothing has been submitted. Please try again later.</p></div>}
      <button className="button primary" data-testid="button-submit-pilot" type="submit" disabled={mutation.isPending || status.isPending || !ready}>
        {mutation.isPending ? "Sending…" : status.isPending ? "Checking…" : !ready ? "Sign-up unavailable" : text.submit}{!mutation.isPending && ready && <ArrowRight size={15} />}
      </button>
      <p className="landing-dialog-fine">No card, no billing, no public profile. {plan === "founding" ? "No candidate data is shown before verification." : plan === "research" ? "Nothing from your workspace is sent to the provider." : "Candidates never pay."}</p>
    </form>}
  </dialog>;
}
