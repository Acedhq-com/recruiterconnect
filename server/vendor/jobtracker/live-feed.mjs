import {createHash} from "node:crypto";
import {isIP} from "node:net";

// Public, read-only employer boards. There are no API keys or candidate records.
export const FEED_SOURCES = Object.freeze([
  {id:"wikimedia",provider:"greenhouse",board:"wikimedia",company:"Wikimedia Foundation",sector:"Nonprofit",home:"https://wikimediafoundation.org/about/jobs/"},
  {id:"duolingo",provider:"greenhouse",board:"duolingo",company:"Duolingo",sector:"Education",home:"https://careers.duolingo.com/"},
  {id:"gitlab",provider:"greenhouse",board:"gitlab",company:"GitLab",sector:"Software",home:"https://about.gitlab.com/jobs/"},
  {id:"webflow",provider:"greenhouse",board:"webflow",company:"Webflow",sector:"Software",home:"https://webflow.com/careers"},
  {id:"notion",provider:"ashby",board:"notion",company:"Notion",sector:"Software",home:"https://www.notion.com/careers"},
  {id:"ramp",provider:"ashby",board:"ramp",company:"Ramp",sector:"Financial software",home:"https://ramp.com/careers"},
  {id:"ashby",provider:"ashby",board:"Ashby",company:"Ashby",sector:"Recruiting software",home:"https://www.ashbyhq.com/careers"},
  {id:"spotify",provider:"lever",board:"spotify",company:"Spotify",sector:"Music and media",home:"https://jobs.lever.co/spotify"}
]);

export function sourceUrl(source){
  const board=encodeURIComponent(source.board);
  if(source.provider==="greenhouse")return `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`;
  if(source.provider==="ashby")return `https://api.ashbyhq.com/posting-api/job-board/${board}?includeCompensation=true`;
  if(source.provider==="lever")return `https://api.lever.co/v0/postings/${board}?mode=json`;
  throw new Error("Unsupported job-feed provider");
}

const ENTITIES={amp:"&",lt:"<",gt:">",quot:'"',apos:"'",nbsp:" ",ndash:"–",mdash:"—",bull:"•"};
export function plainText(input,max=60000){
  let text=String(input??"").slice(0,300000);
  for(let i=0;i<2;i++)text=text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,(whole,key)=>{
    if(key[0]!=="#")return ENTITIES[key.toLowerCase()]??whole;
    const value=key[1]?.toLowerCase()==="x"?parseInt(key.slice(2),16):parseInt(key.slice(1),10);
    return Number.isInteger(value)&&value>0&&value<=0x10ffff?String.fromCodePoint(value):" ";
  });
  return text.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi," ")
    .replace(/<\/?(?:p|div|li|h[1-6]|br|ul|ol)\b[^>]*>/gi,"\n")
    .replace(/<[^>]*>/g," ").replace(/[ \t]+/g," ").replace(/\n\s*\n/g,"\n").trim().slice(0,max);
}

export function safePostingUrl(value){
  try{
    const input=String(value);
    if(input.length>4096)return null;
    const url=new URL(input);
    if(url.protocol!=="https:"||url.username||url.password||url.port)return null;
    if(isIP(url.hostname.replace(/^\[|\]$/g,""))||!url.hostname.includes(".")||/(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname))return null;
    // The URL is only rendered as an outbound link; it is never fetched by input.
    for(const key of [...url.searchParams.keys()])if(/^utm_|^(?:gh_src|gh_source|trk)$/i.test(key))url.searchParams.delete(key);
    url.hash="";return url.href;
  }catch{return null;}
}

const date=value=>{
  if(value===null||value===undefined||value==="")return null;
  const d=new Date(value);return Number.isFinite(d.getTime())?d.toISOString():null;
};
const numeric=value=>typeof value==="number"&&Number.isFinite(value)&&value>=0?value:null;
const annual=interval=>/^(?:1)?(?:YEAR|YEARLY|ANNUAL|ANNUALLY|PERYEAR)$/.test(String(interval??"").toUpperCase().replace(/[\s_-]/g,""));
const formatAmount=(value,currency)=>{
  if(!currency)return `${value.toLocaleString("en-US")} (currency not provided)`;
  try{return new Intl.NumberFormat("en-US",{style:"currency",currency,maximumFractionDigits:0}).format(value);}
  catch{return `${currency??"Currency not stated"} ${value.toLocaleString("en-US")}`;}
};

