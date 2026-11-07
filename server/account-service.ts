import { AuthClient } from "@supabase/auth-js";
import { PostgrestClient } from "@supabase/postgrest-js";
import type { User, Session } from "@supabase/auth-js";
import { z } from "zod";
import { MAX_BLOCKS } from "../shared/account-schema.js";
import type { CandidatePrivacy, OnboardAccount, PrivateAccount, PrivateProfile, SavePrivateProfile } from "../shared/account-schema.js";

export class AccountError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export type AccountTokens = { accessToken: string; refreshToken: string; expiresIn: number };
export type VerifiedSession = { user: { id: string; email: string }; tokens: AccountTokens };
export type AccountRecords = { account: PrivateAccount | null; profile: PrivateProfile | null; privacy: CandidatePrivacy | null };
const blockRows = z.array(z.object({
  id: z.uuid(), company_name: z.string().min(2).max(150), source: z.enum(["current_employer", "candidate"]),
}).strict()).max(MAX_BLOCKS);
const employerRow = z.object({ current_employer: z.string().min(2).max(150) }).strict().nullable();
export interface IAccountService {
  enabled(): boolean;
  start(email: string, captchaToken?: string): Promise<void>;
  verify(email: string, code: string): Promise<VerifiedSession>;
  resolve(accessToken?: string, refreshToken?: string): Promise<VerifiedSession | null>;
  logout(accessToken: string): Promise<boolean>;
  records(session: VerifiedSession): Promise<AccountRecords>;
  onboard(session: VerifiedSession, input: OnboardAccount): Promise<void>;
  saveProfile(session: VerifiedSession, input: SavePrivateProfile): Promise<void>;
  saveEmployer(session: VerifiedSession, employer: string): Promise<void>;
  addBlock(session: VerifiedSession, company: string): Promise<void>;
  removeBlock(session: VerifiedSession, id: string): Promise<void>;
  requestDeletion(session: VerifiedSession): Promise<void>;
  cancelDeletion(session: VerifiedSession): Promise<void>;
}

