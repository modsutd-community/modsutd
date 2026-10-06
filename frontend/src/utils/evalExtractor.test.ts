import { describe, it, expect, vi } from "vitest";
import { JSDOM } from "jsdom";
import { extractEval, buildEvalBookmarklet } from "./evalExtractor";

describe("extractEval", () => {
    it("extracts course code, best part, worst part, workload, and instructor feedback from Bluera HTML", () => {
        const dom = new JSDOM(`
            <!DOCTYPE html>
            <html>
                <head>
                    <title>2630 Trimester 3 Mid-Trimester for 50.040 : Natural Language Processing CI03</title>
                </head>
                <body>
                    <div role="radiogroup" class="row">
                        <h4><span>The course work load is manageable.</span></h4>
                        <div class="radioButtonContainer" aria-checked="true" aria-label="The course work load is manageable. Disagree">
                            <input type="radio" id="r_disagree" checked />
                            <label for="r_disagree">Disagree</label>
                        </div>
                    </div>

                    <fieldset>
                        <legend><h3>What did you like about the course? (You may mention up to 3 things)</h3></legend>
                        <textarea>Interactive code walkthroughs and clear slides.</textarea>
                    </fieldset>

                    <fieldset>
                        <legend><h3>What would you like to change about this course? (You may mention up to 3 things)</h3></legend>
                        <textarea>More GPU compute quota for project training.</textarea>
                    </fieldset>

                    <fieldset>
                        <legend><h3>General comments about the subject: (Optional)</h3></legend>
                        <textarea>Great breadth of transformer architectures.</textarea>
                    </fieldset>

                    <fieldset>
                        <legend><h3>General comments about Esther Zhao Ruochen: (Optional)</h3></legend>
                        <textarea>Extremely patient during office hours.</textarea>
                    </fieldset>
                </body>
            </html>
        `);

        const result = extractEval(dom.window.document);
        expect(result.mod).toBe("50.040");
        expect(result.best).toBe("Interactive code walkthroughs and clear slides.");
        expect(result.worst).toBe("More GPU compute quota for project training.");
        expect(result.workload).toBe("heavier");
        expect(result.text).toContain("Great breadth of transformer architectures.");
        expect(result.text).toContain("Instructor feedback:\nEsther Zhao Ruochen: Extremely patient during office hours.");
    });

    it("correctly maps workload levels across strongly agree, agree, neutral, disagree, and strongly disagree", () => {
        const createDocWithWorkload = (label: string) => {
            return new JSDOM(`
                <div role="radiogroup" class="row">
                    <h4>The course work load is manageable.</h4>
                    <div class="radioButtonContainer" aria-checked="true" aria-label="${label}">
                        <input type="radio" checked />
                    </div>
                </div>
            `).window.document;
        };

        expect(extractEval(createDocWithWorkload("Strongly Agree")).workload).toBe("lighter");
        expect(extractEval(createDocWithWorkload("Agree")).workload).toBe("as-stated");
        expect(extractEval(createDocWithWorkload("Neutral")).workload).toBe("as-stated");
        expect(extractEval(createDocWithWorkload("Disagree")).workload).toBe("heavier");
        expect(extractEval(createDocWithWorkload("Strongly Disagree")).workload).toBe("heavier");
    });

    it("uses selected text when provided, but never dumps raw page body text as review text", () => {
        const dom = new JSDOM(`
            <html>
                <head><title>Course Review Notes</title></head>
                <body>
                    <p>Reviewing 10.014 Computational Thinking. Fantastic instructor explanations.</p>
                </body>
            </html>
        `);

        const fromSelection = extractEval(dom.window.document, "Great hands-on coding labs.");
        expect(fromSelection.mod).toBe("10.014");
        expect(fromSelection.text).toBe("Great hands-on coding labs.");

        const fromBody = extractEval(dom.window.document);
        expect(fromBody.mod).toBe("10.014");
        expect(fromBody.text).toBeUndefined();
    });

    it("leaves review text fields undefined when not filled out, extracting only mod and workload", () => {
        const dom = new JSDOM(`
            <!DOCTYPE html>
            <html>
                <head>
                    <title>Evaluation for 50.040 NLP</title>
                </head>
                <body>
                    <div role="radiogroup" class="row">
                        <h4>The course work load is manageable.</h4>
                        <div class="radioButtonContainer" aria-checked="true" aria-label="Agree">
                            <input type="radio" checked />
                        </div>
                    </div>
                    <fieldset>
                        <legend>What did you like about the course?</legend>
                        <textarea></textarea>
                    </fieldset>
                    <p>Boilerplate guidelines that must never be dumped as review text.</p>
                </body>
            </html>
        `);

        const result = extractEval(dom.window.document);
        expect(result.mod).toBe("50.040");
        expect(result.workload).toBe("as-stated");
        expect(result.best).toBeUndefined();
        expect(result.worst).toBeUndefined();
        expect(result.text).toBeUndefined();
    });
});

