// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReviewForm } from "./ReviewForm";
import type { Mod } from "@/types";

const mockMod: Mod = {
    code: "50.040",
    name: "Natural Language Processing",
    description: "NLP course description",
    department: "Computer Science and Design",
    term: "7",
    credits: 12,
    pillar: "CSD",
    schedules: [],
};

describe("ReviewForm prefill and editing", () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it("prioritizes arriving prefill over an older stored draft on initial mount", () => {
        // Pre-populate an older draft in localStorage
        localStorage.setItem(
            "modsutd.review.drafts.v1",
            JSON.stringify({
                [mockMod.code]: {
                    text: "Older Draft Text",
                    vals: { "Best part": "Older Best" },
                },
            }),
        );

        render(
            <ReviewForm
                mod={mockMod}
                prefillText="Fresh Bookmarklet Text"
                prefillVals={{ "Best part": "Fresh Best" }}
            />,
        );

        const bodyArea = screen.getByLabelText("review body") as HTMLTextAreaElement;
        const bestArea = screen.getByLabelText("Best part") as HTMLTextAreaElement;
        expect(bodyArea.value).toBe("Fresh Bookmarklet Text");
        expect(bestArea.value).toBe("Fresh Best");
    });

    it("notifies parent when prefill parameters are consumed on mount", () => {
        let consumed = false;
        render(
            <ReviewForm
                mod={mockMod}
                prefillText="Incoming text"
                onPrefillConsumed={() => {
                    consumed = true;
                }}
            />,
        );

        expect(consumed).toBe(true);
    });

    it("does not revert user edits to prefilled fields when parent re-renders", () => {
        const { rerender } = render(
            <ReviewForm
                mod={mockMod}
                prefillVals={{ "Best part": "Initial Best" }}
            />,
        );

        const textarea = screen.getByLabelText("Best part") as HTMLTextAreaElement;
        expect(textarea.value).toBe("Initial Best");

        // User edits the field
        fireEvent.change(textarea, { target: { value: "User Custom Edit" } });
        expect(textarea.value).toBe("User Custom Edit");

        // Parent re-renders passing a new prefillVals object with the original prefill value
        rerender(
            <ReviewForm
                mod={mockMod}
                prefillVals={{ "Best part": "Initial Best" }}
            />,
        );

        // User edit must be preserved, not overwritten by re-render
        expect(textarea.value).toBe("User Custom Edit");
    });

    it("preserves user edits across unmount and remount after prefill has been consumed", () => {
        let prefill: { text?: string } | undefined = { text: "Initial Text" };
        const { unmount } = render(
            <ReviewForm
                mod={mockMod}
                prefillText={prefill.text}
                onPrefillConsumed={() => {
                    prefill = undefined;
                }}
            />,
        );

        const textarea = screen.getByLabelText("review body") as HTMLTextAreaElement;
        expect(textarea.value).toBe("Initial Text");
        fireEvent.change(textarea, { target: { value: "User Custom Body Text" } });

        // User closes review panel (unmounts)
        unmount();

        // User reopens review panel (remounts without consumed prefill)
        render(<ReviewForm mod={mockMod} prefillText={prefill?.text} />);
        const remounted = screen.getByLabelText("review body") as HTMLTextAreaElement;
        expect(remounted.value).toBe("User Custom Body Text");
    });
});