export function salaryFacts(raw,provider){
  let components=[];
  if(provider==="ashby"){
    const comp=raw.compensation??{};
    components=[...(comp.summaryComponents??[]),...(comp.compensationTiers??[]).flatMap(t=>t.components??[])]
      .filter(c=>c.compensationType==="Salary")
      .map(c=>({min:numeric(c.minValue),max:numeric(c.maxValue),currency:c.currencyCode??null,interval:c.interval??null}));
  }else if(provider==="lever"&&raw.salaryRange){
    const range=raw.salaryRange;
    components=[{min:numeric(range.min),max:numeric(range.max),currency:range.currency??null,interval:range.interval??null}];
  }
  const invalidRange=components.some(c=>c.min!==null&&c.max!==null&&c.min>c.max);
  components=[...new Map(components.filter(c=>(c.min!==null||c.max!==null)&&!(c.min!==null&&c.max!==null&&c.min>c.max)).map(c=>[JSON.stringify(c),c])).values()];
  const annualUsd=components.filter(c=>c.currency==="USD"&&annual(c.interval));
  const mins=annualUsd.map(c=>c.min).filter(v=>v!==null),maxs=annualUsd.map(c=>c.max).filter(v=>v!==null);
  const summary=components.length?plainText(raw.compensation?.compensationTierSummary??raw.salaryDescriptionPlain??"",350):"";
  let payText=summary||null;
  if(!payText&&components.length){
    const c=components[0];
    payText=`${c.min===null?"Minimum not provided":formatAmount(c.min,c.currency)}${c.max===null?"":` to ${formatAmount(c.max,c.currency)}`} / ${c.interval||"period not provided"}`;
  }
  return {min:mins.length?Math.min(...mins):null,max:maxs.length?Math.max(...maxs):null,payText,
    currency:annualUsd.length?"USD":components[0]?.currency??null,
    payBasis:annualUsd.length?"annual":"not confirmed annual USD",
    salaryNote:invalidRange?"An inconsistent employer pay range was excluded from numeric filters.":annualUsd.length>1?"Across posted pay tiers; the applicable location tier may differ.":null};
}

