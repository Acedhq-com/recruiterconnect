import type { CareerJob } from "../shared/career-schema.js";
export const checked = "2026-11-07T00:00:00.000Z";
export const testJob: CareerJob = {
  id: "ashby-qa-1", role: "Senior Analyst", company: "QA Employer", location: "Remote - US",
  url: "https://jobs.example.com/qa-1", source: "ashby", checkedAt: checked,
  career: "Operations", industry: "Software", region: ["US"], workplace: "Remote",
  workplaceBasis: "Employer field", level: "Senior", levelBasis: "Title signal",
  employment: "Full-time", travelPercent: 10, travelEvidence: "Travel up to 10%",
  interviewSteps: 3, interviewEvidence: "3-step interview process", min: 90000, max: 120000,
  payText: "USD 90,000 to 120,000 / year", currency: "USD", payBasis: "annual", salaryNote: null,
  postedAt: "2026-11-06T00:00:00.000Z", sourceId: "qa", sourceUrl: "https://api.example.com/jobs",
  sourceHome: "https://jobs.example.com/", applyUrl: "https://jobs.example.com/qa-1",
  availability: "employer_listed", availabilityBasis: "Employer feed at check time",
  excerpt: "Work with Excel and operations analysis.", descriptionTruncated: false,
};
