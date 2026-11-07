import { PostgrestClient } from "@supabase/postgrest-js";
import { AccountError } from "./account-service.js";
import type { VerifiedSession } from "./account-service.js";
import {
  backgroundSchema, careerStages, jobSnapshotSchema, saveDocumentSchema,
} from "../shared/career-schema.js";
import type {
  CareerBackground, CareerWorkspace, SaveCareerDocument, SaveWorkflow,
} from "../shared/career-schema.js";
import { z } from "zod";

export interface ICareerStorage {
  read(session: VerifiedSession): Promise<CareerWorkspace>;
  saveBackground(session: VerifiedSession, content: CareerBackground, expectedVersion: number): Promise<void>;
  saveWorkflow(session: VerifiedSession, input: SaveWorkflow): Promise<void>;
  saveDocument(session: VerifiedSession, input: SaveCareerDocument): Promise<void>;
  removeDocument(session: VerifiedSession, id: string, expectedVersion: number): Promise<void>;
}
const positiveVersion = z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const backgroundRow = z.object({ user_id: z.uuid(), content: backgroundSchema, version: positiveVersion });
const workflowRow = z.object({
  user_id: z.uuid(), snapshot: jobSnapshotSchema, stage: z.enum(careerStages),
  notes: z.string(), next_action: z.string(), applied_date: z.string().nullable(),
  follow_up_date: z.string().nullable(), version: positiveVersion,
});
const documentRow = z.object({
  user_id: z.uuid(), id: z.uuid(), kind: saveDocumentSchema.shape.kind,
  title: z.string(), body: z.string(), target_role: z.string(),
  target_company: z.string(), source_job_id: z.string().nullable(), version: positiveVersion,
});
export class SupabaseCareerStorage implements ICareerStorage {
  private database(session: VerifiedSession): PostgrestClient {
    return new PostgrestClient(`${process.env.SUPABASE_URL}/rest/v1`, {
      headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY ?? "",
        Authorization: `Bearer ${session.tokens.accessToken}` },
    });
  }
  private check(error: { code?: string } | null) {
    if (!error) return;
    if (error.code === "42501") throw new AccountError(403, "This account cannot access that private workspace.");
    if (error.code === "40001") throw new AccountError(409, "This item changed in another tab. Reload your account before saving again.");
    if (error.code === "22023" || error.code === "22007" || error.code === "22008") {
      throw new AccountError(400, "Check the career workspace fields and try again.");
    }
    if (error.code === "54000") throw new AccountError(429, "This account has reached its pilot storage limit.");
    throw new AccountError(503, "Private workspace storage is temporarily unavailable. Nothing was reported as saved.");
  }
  async read(session: VerifiedSession): Promise<CareerWorkspace> {
    const database = this.database(session);
    const [background, jobs, documents] = await Promise.all([
      database.from("career_backgrounds").select("user_id,content,version").eq("user_id", session.user.id)
        .abortSignal(AbortSignal.timeout(7000)).maybeSingle(),
      database.from("career_workflows").select("user_id,snapshot,stage,notes,next_action,applied_date,follow_up_date,version")
        .eq("user_id", session.user.id).order("updated_at", { ascending: false }).limit(300)
        .abortSignal(AbortSignal.timeout(7000)),
      database.from("career_documents").select("user_id,id,kind,title,body,target_role,target_company,source_job_id,version")
        .eq("user_id", session.user.id).order("updated_at", { ascending: false }).limit(30)
        .abortSignal(AbortSignal.timeout(7000)),
    ]);
    this.check(background.error); this.check(jobs.error); this.check(documents.error);
    const b = background.data ? backgroundRow.parse(background.data) : null;
    const j = z.array(workflowRow).parse(jobs.data ?? []);
    const d = z.array(documentRow).parse(documents.data ?? []);
    if ((b && b.user_id !== session.user.id) || j.some(row => row.user_id !== session.user.id)
      || d.some(row => row.user_id !== session.user.id)) {
      throw new AccountError(503, "Workspace ownership could not be verified.");
    }
    return {
      background: b ? { content: b.content, version: b.version } : null,
      jobs: j.map(row => ({ job: row.snapshot, stage: row.stage, notes: row.notes, nextAction: row.next_action,
        appliedDate: row.applied_date ?? "", followUpDate: row.follow_up_date ?? "", version: row.version })),
      documents: d.map(row => ({ id: row.id, kind: row.kind, title: row.title, body: row.body,
        targetRole: row.target_role, targetCompany: row.target_company, sourceJobId: row.source_job_id, version: row.version })),
    };
  }
  private async rpc(session: VerifiedSession, name: string, input: Record<string, unknown>) {
    const { error } = await this.database(session).rpc(name, input).abortSignal(AbortSignal.timeout(7000));
    this.check(error);
  }
  saveBackground(session: VerifiedSession, content: CareerBackground, expectedVersion: number): Promise<void> {
    return this.rpc(session, "save_my_career_background", { p_content: content, p_expected_version: expectedVersion });
  }
  saveWorkflow(session: VerifiedSession, input: SaveWorkflow): Promise<void> {
    return this.rpc(session, "save_my_career_workflow", {
      p_snapshot: input.job, p_stage: input.stage, p_notes: input.notes, p_next_action: input.nextAction,
      p_applied_date: input.appliedDate || null, p_follow_up_date: input.followUpDate || null,
      p_expected_version: input.expectedVersion,
    });
  }
  saveDocument(session: VerifiedSession, input: SaveCareerDocument): Promise<void> {
    return this.rpc(session, "save_my_career_document", {
      p_id: input.id, p_kind: input.kind, p_title: input.title, p_body: input.body,
      p_target_role: input.targetRole, p_target_company: input.targetCompany,
      p_source_job_id: input.sourceJobId, p_expected_version: input.expectedVersion,
    });
  }
  removeDocument(session: VerifiedSession, id: string, expectedVersion: number): Promise<void> {
    return this.rpc(session, "remove_my_career_document", { p_id: id, p_expected_version: expectedVersion });
  }
}
export const careerStorage = new SupabaseCareerStorage();