describe("buildEvalBookmarklet", () => {
    it("generates a valid javascript: URL bookmarklet that packs parsed parameters into the hash fragment", () => {
        const bookmarkletUrl = buildEvalBookmarklet("https://modsutd.tech");
        expect(bookmarkletUrl.startsWith("javascript:(()=>{")).toBe(true);
        expect(bookmarkletUrl.endsWith("})()")).toBe(true);
        expect(bookmarkletUrl).toContain("https://modsutd.tech/share#");

        // Execute bookmarklet script in JSDOM context to verify runtime behavior
        const dom = new JSDOM(
            `
            <!DOCTYPE html>
            <html>
                <head><title>Mid-Trimester for 50.040 : NLP</title></head>
                <body>
                    <fieldset>
                        <legend><h3>What did you like about the course?</h3></legend>
                        <textarea id="ta_like">Good pacing</textarea>
                    </fieldset>
                </body>
            </html>
        `,
            { runScripts: "dangerously" },
        );

        // Set value property explicitly for JSDOM
        const ta = dom.window.document.getElementById("ta_like") as HTMLTextAreaElement;
        ta.value = "Good pacing";

        let openedUrl = "";
        dom.window.open = vi.fn((url: string) => {
            openedUrl = url;
            return null;
        }) as unknown as typeof window.open;

        // Strip javascript: prefix and run inside dom.window context
        const code = bookmarkletUrl.replace(/^javascript:/, "");
        dom.window.eval(code);

        expect(openedUrl).toContain("https://modsutd.tech/share#");
        const hash = openedUrl.split("#")[1];
        const params = new URLSearchParams(hash);
        expect(params.get("mod")).toBe("50.040");
        expect(params.get("best")).toBe("Good pacing");
    });

    it("extracts mod and workload when textareas are empty without dumping page text or blocking with error toast", () => {
        const bookmarkletUrl = buildEvalBookmarklet("https://modsutd.tech");
        const dom = new JSDOM(
            `
            <!DOCTYPE html>
            <html>
                <head><title>Evaluation for 50.040</title></head>
                <body>
                    <div role="radiogroup">
                        <h4>The course work load is manageable.</h4>
                        <div class="radioButtonContainer" aria-checked="true" aria-label="Agree">
                            <input type="radio" checked />
                        </div>
                    </div>
                    <textarea id="ta_empty"></textarea>
                    <p>Entire webpage text that must never be dumped as review text</p>
                </body>
            </html>
            `,
            { runScripts: "dangerously" },
        );

        let openedUrl = "";
        dom.window.open = vi.fn((url: string) => {
            openedUrl = url;
            return null;
        }) as unknown as typeof window.open;

        const code = bookmarkletUrl.replace(/^javascript:/, "");
        dom.window.eval(code);

        expect(openedUrl).toContain("https://modsutd.tech/share#");
        const hash = openedUrl.split("#")[1];
        const params = new URLSearchParams(hash);
        expect(params.get("mod")).toBe("50.040");
        expect(params.get("workload")).toBe("as-stated");
        expect(params.get("text")).toBeNull();
        expect(params.get("best")).toBeNull();
        expect(params.get("worst")).toBeNull();
    });

    it("displays an adaptive toast when invoked on an external domain", () => {
        const bookmarkletUrl = buildEvalBookmarklet("https://modsutd.tech");
        const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
            url: "https://wikipedia.org/wiki/SUTD",
            runScripts: "dangerously",
        });

        const code = bookmarkletUrl.replace(/^javascript:/, "");
        dom.window.eval(code);

        const toast = dom.window.document.getElementById("modsutd-eval-toast");
        expect(toast?.textContent).toBe(
            "Please open the evaluation link from Outlook first. It navigates to SUTD Bluera.",
        );
    });

    it("displays an adaptive toast when invoked on the multiple mods dashboard", () => {
        const bookmarkletUrl = buildEvalBookmarklet("https://modsutd.tech");
        const dom = new JSDOM(
            `
            <!DOCTYPE html>
            <html>
                <body>
                    <div class="task-list">
                        <a href="f-eng.aspx?pid=1">50.040 Evaluation</a>
                        <a href="f-eng.aspx?pid=2">02.105 Evaluation</a>
                    </div>
                </body>
            </html>
        `,
            {
                url: "https://my-sutd-bc.bluera.com/a.aspx",
                runScripts: "dangerously",
            },
        );

        const code = bookmarkletUrl.replace(/^javascript:/, "");
        dom.window.eval(code);

        const toast = dom.window.document.getElementById("modsutd-eval-toast");
        expect(toast?.textContent).toBe(
            "Open a specific mod evaluation first, then click this bookmarklet.",
        );
    });

    it("displays an adaptive toast when invoked on the single mod intro screen before starting", () => {
        const bookmarkletUrl = buildEvalBookmarklet("https://modsutd.tech");
        const dom = new JSDOM(
            `
            <!DOCTYPE html>
            <html>
                <body>
                    <h1>50.040 NLP Evaluation</h1>
                    <input type="button" id="btnStart" value="Start Now" />
                </body>
            </html>
        `,
            {
                url: "https://my-sutd-bc.bluera.com/f-eng.aspx",
                runScripts: "dangerously",
            },
        );

        const code = bookmarkletUrl.replace(/^javascript:/, "");
        dom.window.eval(code);

        const toast = dom.window.document.getElementById("modsutd-eval-toast");
        expect(toast?.textContent).toBe(
            "Click 'Start Now' and write your review first, then click this bookmarklet.",
        );
    });

    it("displays an adaptive toast when textareas are present but user has not typed answers yet", () => {
        const bookmarkletUrl = buildEvalBookmarklet("https://modsutd.tech");
        const dom = new JSDOM(
            `
            <!DOCTYPE html>
            <html>
                <body>
                    <textarea id="ta_empty" placeholder="Enter comments here"></textarea>
                </body>
            </html>
        `,
            {
                url: "https://my-sutd-bc.bluera.com/f-eng.aspx",
                runScripts: "dangerously",
            },
        );

        const ta = dom.window.document.getElementById("ta_empty") as HTMLTextAreaElement;
        ta.value = "   ";

        const code = bookmarkletUrl.replace(/^javascript:/, "");
        dom.window.eval(code);

        const toast = dom.window.document.getElementById("modsutd-eval-toast");
        expect(toast?.textContent).toBe(
            "Please fill in the evaluation first, then click this bookmarklet.",
        );
    });

    it("displays an adaptive toast when survey was already submitted", () => {
        const bookmarkletUrl = buildEvalBookmarklet("https://modsutd.tech");
        const dom = new JSDOM(
            `
            <!DOCTYPE html>
            <html>
                <body>
                    <span id="ctl00_ContentPlaceHolder1_FilloutController_lblFOSavedMsg">Responses saved.</span>
                </body>
            </html>
        `,
            {
                url: "https://my-sutd-bc.bluera.com/f-eng.aspx",
                runScripts: "dangerously",
            },
        );

        const code = bookmarkletUrl.replace(/^javascript:/, "");
        dom.window.eval(code);

        const toast = dom.window.document.getElementById("modsutd-eval-toast");
        expect(toast?.textContent).toBe(
            "Evaluation already submitted. Click this bookmarklet while filling out your next mod.",
        );
    });
});
