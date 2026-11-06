import { PostgrestClient } from "@supabase/postgrest-js";
import type { InsertPilotLead } from "../shared/schema.js";

export interface IStorage {
  ready(): boolean;
  createPilotLead(input: InsertPilotLead): Promise<void>;
}

export class SupabaseStorage implements IStorage {
  ready(): boolean {
    return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY);
  }
  async createPilotLead(input: InsertPilotLead): Promise<void> {
    if (!this.ready()) throw new Error("INTAKE_UNAVAILABLE");
    const client = new PostgrestClient(`${process.env.SUPABASE_URL!}/rest/v1`, {
      headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY! },
    });
    const { error } = await client.rpc("register_pilot_interest", {
      p_email: input.email, p_name: input.name, p_organization: input.organization,
      p_audience: input.audience, p_plan: input.plan, p_consent: input.consent,
    }).abortSignal(AbortSignal.timeout(7000));
    if (error) throw new Error(error.code === "54000" ? "INTAKE_FULL" : "INTAKE_UNAVAILABLE");
  }
}

export const storage = new SupabaseStorage();
