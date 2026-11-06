import type { Candidate } from "../../../shared/schema.js";

export function csvCell(value: string | number): string {
  const text = String(value);
  const safe = /^[\s]*[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function shortlistCsv(candidates: Candidate[]): string {
  const columns = ["Sample ID", "Role", "Location", "Work arrangement", "Experience years", "Minimum USD annualized", "Maximum USD annualized", "Skills", "Record status"];
  return [
    columns.map(csvCell).join(","),
    ...candidates.map(candidate => [
      candidate.id, candidate.role, candidate.location, candidate.arrangement, candidate.experience,
      candidate.salaryMin, candidate.salaryMax, candidate.skills.join("; "), "Synthetic sample",
    ].map(csvCell).join(",")),
  ].join("\r\n");
}

export function downloadFile(name: string, text: string, type = "text/csv;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