export class SupabaseAccountService implements IAccountService {
  enabled(): boolean {
    return process.env.AUTH_EMAIL_READY === "1"
      && Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY);
  }
  private auth(): InstanceType<typeof AuthClient> {
    return new AuthClient({
      url: `${process.env.SUPABASE_URL}/auth/v1`,
      headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY ?? "" },
      persistSession: false, autoRefreshToken: false, detectSessionInUrl: false,
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(7000) }),
    });
  }
  private database(session: VerifiedSession): PostgrestClient {
    return new PostgrestClient(`${process.env.SUPABASE_URL}/rest/v1`, {
      headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY ?? "",
        Authorization: `Bearer ${session.tokens.accessToken}` },
    });
  }
  private identity(user: User | null): { id: string; email: string } | null {
    if (!user?.email || !user.email_confirmed_at || user.is_anonymous) return null;
    return { id: user.id, email: user.email };
  }
  private verifiedSession(session: Session | null, user: User | null): VerifiedSession {
    const identity = this.identity(user);
    if (!session?.access_token || !session.refresh_token || !identity) {
      throw new AccountError(401, "The code could not be verified. Request a new code and try again.");
    }
    return { user: identity, tokens: { accessToken: session.access_token,
      refreshToken: session.refresh_token, expiresIn: Math.min(session.expires_in, 3600) } };
  }
  async start(email: string, captchaToken?: string): Promise<void> {
    const { error } = await this.auth().signInWithOtp({
      email, options: { shouldCreateUser: true, ...(captchaToken ? { captchaToken } : {}) },
    });
    if (error) throw new AccountError(error.status === 429 ? 429 : 503,
      error.status === 429 ? "Please wait before requesting another code."
        : "Email sign-in is temporarily unavailable. Nothing has been signed in.");
  }
  async verify(email: string, code: string): Promise<VerifiedSession> {
    const { data, error } = await this.auth().verifyOtp({ email, token: code, type: "email" });
    if (error) {
      if ((error.status ?? 0) >= 500 || error.name === "AuthRetryableFetchError") {
        throw new AccountError(503, "Email verification is temporarily unavailable. Please try again.");
      }
      if (error.status === 429) throw new AccountError(429, "Please wait before trying another code.");
      throw new AccountError(401, "The code is invalid or expired. Request a new code and try again.");
    }
    const session = this.verifiedSession(data.session, data.user);
    if (!await this.active(session)) throw new AccountError(401, "The sign-in session is no longer active. Request a new code.");
    return session;
  }
  private async active(session: VerifiedSession): Promise<boolean> {
    const { data, error } = await this.database(session).rpc("account_session_active")
      .abortSignal(AbortSignal.timeout(7000));
    this.check(error);
    return data === true;
  }
  async resolve(accessToken?: string, refreshToken?: string): Promise<VerifiedSession | null> {
    if (!accessToken && !refreshToken) return null;
    const auth = this.auth();
    if (accessToken) {
      const { data, error } = await auth.getUser(accessToken);
      if (error && ((error.status ?? 0) >= 500 || error.name === "AuthRetryableFetchError")) {
        throw new AccountError(503, "Sign-in verification is temporarily unavailable. Your session has not been cleared.");
      }
      const user = !error ? this.identity(data.user) : null;
      if (user && refreshToken) {
        const session = { user, tokens: { accessToken, refreshToken, expiresIn: 3600 } };
        return await this.active(session) ? session : null;
      }
    }
    if (!refreshToken) return null;
    const { data, error } = await auth.refreshSession({ refresh_token: refreshToken });
    if (error && ((error.status ?? 0) >= 500 || error.name === "AuthRetryableFetchError")) {
      throw new AccountError(503, "Session refresh is temporarily unavailable. Please try again.");
    }
    if (error || !data.session || !this.identity(data.user)) return null;
    const session = this.verifiedSession(data.session, data.user);
    return await this.active(session) ? session : null;
  }
  async logout(accessToken: string): Promise<boolean> {
    const { error } = await this.auth().admin.signOut(accessToken, "local");
    return !error;
  }
  async records(session: VerifiedSession): Promise<AccountRecords> {
    const database = this.database(session);
    const result = await database.from("member_accounts")
      .select("user_id,account_kind,display_name,status,deletion_requested_at")
      .eq("user_id", session.user.id).abortSignal(AbortSignal.timeout(7000)).maybeSingle();
    this.check(result.error);
    const account = result.data as PrivateAccount | null;
    let profile: PrivateProfile | null = null;
    if (account?.account_kind === "candidate") {
      const draft = await database.from("account_profiles")
        .select("headline,skills,work_preference,discovery_active,version")
        .eq("user_id", session.user.id).abortSignal(AbortSignal.timeout(7000)).maybeSingle();
      this.check(draft.error);
      profile = draft.data as PrivateProfile | null;
      // The account-only release must never present a profile as discoverable.
      if (profile?.discovery_active) throw new AccountError(503, "Account state needs operator review.");
    }
    let privacy: CandidatePrivacy | null = null;
    if (account?.account_kind === "candidate") {
      const employer = await database.from("candidate_private").select("current_employer")
        .eq("user_id", session.user.id).abortSignal(AbortSignal.timeout(7000)).maybeSingle();
      this.check(employer.error);
      const blocks = await database.from("candidate_blocks").select("id,company_name,source")
        .eq("user_id", session.user.id).order("company_name").abortSignal(AbortSignal.timeout(7000));
      this.check(blocks.error);
      // Fail closed: a malformed row must not be shown as a trustworthy block list.
      const parsedEmployer = employerRow.safeParse(employer.data ?? null);
      const parsedBlocks = blockRows.safeParse(blocks.data ?? []);
      if (!parsedEmployer.success || !parsedBlocks.success) {
        throw new AccountError(503, "Private account storage is temporarily unavailable.");
      }
      privacy = { current_employer: parsedEmployer.data?.current_employer ?? null, blocks: parsedBlocks.data };
    }
    return { account, profile, privacy };
  }
  private check(error: { code?: string } | null): void {
    if (!error) return;
    if (error.code === "42501") throw new AccountError(403, "This account cannot perform that action.");
    if (error.code === "40001") throw new AccountError(409, "Your profile changed in another tab. Reload and try again.");
    if (error.code === "22023") throw new AccountError(400, "Please check the account details and try again.");
    if (error.code === "54000") throw new AccountError(409, `Your block list is full (${MAX_BLOCKS} companies). Remove one before adding another.`);
    throw new AccountError(503, "Private account storage is temporarily unavailable.");
  }
  private async rpc(session: VerifiedSession, name: string, input: Record<string, unknown>): Promise<void> {
    const { error } = await this.database(session).rpc(name, input).abortSignal(AbortSignal.timeout(7000));
    this.check(error);
  }
  onboard(session: VerifiedSession, input: OnboardAccount): Promise<void> {
    return this.rpc(session, "onboard_my_account", { p_kind: input.kind,
      p_display_name: input.displayName, p_beta_ack: input.acknowledgePrivateBeta });
  }
  saveProfile(session: VerifiedSession, input: SavePrivateProfile): Promise<void> {
    return this.rpc(session, "save_my_private_profile", {
      p_display_name: input.displayName, p_headline: input.headline, p_skills: input.skills,
      p_work_preference: input.workPreference, p_expected_version: input.expectedVersion,
    });
  }
  saveEmployer(session: VerifiedSession, employer: string): Promise<void> {
    return this.rpc(session, "save_my_current_employer", { p_employer: employer });
  }
  addBlock(session: VerifiedSession, company: string): Promise<void> {
    return this.rpc(session, "add_my_block", { p_company: company });
  }
  removeBlock(session: VerifiedSession, id: string): Promise<void> {
    return this.rpc(session, "remove_my_block", { p_id: id });
  }
  requestDeletion(session: VerifiedSession): Promise<void> {
    return this.rpc(session, "request_my_account_deletion", {});
  }
  cancelDeletion(session: VerifiedSession): Promise<void> {
    return this.rpc(session, "cancel_my_account_deletion", {});
  }
}
export const accountService = new SupabaseAccountService();
