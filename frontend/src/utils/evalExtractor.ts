export interface ExtractedEval {
    mod?: string;
    best?: string;
    worst?: string;
    workload?: string;
    text?: string;
}

/**
 * Parses an evaluation page DOM (such as SUTD Bluera mid-term / end-term surveys)
 * into structured review fields.
 *
 * Why: SUTD evals ask separate questions for highlights, improvements, workload,
 * and instructor feedback. Extracting them into modSUTD's matching review fields
 * spares students from retyping or copying answers across multiple tabs.
 */
export function extractEval(doc: Document, selectionText?: string): ExtractedEval {
    const title = doc.title || "";
    const h1 = doc.querySelector("h1")?.textContent || "";
    const bodyText = doc.body?.textContent || "";

    // Sniff 5-character course codes like 50.040 or 02.105DH.
    const modMatch =
        title.match(/\b\d{2}[.]\d{3}[A-Za-z]?\b/) ||
        h1.match(/\b\d{2}[.]\d{3}[A-Za-z]?\b/) ||
        bodyText.match(/\b\d{2}[.]\d{3}[A-Za-z]?\b/);

    let best = "";
    let worst = "";
    let general = "";
    const instructorFeedback: string[] = [];

    // Query both active textareas and read-only container nodes to support
    // extraction both before submission and when reviewing completed surveys.
    const textareas = doc.querySelectorAll("textarea, .textbox-container");
    for (const el of Array.from(textareas)) {
        const val = ((el as HTMLTextAreaElement).value ?? el.textContent ?? "").trim();
        if (!val) continue;

        const container =
            el.closest("fieldset, .FilloutQuestionDivRowStyle, .row, .question-block, [role='group']") ||
            el.parentElement;
        const heading = (
            container?.querySelector("legend, h1, h2, h3, h4, label, [class*='question' i], [class*='Title' i]")?.textContent || ""
        ).trim();
        const lower = heading.toLowerCase();

        if (lower.includes("like about")) {
            best = val;
        } else if (lower.includes("change about")) {
            worst = val;
        } else if (lower.includes("general comments about the subject")) {
            general = val;
        } else if (lower.includes("general comments about")) {
            // Bluera labels instructor questions as "General comments about [Name]: (Optional)".
            // Stripping boilerplate preserves the instructor name in multi-faculty modules.
            const name = heading
                .replace(/general comments about/i, "")
                .replace(/:\s*\(optional\)/i, "")
                .replace(/[:*]/g, "")
                .trim();
            instructorFeedback.push(name ? `${name}: ${val}` : val);
        }
    }

    let text = general;
    if (instructorFeedback.length > 0) {
        const block = `Instructor feedback:\n${instructorFeedback.join("\n\n")}`;
        text = text ? `${text}\n\n${block}` : block;
    }

    // Fall back to selection or body text only when no survey fields matched.
    if (!text && !best && !worst) {
        const raw = (selectionText || bodyText).slice(0, 4000).trim();
        if (raw) text = raw;
    }

    // Workload question mapping: Bluera asks "The course work load is manageable."
    // Strongly Disagree/Disagree indicates unmanageable workload ("heavier").
    // Neutral/Agree indicates manageable workload ("as-stated").
    // Strongly Agree indicates very light workload ("lighter").
    let workload: string | undefined;
    const radiogroups = doc.querySelectorAll("div[role='radiogroup'], .row");
    for (const row of Array.from(radiogroups)) {
        const labelText = (
            row.querySelector("h4, legend, .FONT_VIEW_QUESTIONTABLE_MEDIUM") || row
        ).textContent || "";

        if (/work\s*load/i.test(labelText)) {
            const checked =
                row.querySelector("input[type='radio']:checked") ||
                row.querySelector(".radioButtonContainer[aria-checked='true']") ||
                row.querySelector("[role='radio'][aria-checked='true']");

            if (checked) {
                const optLabel =
                    checked.getAttribute("aria-label") ||
                    checked.parentElement?.getAttribute("aria-label") ||
                    (checked as HTMLElement).closest?.(".radioButtonContainer")?.getAttribute("aria-label") ||
                    (checked.id ? doc.querySelector(`label[for='${checked.id}']`)?.textContent : "") ||
                    checked.parentElement?.textContent ||
                    "";

                if (/strongly\s*agree/i.test(optLabel)) {
                    workload = "lighter";
                } else if (/strongly\s*disagree|disagree/i.test(optLabel)) {
                    workload = "heavier";
                } else if (/neutral|agree/i.test(optLabel)) {
                    workload = "as-stated";
                }
            }
        }
    }

    return {
        mod: modMatch?.[0],
        best: best || undefined,
        worst: worst || undefined,
        workload,
        text: text || undefined,
    };
}

/**
 * Builds the standalone bookmarklet JavaScript URL.
 *
 * Why: SUTD evals span multiple stages (dashboard with all mods, intro screen with
 * 'Start Now', active survey with textareas, and submitted confirmation). A single
 * bookmarklet click cannot open multiple tabs asynchronously without being killed
 * by browser popup blockers. Instead, it inspects current page state synchronously:
 * - On other domains: guides the user to Bluera.
 * - On multi-mod dashboard: prompts user to open a specific mod first.
 * - On intro screen: prompts user to click Start Now and enter feedback.
 * - On blank survey: prompts user to type answers first.
 * - On completed/active survey with responses: extracts fields and opens modSUTD in 1 tab.
 *
 * Transports extracted answers via URL hash fragment rather than query params
 * to prevent survey answers from ever touching intermediary HTTP request logs.
 */
