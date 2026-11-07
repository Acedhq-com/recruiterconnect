import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { PublicAccountSession } from "../../shared/account-schema.js";
import {
  emptyWorkspace, saveBackgroundSchema, saveDocumentSchema, saveWorkflowSchema,
} from "../../shared/career-schema.js";
import type {
  CareerBackground, CareerDocument, CareerJob, CareerWorkflow, CareerWorkspace,
  SaveCareerDocument, SaveWorkflow,
} from "../../shared/career-schema.js";
import { apiRequest, queryClient } from "./lib/queryClient.js";

type CareerStore = {
  session: PublicAccountSession | undefined;
  owner: string;
  workspace: CareerWorkspace;
  canSave: boolean;
  busy: boolean;
  loading: boolean;
  verificationFailed: boolean;
  workspaceLocked: boolean;
  error: string;
  notice: string;
  target: CareerJob | null;
  setTarget: (job: CareerJob | null) => void;
  dismiss: () => void;
  reload: () => void;
  saveBackground: (content: CareerBackground, expectedVersion: number) => Promise<void>;
  saveJob: (input: SaveWorkflow) => Promise<void>;
  saveDocument: (input: SaveCareerDocument) => Promise<void>;
  removeDocument: (document: CareerDocument) => Promise<void>;
};
const Context = createContext<CareerStore | null>(null);
const noWorkspace = emptyWorkspace();
export function useCareer(): CareerStore {
  const value = useContext(Context);
  if (!value) throw new Error("Career workspace is not available.");
  return value;
}
export function CareerProvider({ children }: { children: ReactNode }) {
  const session = useQuery<PublicAccountSession>({
    queryKey: ["/api/auth/session"], gcTime: 0, staleTime: 0, retry: false,
    queryFn: async () => (await apiRequest("GET", "/api/auth/session")).json(),
    refetchOnWindowFocus: true,
  });
  const owner = session.data?.user?.id ?? "guest";
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const canSave = Boolean(session.data?.authEnabled && session.data?.user
    && session.data.account?.account_kind === "candidate" && session.data.account.status === "active");
  const [memory, setMemory] = useState({ owner, workspace: emptyWorkspace() });
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [target, setTarget] = useState<CareerJob | null>(null);
  const cloud = useQuery<CareerWorkspace>({
    queryKey: ["/api/career/workspace", owner], enabled: canSave,
    gcTime: 0, staleTime: 0, retry: false, refetchOnWindowFocus: true,
    queryFn: async () => (await apiRequest("GET", "/api/career/workspace", undefined,
      { "X-Account-Id": owner })).json(),
  });
  useEffect(() => {
    setMemory({ owner, workspace: emptyWorkspace() });
    setTarget(null); setError(""); setNotice("");
    queryClient.removeQueries({ predicate: query =>
      query.queryKey[0] === "/api/career/workspace" && query.queryKey[1] !== owner });
  }, [owner]);
  useEffect(() => {
    if (canSave && cloud.data) setMemory({ owner, workspace: cloud.data });
  }, [canSave, cloud.data, owner]);
  const blocked = owner !== "guest" && session.data?.account?.status !== "active";
  const workspace = memory.owner === owner && !blocked ? memory.workspace : noWorkspace;
  async function perform(url: string, data: unknown, local: (current: CareerWorkspace) => CareerWorkspace) {
    if (pending.current) throw new Error("A workspace change is already in progress. Please wait.");
    pending.current = true;
    const requestOwner = owner;
    setBusy(true); setError(""); setNotice("");
    try {
      if (canSave) {
        const response = await apiRequest("POST", url, data, { "X-Account-Id": requestOwner });
        const updated = await response.json() as CareerWorkspace;
        if (ownerRef.current !== requestOwner) return;
        setMemory({ owner: requestOwner, workspace: updated });
        queryClient.setQueryData(["/api/career/workspace", requestOwner], updated);
        setNotice("Saved to your private account.");
      } else {
        if (blocked) throw new Error("This account cannot edit. Open Account to review its status.");
        const updated = local(workspace);
        setMemory({ owner: requestOwner, workspace: updated });
        setNotice("Kept in this tab only. Export before reloading or signing in.");
      }
    } catch (failure) {
      if (ownerRef.current === requestOwner) setError(failure instanceof Error ? failure.message : "The change could not be saved.");
      throw failure;
    } finally { pending.current = false; setBusy(false); }
  }
  async function saveBackground(content: CareerBackground, expectedVersion: number) {
    const input = saveBackgroundSchema.parse({ content, expectedVersion });
    await perform("/api/career/background", input, current => ({
      ...current, background: { content: input.content, version: expectedVersion + 1 },
    }));
  }
  async function saveJob(input: SaveWorkflow) {
    const value = saveWorkflowSchema.parse(input);
    await perform("/api/career/workflow", value, current => {
      const item: CareerWorkflow = { ...value, version: value.expectedVersion + 1 };
      return { ...current, jobs: [...current.jobs.filter(row => row.job.id !== item.job.id), item] };
    });
  }
  async function saveDocument(input: SaveCareerDocument) {
    const value = saveDocumentSchema.parse(input);
    await perform("/api/career/document", value, current => {
      const document: CareerDocument = { ...value, version: value.expectedVersion + 1 };
      return { ...current, documents: [document, ...current.documents.filter(row => row.id !== document.id)] };
    });
  }
  async function removeDocument(document: CareerDocument) {
    await perform("/api/career/document/remove", { id: document.id, expectedVersion: document.version }, current => ({
      ...current, documents: current.documents.filter(row => row.id !== document.id),
    }));
  }
  return <Context.Provider value={{
    session: session.data, owner, workspace, canSave, busy,
    loading: session.isPending || (canSave && cloud.isPending),
    verificationFailed: owner !== "guest" && session.isError,
    workspaceLocked: blocked,
    error: error || (cloud.error instanceof Error ? cloud.error.message : "")
      || (session.error ? "Account status could not be checked. Private saving is unavailable." : ""),
    notice, target, setTarget,
    dismiss: () => { setNotice(""); setError(""); },
    reload: () => { void cloud.refetch(); void session.refetch(); },
    saveBackground, saveJob, saveDocument, removeDocument,
  }}>{children}</Context.Provider>;
}