export function screeningFacts(title,location,text,workplaceType,employment){
  const typed=String(workplaceType??"").toLowerCase().replace(/[\s_-]/g,"");
  let workplace=typed==="remote"?"Remote":typed==="hybrid"?"Hybrid":typed==="onsite"?"On-site":"Not specified";
  let workplaceBasis=workplace!=="Not specified"?"Employer workplace field":"Not provided";
  if(workplace==="Not specified"&&/\bhybrid\b/i.test(location)&&!/\b(?:no|not|non)[-\s]+hybrid\b/i.test(location)){workplace="Hybrid";workplaceBasis="Posted location text";}
  else if(workplace==="Not specified"&&/\bremote\b/i.test(location)&&!/\b(?:no|not|non)[-\s]+remote\b/i.test(location)){workplace="Remote";workplaceBasis="Posted location text";}
  // isRemote is intentionally not used: Ashby sets it for hybrid roles too.
  let level="Not specified";
  if(/\b(?:chief|vp|vice president|head of|director|principal|staff|lead)\b/i.test(title))level="Lead / management";
  else if(/\b(?:senior|sr\.?)\b/i.test(title))level="Senior";
  else if(/\b(?:junior|jr\.?|entry[- ]level|intern|apprentice|new grad)\b/i.test(title))level="Entry-level";
  const employmentMap={fulltime:"Full-time",parttime:"Part-time",contract:"Contract",temporary:"Temporary",intern:"Internship",internship:"Internship"};
  let jobType=employmentMap[String(employment??"").toLowerCase().replace(/[\s_-]/g,"")]??"Not specified";
  if(jobType==="Not specified"&&/\bcontract(?:or)?\b/i.test(title))jobType="Contract";
  let travelPercent=null,travelEvidence=null,interviewSteps=null,interviewEvidence=null;
  const statements=text.split(/[.!?;\n]+/).map(s=>s.replace(/^[-•*]\s*/,"").trim()).filter(Boolean);
  const negated=/\b(?:no|not|never|without|cannot|(?:can|don|doesn|won|wouldn|isn|aren|wasn|weren|haven|hasn|didn|shouldn|mustn)['’]t)\b/i;
  const uncertain=/\b(?:unless|except|however|might|could|at least|minimum|more than|aim|tentative|instead|rather than|for example)\b/i;
  for(const statement of statements){
    // A bare "no travel reimbursement" is a benefit statement, not a 0% travel rule.
    const none=statement.match(/^(?:no (?:business )?travel(?: (?:(?:is|will be) )?required)?|travel (?:is )?not required|(?:this|the) (?:role|position) (?:requires|involves) no (?:business )?travel)(?: for (?:this|the) (?:role|position))?$/i);
    const travel=!negated.test(statement)&&!uncertain.test(statement)&&!/\breimburse\w*/i.test(statement)
      ?statement.match(/\btravel\b[^.\n]{0,55}?\b(?:up to|maximum(?: of)?|at most)\s+(\d{1,3})\s*%/i)
        ??statement.match(/\b(?:up to|at most)\s+(\d{1,3})\s*%[^.\n]{0,30}\btravel\b/i):null;
    if(none&&travelPercent===null){travelPercent=0;travelEvidence=none[0];}
    else if(travel&&Number(travel[1])<=100&&(travelPercent===null||Number(travel[1])>travelPercent)){travelPercent=Number(travel[1]);travelEvidence=travel[0];}
    const interview=!negated.test(statement)&&!uncertain.test(statement)&&!/\b(?:may|can|additional|extra|sometimes|typically|usually|generally|up to|at most)\b/i.test(statement)
      ?statement.match(/^(?:(?:we (?:have|use) )?(?:a|an|our|the) )?(\d{1,2})[- ](?:step|stage|round)\s+(?:interview|hiring)\s+process(?: for this (?:role|position))?$/i)
        ??statement.match(/^(?:(?:our|the|this|your) )?(?:interview|hiring)\s+process (?:consists of|includes|has)\s+(\d{1,2})\s+(?:steps|stages|rounds)(?: in total)?$/i):null;
    if(interview&&Number(interview[1])>0&&Number(interview[1])<15&&(interviewSteps===null||Number(interview[1])>interviewSteps)){interviewSteps=Number(interview[1]);interviewEvidence=interview[0];}
  }
  return {workplace,workplaceBasis,level,levelBasis:level==="Not specified"?"Not provided":"Title-derived signal, not a required-years assessment",employment:jobType,travelPercent,travelEvidence,interviewSteps,interviewEvidence};
}

function regions(raw,provider,location){
  const countries=provider==="ashby"
    ?[raw.address?.postalAddress?.addressCountry,...(raw.secondaryLocations??[]).map(l=>l.address?.addressCountry)]
    :provider==="lever"?[raw.country]:[];
  const aliases={USA:"US",UNITEDSTATES:"US",CAN:"CA",CANADA:"CA",GBR:"GB",UNITEDKINGDOM:"GB",DEU:"DE",GERMANY:"DE",FRA:"FR",FRANCE:"FR",AUS:"AU",AUSTRALIA:"AU"};
  const values=countries.filter(Boolean).map(c=>{const key=String(c).toUpperCase().replace(/\s/g,"");return aliases[key]??key;});
  if(!values.length){
    if(/\b(?:United States|USA|US|U\.S\.)\b/i.test(location))values.push("US");
    if(/\bCanada\b/i.test(location))values.push("CA");
    if(/\b(?:United Kingdom|UK)\b/i.test(location))values.push("GB");
    if(/\bEuropean Union\b/i.test(location))values.push("EU");
  }
  return [...new Set(values)].sort();
}

export function normalizePosting(raw,source,checkedAt){
  if(source.provider==="ashby"&&raw.isListed!==true)return null;
  if(source.provider==="greenhouse"&&raw.internal_job_id===null)return null;
  const role=plainText(raw.title??raw.text,250);
  if(!role||/^(?:general (?:application|interest)|talent (?:pool|community|network)|future opportunities|don't see)/i.test(role))return null;
  const url=safePostingUrl(raw.jobUrl??raw.absolute_url??raw.hostedUrl);
  if(!url)return null;
  const idPart=/^[a-z0-9_-]{1,100}$/i.test(String(raw.id??""))?String(raw.id):createHash("sha256").update(url).digest("hex").slice(0,24);
  const location=plainText(typeof raw.location==="string"?raw.location:raw.location?.name??raw.categories?.location??"Not specified",500);
  const description=plainText([raw.descriptionPlain??raw.content??raw.descriptionHtml??"",raw.additionalPlain??"",
    ...(raw.lists??[]).map(l=>`${l.text??""}\n${l.content??""}`)].join("\n"));
  const facts=screeningFacts(role,location,description,raw.workplaceType,raw.employmentType??raw.categories?.commitment);
  const salary=salaryFacts(raw,source.provider);
  return {
    id:`${source.provider}-${source.id}-${idPart}`,company:plainText(raw.company_name??source.company,160)||source.company,role,
    career:plainText(raw.department??raw.departments?.[0]?.name??raw.categories?.department??raw.categories?.team??"Not specified",160),
    industry:source.sector,industryBasis:"Curated employer-sector grouping",region:regions(raw,source.provider,location),
    location,...facts,...salary,
    postedAt:date(raw.publishedAt??raw.first_published??(source.provider==="lever"?raw.createdAt:null)),
    updatedAt:date(raw.updated_at),source:source.provider,sourceId:source.id,sourceUrl:sourceUrl(source),
    sourceHome:source.home,url,applyUrl:safePostingUrl(raw.applyUrl)??url,checkedAt,
    availability:"employer_listed",availabilityBasis:"Returned by a public employer ATS feed at the check time; not an offer or future-availability guarantee.",
    excerpt:description.slice(0,520),descriptionTruncated:description.length>520,
    requirements:[],resume:null,matchingStatus:"not_run"
  };
}

export function normalizeResponse(data,source,checkedAt){
  const rows=Array.isArray(data)?data:data?.jobs;
  if(!Array.isArray(rows))throw new Error("Upstream response has no jobs array");
  if(rows.length>10000)throw new Error("Upstream job count exceeds safety limit");
  const seen=new Set(),jobs=[];let excluded=0;
  for(const raw of rows){
    let job;
    try{job=normalizePosting(raw,source,checkedAt);}catch{excluded++;continue;}
    if(!job||seen.has(job.url)){excluded++;continue;}
    seen.add(job.url);jobs.push(job);
  }
  return {jobs,reported:rows.length,excluded};
}

async function boundedJson(response,maxBytes=12*1024*1024){
  if(Number(response.headers?.get("content-length"))>maxBytes)throw new Error("Upstream response exceeds safety limit");
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{
    for(;;){
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;
      if(size>maxBytes){await reader.cancel();throw new Error("Upstream response exceeds safety limit");}
      chunks.push(value);
    }
  }finally{reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks,size).toString("utf8"));
}

export function createFeedService({sources=FEED_SOURCES,fetchImpl=fetch,now=()=>Date.now(),ttl=300000,timeout=12000}={}){
  let snapshot=null,inflight=null;
  const prior=new Map();
  async function refresh(){
    const started=now();
    const results=await Promise.all(sources.map(async source=>{
      const attemptedAt=new Date(now()).toISOString();
      try{
        const response=await fetchImpl(sourceUrl(source),{headers:{Accept:"application/json"},signal:AbortSignal.timeout(timeout),redirect:"error"});
        if(!response.ok)throw new Error(`Employer API returned HTTP ${response.status}`);
        const parsed=normalizeResponse(await boundedJson(response),source,attemptedAt);
        prior.set(source.id,{...parsed,checkedAt:attemptedAt});
        return {jobs:parsed.jobs,ledger:{id:source.id,company:source.company,provider:source.provider,url:sourceUrl(source),status:"ok",checkedAt:attemptedAt,attemptedAt,count:parsed.jobs.length,reported:parsed.reported,excluded:parsed.excluded,error:null}};
      }catch(error){
        const old=prior.get(source.id);
        return {jobs:old?old.jobs.map(j=>({...j,availability:"source_recheck_failed"})):[],ledger:{id:source.id,company:source.company,provider:source.provider,url:sourceUrl(source),status:old?"stale":"unavailable",checkedAt:old?.checkedAt??null,attemptedAt,count:old?.jobs.length??null,error:String(error.message).slice(0,180)}};
      }
    }));
    const byUrl=new Map();
    for(const result of results)for(const job of result.jobs)if(!byUrl.has(job.url))byUrl.set(job.url,job);
    const all=[...byUrl.values()].sort((a,b)=>a.company.localeCompare(b.company)||a.role.localeCompare(b.role));
    const ledger=results.map(r=>r.ledger),successful=ledger.filter(s=>s.status==="ok").length;
    const cacheFor=successful?ttl:Math.min(ttl,15000);
    snapshot={jobs:all.slice(0,2500),sources:ledger,checkedAt:new Date(started).toISOString(),expiresAt:new Date(started+cacheFor).toISOString(),
      total:all.length,truncated:all.length>2500,status:successful===sources.length?"complete":successful?"partial":"unavailable",
      coverage:"Only the configured public employer ATS boards; not the entire web.",
      matching:"No personal resume has been assessed in this public feed.",cached:false};
    return snapshot;
  }
  return {
    async get(){
      if(snapshot&&now()<Date.parse(snapshot.expiresAt))return {...snapshot,cached:true};
      if(!inflight)inflight=refresh().finally(()=>{inflight=null;});
      return inflight;
    }
  };
}

export const liveFeed=createFeedService();