export function buildEvalBookmarklet(origin: string): string {
    const fn = `(()=>{
const d=document;
const toast=(msg)=>{
  const id='modsutd-eval-toast';
  d.getElementById(id)?.remove();
  const el=d.createElement('div');
  el.id=id;
  el.textContent=msg;
  el.style.cssText='position:fixed;top:24px;left:50%;transform:translateX(-50%);background:#0f172a;color:#f8fafc;padding:12px 20px;border-radius:8px;font:500 14px system-ui,sans-serif;z-index:9999999;box-shadow:0 10px 25px rgba(0,0,0,0.3);border:1px solid #334155;max-width:90vw;text-align:center;cursor:pointer;';
  el.onclick=()=>el.remove();
  d.body.appendChild(el);
  setTimeout(()=>el.remove(),4500);
};
const host=location.hostname||'';
if(host&&!host.includes('bluera.com')&&!host.includes('localhost')&&host!=='127.0.0.1'){
  return toast('Please open the evaluation link from Outlook first. It navigates to SUTD Bluera.');
}
const tas=Array.from(d.querySelectorAll('textarea,.textbox-container'));
const hasStart=Boolean(d.querySelector('input[value*="Start"],button[value*="Start"],.btnStart,input[id*="btnStart"]'));
const isSubmitted=Boolean(d.querySelector('#ctl00_ContentPlaceHolder1_FilloutController_lblFOSavedMsg'))||/(thank you for completing|responses saved|survey submitted)/i.test(d.body?.innerText||d.body?.textContent||'');

if(tas.length===0){
  if(hasStart){
    return toast("Click 'Start Now' and write your review first, then click this bookmarklet.");
  }
  if(isSubmitted){
    return toast('Evaluation already submitted. Click this bookmarklet while filling out your next mod.');
  }
  return toast('Open a specific mod evaluation first, then click this bookmarklet.');
}

const hasAnswers=tas.some(ta=>((ta.value??ta.textContent??'').trim().length>0));
if(!hasAnswers){
  return toast('Please fill in the evaluation first, then click this bookmarklet.');
}
const m=(d.title||'').match(/\\b\\d{2}[.]\\d{3}[A-Za-z]?\\b/)||(d.querySelector('h1')?.innerText||d.querySelector('h1')?.textContent||'').match(/\\b\\d{2}[.]\\d{3}[A-Za-z]?\\b/)||(d.body?.innerText||d.body?.textContent||'').match(/\\b\\d{2}[.]\\d{3}[A-Za-z]?\\b/);
let b='',w='',g='',ins=[];
for(const ta of tas){
  const v=(ta.value??ta.innerText??ta.textContent??'').trim();
  if(!v)continue;
  const c=ta.closest('fieldset,.FilloutQuestionDivRowStyle,.row,.question-block,[role="group"]')||ta.parentElement;
  const hl=c?.querySelector('legend,h1,h2,h3,h4,label,[class*="question" i],[class*="Title" i]');
  const h=((hl?.innerText||hl?.textContent||'')).toLowerCase();
  if(h.includes('like about'))b=v;
  else if(h.includes('change about'))w=v;
  else if(h.includes('general comments about the subject'))g=v;
  else if(h.includes('general comments about')){
    const n=(hl?.innerText||hl?.textContent||'').replace(/general comments about/i,'').replace(/:\\s*\\(optional\\)/i,'').replace(/[:*]/g,'').trim();
    ins.push(n?n+': '+v:v);
  }
}
let t=g;
if(ins.length>0){
  const it='Instructor feedback:\\n'+ins.join('\\n\\n');
  t=t?t+'\\n\\n'+it:it;
}
if(!t&&!b&&!w){
  t=(getSelection().toString()||d.body?.innerText||d.body?.textContent||'').slice(0,4000).trim();
}
let wl='';
for(const r of d.querySelectorAll('div[role="radiogroup"],.row')){
  const rl=r.querySelector('h4,legend,.FONT_VIEW_QUESTIONTABLE_MEDIUM')||r;
  const rt=(rl.innerText||rl.textContent||'');
  if(/work\\s*load/i.test(rt)){
    const k=r.querySelector('input[type="radio"]:checked')||r.querySelector('.radioButtonContainer[aria-checked="true"]')||r.querySelector('[role="radio"][aria-checked="true"]');
    if(k){
      const l=k.getAttribute('aria-label')||k.parentElement?.getAttribute('aria-label')||(k.closest&&k.closest('.radioButtonContainer')?.getAttribute('aria-label'))||(k.id?(d.querySelector('label[for="'+k.id+'"]')?.innerText||d.querySelector('label[for="'+k.id+'"]')?.textContent):'')||k.parentElement?.innerText||k.parentElement?.textContent||'';
      if(/strongly\\s*agree/i.test(l))wl='lighter';
      else if(/strongly\\s*disagree|disagree/i.test(l))wl='heavier';
      else if(/neutral|agree/i.test(l))wl='as-stated';
    }
  }
}
const p=new URLSearchParams();
if(m)p.set('mod',m[0]);
if(b)p.set('best',b);
if(w)p.set('worst',w);
if(wl)p.set('workload',wl);
if(t)p.set('text',t);
open('${origin}/share#'+p.toString(),'_blank');
})()`;

    return `javascript:${fn.replace(/\n\s*/g, '')}`;
}
