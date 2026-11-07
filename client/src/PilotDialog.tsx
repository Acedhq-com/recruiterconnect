import { Dialog, PilotForm } from "./App.js";

export default function PilotDialog({ plan, onClose }: { plan: "candidate" | "founding"; onClose: () => void }) {
  return <Dialog title={plan === "candidate" ? "Be part of a more private job search." : "Help shape better recruiting."} onClose={onClose}>
    <PilotForm plan={plan} />
  </Dialog>;
}
