import { backgroundSchema } from "./career-schema.js";
import type { CareerBackground, DocumentKind } from "./career-schema.js";

export type MaterialTarget = { role: string; company: string; excerpt: string };
export type GeneratedMaterial = { title: string; body: string; supportedSkills: string[]; method: "local-facts" };

function supportedSkills(background: CareerBackground, target: MaterialTarget): string[] {
  const text = `${target.role} ${target.excerpt}`.toLocaleLowerCase();
  return background.skills.filter(skill => text.includes(skill.toLocaleLowerCase()));
}
function rankFacts(facts: string[], skills: string[]): string[] {
  const score = (fact: string) => skills.reduce((total, skill) =>
    total + Number(fact.toLocaleLowerCase().includes(skill.toLocaleLowerCase())), 0);
  return facts.map((fact, index) => ({ fact, index, score: score(fact) }))
    .sort((a, b) => b.score - a.score || a.index - b.index).map(item => item.fact);
}
export function generateMaterial(kind: DocumentKind, input: CareerBackground, target: MaterialTarget): GeneratedMaterial {
  const background = backgroundSchema.parse(input);
  if (!background.name || !target.role.trim() || (!background.experience.length && !background.summary.trim())) {
    throw new Error("Add your name, a target role, and at least one experience fact or a professional summary.");
  }
  if (!["resume", "cover_letter", "interview_prep"].includes(kind)) throw new Error("Choose a supported document type.");
  const skills = supportedSkills(background, target);
  const orderedSkills = [...skills, ...background.skills.filter(skill => !skills.includes(skill))];
  const facts = rankFacts(background.experience, skills);
  const contact = [background.location, background.email].filter(Boolean).join(" | ");
  const role = target.role.trim().slice(0, 250);
  const company = target.company.trim().slice(0, 160);
  let body: string;
  if (kind === "resume") {
    body = [
      `# ${background.name}`, contact,
      background.headline, `Target role: ${role}${company ? ` at ${company}` : ""}`,
      background.summary ? `## Professional summary\n${background.summary}` : "",
      orderedSkills.length ? `## Skills\n${orderedSkills.join(" · ")}` : "",
      facts.length ? `## Experience\n${facts.map(fact => `- ${fact}`).join("\n")}` : "",
      background.education.length ? `## Education and certifications\n${background.education.map(fact => `- ${fact}`).join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
  } else if (kind === "cover_letter") {
    body = [
      `# Application for ${role}${company ? ` at ${company}` : ""}`,
      background.name, contact,
      "Dear Hiring Team,",
      `I am applying for the ${role} position${company ? ` at ${company}` : ""}. ${background.summary.trim() || `My professional background: ${background.headline || facts[0]}`}`,
      facts.length ? `Relevant experience from my background:\n\n${facts.slice(0, 3).map(fact => `- ${fact}`).join("\n")}` : "",
      skills.length ? `Skills from my background that also appear in the role information: ${skills.join(", ")}.` : "",
      "I would welcome the opportunity to discuss how my background relates to this role. Thank you for considering my application.",
      `Sincerely,\n${background.name}`,
    ].filter(Boolean).join("\n\n");
  } else {
    body = [
      `# Interview preparation: ${role}${company ? ` at ${company}` : ""}`,
      "Preparation prompts, not claims about the employer's actual interview process.",
      "## Introduce yourself",
      background.summary || background.headline || "Use a concise overview of your actual experience.",
      "## Evidence to prepare",
      facts.length ? facts.slice(0, 5).map(fact => `- ${fact}\n  Prepare the situation, your own action, and the actual result. Do not invent numbers.`).join("\n") : "Use examples you can substantiate.",
      "## Practice questions",
      `- Why are you interested in the ${role} role?`,
      "- Which example best demonstrates your relevant experience?",
      "- What did you personally own, and what did your team own?",
      "- How did you verify the quality of your work?",
      "- Which requirements are new to you, and how would you learn them?",
      "## Questions to ask the employer",
      "- What would success look like in the first three months?",
      "- Which qualifications are essential versus learnable?",
      "- What location, travel, and interview requirements apply to this exact role?",
      skills.length ? `## Text overlap to review\nThese self-reported skills also appear in the supplied role text: ${skills.join(", ")}. This is keyword overlap, not verified proficiency or a hiring probability.` : "",
    ].filter(Boolean).join("\n\n");
  }
  return { title: `${kind === "resume" ? "Resume" : kind === "cover_letter" ? "Cover letter" : "Interview prep"}: ${role}`,
    body, supportedSkills: skills, method: "local-facts" };
}
export function plainMaterial(markdown: string): string {
  return markdown.replace(/^#{1,6}\s+/gm, "");
}
